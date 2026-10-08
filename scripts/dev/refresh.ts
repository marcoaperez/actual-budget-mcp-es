// npm run dev:refresh [-- --cold]
// Rehace el sandbox (127.0.0.1:5007) con una copia neutralizada del presupuesto real.
// Por defecto usa el último backup nocturno (no para producción). --cold hace una copia en frío:
// para el contenedor de producción unos segundos, así que pide escribir "detener".
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  DEV_PASSWORD, DEV_URL, NEUTRALISE_SQL, SOURCE_KEYS_BACKUP, SOURCE_KEYS_COLD, buildFetch, findBudget,
  missingCopyMessage, missingKeys, parseEnvFile, portHolderIsSandbox, setEnvValue,
} from './sandbox-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH = path.join(ROOT, 'dev', '.env');
const DATA = path.join(ROOT, 'dev', 'data');
const STAGING = path.join(ROOT, 'dev', 'data.new');
const STAGING_DB = path.join(STAGING, 'server-files', 'account.sqlite');
const COMPOSE = ['compose', '-f', path.join(ROOT, 'dev', 'docker-compose.yml')];
const SSH_OPTS = ['-o', 'ConnectTimeout=15'];
const cold = process.argv.includes('--cold');

// Estado para la limpieza en caso de fallo o Ctrl+C.
let coldRecovery: { ssh: string; container: string } | null = null;
let swapped = false; // true cuando dev/data ya es la copia nueva

function cleanup() {
  fs.rmSync(STAGING, { recursive: true, force: true });
  if (coldRecovery) {
    const { ssh, container } = coldRecovery;
    coldRecovery = null;
    try {
      execFileSync('ssh', [...SSH_OPTS, ssh, `docker start ${container}`], { stdio: 'ignore' });
    } catch {}
    console.error(`  Comprueba que ${container} está en marcha en ${ssh}`);
  }
}

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  cleanup();
  console.error(
    swapped
      ? '  Volver a ejecutar npm run dev:refresh es seguro.'
      : '  El sandbox anterior (si lo había) no se ha tocado; volver a ejecutar npm run dev:refresh es seguro.',
  );
  process.exit(1);
};
process.on('SIGINT', () => fail('Interrumpido.'));

const docker = (...args: string[]) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'inherit' });

async function waitInfo() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${DEV_URL}/info`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`El sandbox no responde en ${DEV_URL}. Mira: docker compose -f dev/docker-compose.yml logs`);
}

async function main() {
  if (!fs.existsSync(ENV_PATH)) fail('Falta dev/.env: copia dev/.env.example y rellénalo.');
  let envText = fs.readFileSync(ENV_PATH, 'utf8');
  const env = parseEnvFile(envText);
  const missing = missingKeys(env, cold ? SOURCE_KEYS_COLD : SOURCE_KEYS_BACKUP);
  if (missing.length) fail(`Faltan en dev/.env: ${missing.join(', ')}`);

  const lsof = (() => {
    try {
      // stderr ignorado: lsof puede escribir avisos que no interesan
      return execFileSync('lsof', ['-nP', '-iTCP:5007', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  })();
  // `ps -q` lista solo contenedores EN EJECUCIÓN (sin --all): es lo que necesita portHolderIsSandbox.
  const ours = execFileSync('docker', [...COMPOSE, 'ps', '-q'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (!portHolderIsSandbox(lsof, ours)) fail('El puerto 5007 lo ocupa otra cosa; libéralo antes de seguir.');

  if (cold) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `La copia en frío PARA el contenedor "${env.DEV_SOURCE_CONTAINER}" de producción unos segundos. Escribe "detener" para seguir: `,
    );
    rl.close();
    if (answer.trim() !== 'detener') fail('Cancelado.');
    coldRecovery = { ssh: env.DEV_SOURCE_SSH, container: env.DEV_SOURCE_CONTAINER };
  }

  // Nunca dejar un Sync ID viejo: solo se escribe el nuevo cuando todo ha ido bien.
  envText = setEnvValue(envText, 'ACTUAL_SYNC_ID', '');
  fs.writeFileSync(ENV_PATH, envText);

  // 1) Traer la copia a dev/data.new sin tocar el sandbox actual.
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const f = buildFetch(cold ? 'cold' : 'backup', env);
  console.log(cold ? '→ Copia en frío desde producción…' : '→ Trayendo el último backup nocturno…');
  await new Promise<void>((resolve, reject) => {
    const ssh = spawn('ssh', [...SSH_OPTS, f.ssh, f.remote], { stdio: ['ignore', 'pipe', 'inherit'] });
    const tar = spawn('tar', ['-xzf', '-', '-C', STAGING, `--strip-components=${f.stripComponents}`], { stdio: ['pipe', 'inherit', 'inherit'] });
    tar.stdin.on('error', () => {}); // si tar muere antes, que hable el código de salida
    ssh.stdout.pipe(tar.stdin);
    // Hay que mirar AMBOS códigos de salida: un ssh fallido con tar vacío no debe pasar por bueno.
    const codes: Record<string, number | null> = {};
    const done = (who: string) => (code: number | null) => {
      codes[who] = code;
      if (!('ssh' in codes && 'tar' in codes)) return;
      if (codes.ssh !== 0) reject(new Error(`ssh terminó con ${codes.ssh}`));
      else if (codes.tar !== 0) reject(new Error(`tar terminó con ${codes.tar}`));
      else resolve();
    };
    ssh.on('error', (e) => reject(e));
    tar.on('error', (e) => reject(e));
    ssh.on('exit', done('ssh'));
    tar.on('exit', done('tar'));
  }).catch((e) => fail((e as Error).message));
  coldRecovery = null; // el comando remoto ya reinició el contenedor (ssh terminó con 0)
  if (!fs.existsSync(STAGING_DB)) fail(missingCopyMessage(cold ? 'cold' : 'backup'));

  // 2) Neutralizar y validar el presupuesto ANTES de tocar nada.
  console.log('→ Neutralizando la copia (sin credenciales del banco, contraseña de pruebas)…');
  execFileSync('sqlite3', [STAGING_DB, NEUTRALISE_SQL]);
  const rows = JSON.parse(
    execFileSync('sqlite3', ['-json', STAGING_DB, 'select name, group_id, coalesce(deleted, 0) as deleted from files;'], { encoding: 'utf8' }) || '[]',
  );
  const syncId = (() => {
    try {
      return findBudget(rows, env.DEV_BUDGET_NAME);
    } catch (e) {
      return fail((e as Error).message);
    }
  })();

  // 3) Intercambio: ahora sí se para el sandbox y se sustituye dev/data.
  console.log('→ Parando el sandbox y sustituyendo dev/data…');
  docker('down');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.renameSync(STAGING, DATA);
  swapped = true;

  docker('up', '-d');
  await waitInfo();
  const res = await fetch(`${DEV_URL}/account/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: DEV_PASSWORD }),
  });
  const boot: any = await res.json().catch(() => null);
  if (!res.ok || boot?.status !== 'ok') {
    fail(`No se pudo inicializar el sandbox (HTTP ${res.status}): ${JSON.stringify(boot)}`);
  }

  envText = setEnvValue(envText, 'ACTUAL_SYNC_ID', syncId);
  fs.writeFileSync(ENV_PATH, envText);

  console.log(`✓ Sandbox listo en ${DEV_URL}`);
  console.log(`  Presupuestos en la copia: ${rows.filter((r: any) => !r.deleted).map((r: any) => r.name).join(', ')}`);
  console.log(`  El MCP actual-dev abrirá: ${env.DEV_BUDGET_NAME}`);
  console.log('  Abre Claude Code en este repo: el servidor MCP "actual-dev" apunta solo aquí.');
}

main().catch((e) => fail((e as Error).message));
