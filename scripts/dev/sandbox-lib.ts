// sandbox-lib.ts — lógica pura del sandbox de desarrollo (spec 2026-10-08-dev-sandbox-design).
// refresh.ts y mcp-dev.ts solo orquestan; todo lo que decide algo vive aquí y tiene tests.

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
    remote: `docker stop ${env.DEV_SOURCE_CONTAINER} >/dev/null; sudo tar -czf - -C ${parent} ${base}; docker start ${env.DEV_SOURCE_CONTAINER} >/dev/null`,
    stripComponents: 1,
  };
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
