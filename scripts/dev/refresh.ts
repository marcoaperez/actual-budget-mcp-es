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
  missingKeys, parseEnvFile, portHolderIsSandbox, setEnvValue,
} from './sandbox-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH = path.join(ROOT, 'dev', '.env');
const DATA = path.join(ROOT, 'dev', 'data');
const DB = path.join(DATA, 'server-files', 'account.sqlite');
const COMPOSE = ['compose', '-f', path.join(ROOT, 'dev', 'docker-compose.yml')];
const cold = process.argv.includes('--cold');

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const docker = (...args: string[]) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'inherit' });

async function waitInfo() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${DEV_URL}/info`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`El sandbox no responde en ${DEV_URL}`);
}

async function main() {
  if (!fs.existsSync(ENV_PATH)) fail('Falta dev/.env: copia dev/.env.example y rellénalo.');
  let envText = fs.readFileSync(ENV_PATH, 'utf8');
  const env = parseEnvFile(envText);
  const missing = missingKeys(env, cold ? SOURCE_KEYS_COLD : SOURCE_KEYS_BACKUP);
  if (missing.length) fail(`Faltan en dev/.env: ${missing.join(', ')}`);

  const lsof = (() => {
    try {
      // stderr ignorado: lsof imprime avisos de smbfs en este Mac
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
  }

  console.log('→ Parando el sandbox y vaciando dev/data…');
  docker('down');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const f = buildFetch(cold ? 'cold' : 'backup', env);
  console.log(cold ? '→ Copia en frío desde producción…' : '→ Trayendo el último backup nocturno…');
  await new Promise<void>((resolve, reject) => {
    const ssh = spawn('ssh', [f.ssh, f.remote], { stdio: ['ignore', 'pipe', 'inherit'] });
    const tar = spawn('tar', ['-xzf', '-', '-C', DATA, `--strip-components=${f.stripComponents}`], { stdio: ['pipe', 'inherit', 'inherit'] });
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
  if (!fs.existsSync(DB)) fail('La copia no trae server-files/account.sqlite: revisa DEV_SOURCE_TAR_MEMBER_PREFIX.');

  console.log('→ Neutralizando la copia (sin credenciales del banco, contraseña de pruebas)…');
  execFileSync('sqlite3', [DB, NEUTRALISE_SQL]);

  docker('up', '-d');
  await waitInfo();
  const boot = await (await fetch(`${DEV_URL}/account/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: DEV_PASSWORD }),
  })).json();
  if (boot?.status !== 'ok') fail(`No se pudo inicializar el sandbox: ${JSON.stringify(boot)}`);

  const rows = JSON.parse(
    execFileSync('sqlite3', ['-json', DB, 'select name, group_id, coalesce(deleted, 0) as deleted from files;'], { encoding: 'utf8' }) || '[]',
  );
  const syncId = (() => {
    try {
      return findBudget(rows, env.DEV_BUDGET_NAME);
    } catch (e) {
      return fail((e as Error).message);
    }
  })();
  envText = setEnvValue(envText, 'ACTUAL_SYNC_ID', syncId);
  fs.writeFileSync(ENV_PATH, envText);

  console.log(`✓ Sandbox listo en ${DEV_URL}`);
  console.log(`  Presupuestos en la copia: ${rows.filter((r: any) => !r.deleted).map((r: any) => r.name).join(', ')}`);
  console.log(`  El MCP actual-dev abrirá: ${env.DEV_BUDGET_NAME}`);
  console.log('  Abre Claude Code en este repo: el servidor MCP "actual-dev" apunta solo aquí.');
}

main().catch((e) => fail((e as Error).message));
