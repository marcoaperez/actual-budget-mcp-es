// sandbox-lib.ts — lógica pura del sandbox de desarrollo (spec 2026-10-08-dev-sandbox-design).
// refresh.ts y mcp-dev.ts solo orquestan; todo lo que decide algo vive aquí y tiene tests.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_URL = 'http://localhost:5007';
export const DEV_PORT = 5007;
export const DEV_PASSWORD = 'actual-dev';
export const NEUTRALISE_SQL = 'DELETE FROM secrets; DELETE FROM auth; DELETE FROM sessions;';
export const SOURCE_KEYS_BACKUP = ['DEV_SOURCE_SSH', 'DEV_SOURCE_BACKUP_GLOB', 'DEV_SOURCE_TAR_MEMBER_PREFIX', 'DEV_BUDGET_NAME'] as const;
export const SOURCE_KEYS_COLD = ['DEV_SOURCE_SSH', 'DEV_SOURCE_DATA_DIR', 'DEV_SOURCE_CONTAINER', 'DEV_BUDGET_NAME'] as const;

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim();
  }
  return env;
}

export function setEnvValue(text: string, key: string, value: string): string {
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return `${text.endsWith('\n') || text === '' ? text : `${text}\n`}${key}=${value}\n`;
}

export function missingKeys(env: Record<string, string>, keys: readonly string[]): string[] {
  return keys.filter((k) => !env[k]);
}

const components = (p: string) => p.split('/').filter(Boolean).length;

export function buildFetch(mode: 'backup' | 'cold', env: Record<string, string>) {
  if (mode === 'backup') {
    return {
      ssh: env.DEV_SOURCE_SSH,
      remote: `cat "$(ls -1t ${env.DEV_SOURCE_BACKUP_GLOB} | head -1)"`,
      stripComponents: components(env.DEV_SOURCE_TAR_MEMBER_PREFIX),
    };
  }
  const dir = env.DEV_SOURCE_DATA_DIR.replace(/\/+$/, '');
  const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
  const base = dir.slice(dir.lastIndexOf('/') + 1);
  return {
    ssh: env.DEV_SOURCE_SSH,
    remote: `docker stop ${env.DEV_SOURCE_CONTAINER} >/dev/null && sudo tar -czf - -C ${parent} ${base} ; s=$?; docker start ${env.DEV_SOURCE_CONTAINER} >/dev/null; exit $s`,
    stripComponents: 1,
  };
}

/** Mensaje cuando la copia extraída no trae server-files/account.sqlite; depende del modo. */
export function missingCopyMessage(mode: 'backup' | 'cold'): string {
  return mode === 'backup'
    ? 'La copia no trae server-files/account.sqlite: revisa DEV_SOURCE_TAR_MEMBER_PREFIX (y DEV_SOURCE_BACKUP_GLOB) en dev/.env.'
    : 'La copia no trae server-files/account.sqlite: revisa DEV_SOURCE_DATA_DIR y DEV_SOURCE_CONTAINER en dev/.env, y que sudo funcione sin contraseña en el servidor.';
}

export function findBudget(rows: { name: string; group_id: string; deleted: number }[], name: string): string {
  const live = rows.filter((r) => !r.deleted);
  const hit = live.find((r) => r.name === name);
  if (hit) return hit.group_id;
  throw new Error(`No hay ningún presupuesto "${name}" en la copia. Disponibles: ${live.map((r) => r.name).join(', ')}`);
}

/** lsof -nP -iTCP:5007 -sTCP:LISTEN: vacío = libre; si lo tiene Docker y el contenedor del sandbox existe, es nuestro. */
export function portHolderIsSandbox(lsofOutput: string, sandboxContainerIds: string[]): boolean {
  const holders = lsofOutput.split('\n').slice(1).filter((l) => l.trim());
  if (holders.length === 0) return true;
  return sandboxContainerIds.length > 0 && holders.every((l) => /^com\.docke|^docker|^vpnkit/.test(l));
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entorno del MCP de desarrollo: TODO lo de Actual se fuerza al sandbox. src/index.ts carga
 *  dotenv, pero dotenv nunca pisa variables ya definidas, así que el .env real de la raíz no cuela. */
export function buildDevEnv(devEnvFile: Record<string, string>, processEnv: Record<string, string | undefined>): Record<string, string> {
  const base = Object.fromEntries(Object.entries(processEnv).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return {
    ...base,
    ACTUAL_SERVER_URL: DEV_URL,
    ACTUAL_SERVER_PASSWORD: DEV_PASSWORD,
    ACTUAL_SYNC_ID: devEnvFile.ACTUAL_SYNC_ID ?? '',
    ACTUAL_DATA_DIR: path.join(REPO_ROOT, 'dev', '.cache'),
    ENABLE_WRITE: 'true',
    LOCALE: 'es-ES',
    CURRENCY: 'EUR',
    MESSAGES_LANG: 'es',
  };
}

export async function checkGuard(env: Record<string, string>, fetchInfo: (url: string) => Promise<boolean>): Promise<string | null> {
  if (env.ACTUAL_SERVER_URL !== DEV_URL) {
    return `actual-dev solo puede usar ${DEV_URL} (recibido: ${env.ACTUAL_SERVER_URL}). No arranca.`;
  }
  if (!UUID.test(env.ACTUAL_SYNC_ID ?? '')) {
    return 'Falta el Sync ID del sandbox en dev/.env: ejecuta npm run dev:refresh.';
  }
  if (!(await fetchInfo(`${DEV_URL}/info`))) {
    return `El sandbox no responde en ${DEV_URL}: arráncalo con npm run dev:refresh.`;
  }
  return null;
}

/** Reenvía las señales de terminación al hijo y lo mata si el stdin (canal MCP) se cierra,
 *  para que el hijo haga su cierre ordenado y no quede huérfano. */
export function forwardSignals(
  proc: { on(ev: string, fn: () => void): unknown; stdin: { on(ev: string, fn: () => void): unknown } },
  child: { kill(sig?: NodeJS.Signals): unknown },
): void {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    proc.on(sig, () => child.kill(sig));
  }
  const closed = () => child.kill('SIGTERM');
  proc.stdin.on('end', closed);
  proc.stdin.on('close', closed);
}
