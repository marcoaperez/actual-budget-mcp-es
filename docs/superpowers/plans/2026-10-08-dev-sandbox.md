# Dev Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, disposable Actual server on `127.0.0.1:5007` holding a neutralised copy of the maintainer's real budget, rebuilt with `npm run dev:refresh`, and an `actual-dev` MCP for Claude Code that refuses to talk to anything else.

**Architecture:** `dev/docker-compose.yml` runs the sandbox server. Pure helpers in `scripts/dev/sandbox-lib.ts` (env file, fetch command, neutralisation, budget lookup, guard) are unit-tested; `scripts/dev/refresh.ts` and `scripts/dev/mcp-dev.ts` only orchestrate. `.mcp.json` registers `actual-dev` → `npx tsx scripts/dev/mcp-dev.ts`.

**Tech Stack:** TypeScript run with `tsx`, Vitest, Docker Compose, macOS `sqlite3` CLI, `ssh`/`tar`.

**Spec:** `docs/superpowers/specs/2026-10-08-dev-sandbox-design.md`

## Global Constraints

- Sandbox image `actualbudget/actual-server:26.10.0`, published only on `127.0.0.1:5007:5006`, data in `dev/data/`.
- Dev URL exactly `http://localhost:5007`; dev password `actual-dev`; dev MCP cache `dev/.cache`; `ENABLE_WRITE=true`, `LOCALE=es-ES`, `CURRENCY=EUR`, `MESSAGES_LANG=es`.
- Neutralisation: `DELETE FROM secrets; DELETE FROM auth; DELETE FROM sessions;` on `dev/data/server-files/account.sqlite`; `files` untouched; then `POST /account/bootstrap {"password":"actual-dev"}`.
- Maintainer-specific values only in git-ignored `dev/.env` (keys: `DEV_SOURCE_SSH`, `DEV_SOURCE_BACKUP_GLOB`, `DEV_SOURCE_TAR_MEMBER_PREFIX`, `DEV_SOURCE_DATA_DIR`, `DEV_SOURCE_CONTAINER`, `DEV_BUDGET_NAME`, `ACTUAL_SYNC_ID`); this repo is public — no hostnames, paths or budget names in committed files.
- `--cold` requires the typed confirmation `detener`.
- `dev/` and `scripts/dev/` must not end up in the `.mcpb` (`scripts/bundle.ts` copies only `dist/` and a fixed file list — do not change that).
- User-facing script output in Spanish.
- Never run anything against the production server except the read-only backup fetch (`ssh … cat`) and, only with `--cold` and the confirmation, the stop/tar/start. Tasks 1–4 must not contact production at all.
- Work on branch `feat/dev-sandbox` from `main`.

## Review Focus

- **The repo root has a `.env` with real credentials** (used by the CLI scripts; `src/index.ts` imports `dotenv/config`) → the dev MCP must still connect only to the sandbox: `mcp-dev.ts` passes every variable explicitly and dotenv never overrides existing variables. Pinned in Task 3 (`buildDevEnv` ignores a hostile `processEnv`) and by the final URL assertion.
- **`dev/.env` missing or incomplete** → `dev:refresh` and `mcp-dev` stop with a Spanish message naming the missing keys, before touching anything. Pinned in Task 2.
- **Budget name not found in the copy** (renamed, typo, deleted budget) → fail listing the available names; deleted budgets (`files.deleted = 1`) are never selected. Pinned in Task 2.
- **Port 5007 busy with something else** → refresh refuses instead of starting a second server or talking to the wrong one. Pinned in Task 4 (pure check on the `lsof`/`docker` output).
- **Sandbox not running when Claude Code starts** → `actual-dev` exits with "arranca el sandbox con npm run dev:refresh" instead of hanging or falling back. Pinned in Task 3.

---

### Task 1: Sandbox server and the neutralisation spike

**Files:**
- Create: `dev/docker-compose.yml`
- Create: `dev/.env.example`
- Modify: `.gitignore` (add `dev/.cache/`; `data/` and `.env` already cover `dev/data/` and `dev/.env`)
- Create: `scripts/dev/spike-neutralise.ts` (throwaway, committed like `scripts/verify/*`)
- Modify: `docs/superpowers/specs/2026-10-08-dev-sandbox-design.md` (add section *Neutralisation results*)

**Interfaces:**
- Produces: the compose file later tasks start/stop with `docker compose -f dev/docker-compose.yml`; the answer to the spec's open question.

- [ ] **Step 1: Branch**

```bash
cd ~/GITs/Actual-MCP && git switch -c feat/dev-sandbox
```

- [ ] **Step 2: Compose file and env example**

`dev/docker-compose.yml`:

```yaml
# Sandbox local con una COPIA del presupuesto real (ver docs/superpowers/specs/2026-10-08-dev-sandbox-design.md).
# Solo escucha en 127.0.0.1. Los datos viven en dev/data/ (ignorado por git) y se rehacen con npm run dev:refresh.
name: actual-dev-sandbox
services:
  actual:
    image: actualbudget/actual-server:26.10.0
    ports:
      - "127.0.0.1:5007:5006"
    volumes:
      - ./data:/data
```

`dev/.env.example`:

```
# Copia a dev/.env y rellena. dev/.env NO se sube a git (este repo es público).
# Origen de la copia
DEV_SOURCE_SSH=            # alias SSH del servidor de producción
DEV_SOURCE_BACKUP_GLOB=    # glob remoto de los .tar.gz nocturnos de la carpeta de datos de Actual
DEV_SOURCE_TAR_MEMBER_PREFIX=  # ruta dentro del tar hasta data/ incluida, p. ej. ruta/a/actual/data/
DEV_SOURCE_DATA_DIR=       # carpeta de datos de Actual en el servidor (solo para --cold)
DEV_SOURCE_CONTAINER=      # nombre del contenedor de Actual en el servidor (solo para --cold)
# Presupuesto que abre el MCP de desarrollo
DEV_BUDGET_NAME=
# Lo escribe npm run dev:refresh
ACTUAL_SYNC_ID=
```

Add `dev/.cache/` to `.gitignore` (new line under `data/`).

- [ ] **Step 3: Write the spike**

`scripts/verify`-style throwaway that uses ONLY synthetic data on the sandbox port: it answers "does clearing `auth`/`sessions` and re-bootstrapping keep the `files` registry and the budget downloadable?".

`scripts/dev/spike-neutralise.ts`:

```ts
// Spike (dev-sandbox spec, open question). THROWAWAY. Synthetic data only, sandbox port only.
//   npx tsx scripts/dev/spike-neutralise.ts
// 1. empty dev/data, start the sandbox, bootstrap password 'original', create a budget with one account
// 2. stop, DELETE FROM secrets/auth/sessions in account.sqlite, start
// 3. bootstrap 'actual-dev'; log in; the budget is listed and downloadable; the account is there
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as api from '@actual-app/api';

const URL = 'http://localhost:5007';
const COMPOSE = ['compose', '-f', 'dev/docker-compose.yml'];
const DATA = path.resolve('dev/data');
const DB = path.join(DATA, 'server-files', 'account.sqlite');

const docker = (...args: string[]) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'inherit' });
async function waitInfo() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${URL}/info`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('sandbox no responde');
}
async function bootstrap(password: string) {
  const r = await fetch(`${URL}/account/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  return r.json();
}

async function run() {
  const result: Record<string, unknown> = {};
  docker('down');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  docker('up', '-d');
  await waitInfo();
  result.firstBootstrap = await bootstrap('original');

  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-neut-1-'));
  await api.init({ dataDir: dir1, serverURL: URL, password: 'original' });
  await api.runImport('SpikeNeutralise', async () => {});
  const acct = await api.createAccount({ name: 'Cuenta spike', offbudget: false }, 12345);
  await api.sync();
  const syncId = (await api.getBudgets()).find((b: any) => b.groupId)?.groupId;
  await api.shutdown();

  docker('stop');
  result.tablesBefore = execFileSync('sqlite3', [DB, 'select count(*) from auth; select count(*) from files;'], { encoding: 'utf8' });
  execFileSync('sqlite3', [DB, 'DELETE FROM secrets; DELETE FROM auth; DELETE FROM sessions;']);
  docker('start');
  await waitInfo();
  result.needsBootstrap = await (await fetch(`${URL}/account/needs-bootstrap`)).json();
  result.secondBootstrap = await bootstrap('actual-dev');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-neut-2-'));
  try {
    await api.init({ dataDir: dir2, serverURL: URL, password: 'actual-dev' });
    result.budgets = (await api.getBudgets()).map((b: any) => ({ name: b.name, groupId: b.groupId }));
    await api.downloadBudget(syncId);
    result.accounts = (await api.getAccounts()).map((a: any) => a.name);
    result.balance = await api.getAccountBalance(acct);
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    try { await api.shutdown(); } catch {}
  }
  docker('down');
  console.log('RESULT=' + JSON.stringify(result, null, 2));
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run the spike**

```bash
npx tsx scripts/dev/spike-neutralise.ts
rm -rf dev/data
```

Expected (success): `secondBootstrap.status === "ok"`, `budgets` lists `SpikeNeutralise`, `accounts` contains `Cuenta spike`, `balance` 12345. Any failure is a finding: record it; do not retry blindly.

- [ ] **Step 5: Record the result in the spec**

Append to the spec, after *Neutralisation*:

```markdown
## Neutralisation results

Run on 2026-10-08 against `actualbudget/actual-server:26.10.0` on the sandbox port with synthetic
data (`scripts/dev/spike-neutralise.ts`):
- after `DELETE FROM secrets/auth/sessions`, `needs-bootstrap` → <value>; bootstrap `actual-dev` → <value>;
- budget listed: <yes/no>; downloadable with the new password: <yes/no>; account and balance intact: <yes/no>.
- Conclusion: <the neutralisation in the spec works as designed | it does not, because …>.
```

(fill the `<…>` with the RESULT values). **If the conclusion is "does not", stop and report BLOCKED**: Tasks 2–5 assume it works.

- [ ] **Step 6: Commit**

```bash
git add dev/docker-compose.yml dev/.env.example .gitignore scripts/dev/spike-neutralise.ts docs/superpowers/specs/2026-10-08-dev-sandbox-design.md
git commit -m "feat(dev): sandbox compose and neutralisation spike"
```

---

### Task 2: Pure helpers

**Files:**
- Create: `scripts/dev/sandbox-lib.ts`
- Test: `scripts/dev/sandbox-lib.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DEV_URL = 'http://localhost:5007';
  export const DEV_PORT = 5007;
  export const DEV_PASSWORD = 'actual-dev';
  export const NEUTRALISE_SQL = 'DELETE FROM secrets; DELETE FROM auth; DELETE FROM sessions;';
  export const SOURCE_KEYS_BACKUP = ['DEV_SOURCE_SSH', 'DEV_SOURCE_BACKUP_GLOB', 'DEV_SOURCE_TAR_MEMBER_PREFIX', 'DEV_BUDGET_NAME'] as const;
  export const SOURCE_KEYS_COLD = ['DEV_SOURCE_SSH', 'DEV_SOURCE_DATA_DIR', 'DEV_SOURCE_CONTAINER', 'DEV_BUDGET_NAME'] as const;
  export function parseEnvFile(text: string): Record<string, string>;
  export function setEnvValue(text: string, key: string, value: string): string;
  export function missingKeys(env: Record<string, string>, keys: readonly string[]): string[];
  export function buildFetch(mode: 'backup' | 'cold', env: Record<string, string>): { ssh: string; remote: string; stripComponents: number };
  export function findBudget(rows: { name: string; group_id: string; deleted: number }[], name: string): string;
  export function portHolderIsSandbox(lsofOutput: string, sandboxContainerIds: string[]): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

`scripts/dev/sandbox-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NEUTRALISE_SQL, SOURCE_KEYS_BACKUP, parseEnvFile, setEnvValue, missingKeys, buildFetch, findBudget,
  portHolderIsSandbox,
} from './sandbox-lib.js';

describe('env file', () => {
  const text = '# comentario\nDEV_SOURCE_SSH=host # alias\nDEV_BUDGET_NAME=Personal\nACTUAL_SYNC_ID=\n';
  it('parses KEY=value, ignores comments and trailing comments, keeps empty values', () => {
    expect(parseEnvFile(text)).toEqual({ DEV_SOURCE_SSH: 'host', DEV_BUDGET_NAME: 'Personal', ACTUAL_SYNC_ID: '' });
  });
  it('setEnvValue replaces an existing key and keeps every other line', () => {
    const out = setEnvValue(text, 'ACTUAL_SYNC_ID', 'abc');
    expect(out).toContain('ACTUAL_SYNC_ID=abc');
    expect(out).toContain('# comentario');
    expect(out).toContain('DEV_SOURCE_SSH=host # alias');
  });
  it('setEnvValue appends a missing key', () => {
    expect(setEnvValue('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
  });
  it('missingKeys lists absent or empty keys', () => {
    expect(missingKeys({ DEV_SOURCE_SSH: 'h', DEV_BUDGET_NAME: '' }, SOURCE_KEYS_BACKUP)).toEqual([
      'DEV_SOURCE_BACKUP_GLOB', 'DEV_SOURCE_TAR_MEMBER_PREFIX', 'DEV_BUDGET_NAME',
    ]);
  });
});

describe('buildFetch', () => {
  const env = {
    DEV_SOURCE_SSH: 'prod', DEV_SOURCE_BACKUP_GLOB: '/backups/*/actual.tar.gz',
    DEV_SOURCE_TAR_MEMBER_PREFIX: 'opt/x/actual/data/', DEV_SOURCE_DATA_DIR: '/opt/x/actual/data',
    DEV_SOURCE_CONTAINER: 'actual', DEV_BUDGET_NAME: 'Personal',
  };
  it('backup: streams the newest file by mtime, read-only, and strips the member prefix', () => {
    const f = buildFetch('backup', env);
    expect(f.ssh).toBe('prod');
    expect(f.remote).toBe('cat "$(ls -1t /backups/*/actual.tar.gz | head -1)"');
    expect(f.stripComponents).toBe(4);
  });
  it('cold: stops the container, tars the data dir, always starts it again', () => {
    const f = buildFetch('cold', env);
    expect(f.remote).toBe('docker stop actual >/dev/null; sudo tar -czf - -C /opt/x/actual data; docker start actual >/dev/null');
    expect(f.stripComponents).toBe(1);
  });
});

describe('findBudget', () => {
  const rows = [
    { name: 'Personal', group_id: 'g-1', deleted: 0 },
    { name: 'Otro', group_id: 'g-2', deleted: 0 },
    { name: 'Viejo', group_id: 'g-3', deleted: 1 },
  ];
  it('returns the group_id of the named budget', () => {
    expect(findBudget(rows, 'Personal')).toBe('g-1');
  });
  it('never selects a deleted budget, and lists the available names', () => {
    expect(() => findBudget(rows, 'Viejo')).toThrow(/Personal.*Otro/);
    expect(() => findBudget(rows, 'Personnal')).toThrow(/Personnal/);
  });
});

describe('portHolderIsSandbox', () => {
  it('free port counts as ok', () => {
    expect(portHolderIsSandbox('', ['abc'])).toBe(true);
  });
  it('held by docker for our container is ok; held by anything else is not', () => {
    const docker = 'COMMAND   PID USER\ncom.docke 123 marco\n';
    expect(portHolderIsSandbox(docker, ['abc'])).toBe(true);
    expect(portHolderIsSandbox(docker, [])).toBe(false);
    expect(portHolderIsSandbox('COMMAND PID USER\nnode 99 marco\n', ['abc'])).toBe(false);
  });
});

describe('NEUTRALISE_SQL on a toy account.sqlite', () => {
  it('empties secrets, auth and sessions and leaves files untouched', () => {
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neut-')), 'account.sqlite');
    execFileSync('sqlite3', [db,
      'CREATE TABLE secrets(name TEXT PRIMARY KEY, value BLOB); CREATE TABLE auth(method TEXT PRIMARY KEY, extra_data TEXT);' +
      'CREATE TABLE sessions(token TEXT PRIMARY KEY); CREATE TABLE files(id TEXT PRIMARY KEY, group_id TEXT, deleted BOOLEAN, name TEXT);' +
      "INSERT INTO secrets VALUES('gocardless_secretId','x'); INSERT INTO auth VALUES('password','hash');" +
      "INSERT INTO sessions VALUES('t'); INSERT INTO files VALUES('f','g',0,'Personal');"]);
    execFileSync('sqlite3', [db, NEUTRALISE_SQL]);
    const counts = execFileSync('sqlite3', [db, 'select (select count(*) from secrets),(select count(*) from auth),(select count(*) from sessions),(select count(*) from files);'], { encoding: 'utf8' }).trim();
    expect(counts).toBe('0|0|0|1');
  });
});

describe('.gitignore', () => {
  it('keeps the copy, the cache and dev/.env out of git', () => {
    for (const p of ['dev/data/server-files/account.sqlite', 'dev/.cache/x', 'dev/.env']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', p])).not.toThrow();
    }
    expect(() => execFileSync('git', ['check-ignore', '-q', 'dev/.env.example'])).toThrow();
  });
});
```

- [ ] **Step 2: Make Vitest pick these tests up**

`vitest.config.ts` includes `tests/**/*.test.ts` and `scripts/**/*.test.ts` already (check; if `scripts/**` is not included, add it without touching the integration exclusion).

Run: `npx vitest run scripts/dev/sandbox-lib.test.ts`
Expected: FAIL — `sandbox-lib.js` not found.

- [ ] **Step 3: Implement `scripts/dev/sandbox-lib.ts`**

```ts
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
    env[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run scripts/dev/sandbox-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, commit**

```bash
npm run build && npm test
git add scripts/dev/sandbox-lib.ts scripts/dev/sandbox-lib.test.ts vitest.config.ts
git commit -m "feat(dev): pure helpers for the sandbox (env, fetch, neutralise, budget, port)"
```

---

### Task 3: `actual-dev` MCP launcher with the guard, and `.mcp.json`

**Files:**
- Modify: `scripts/dev/sandbox-lib.ts` (add `buildDevEnv`, `checkGuard`)
- Create: `scripts/dev/mcp-dev.ts`
- Create: `.mcp.json`
- Test: `scripts/dev/sandbox-lib.test.ts` (new describe blocks)
- Modify: spec section *5. `dev/mcp-dev.sh` — the guard* → rename to `scripts/dev/mcp-dev.ts` and say why (testable TypeScript instead of shell; same checks)

**Interfaces:**
- Consumes: `DEV_URL`, `DEV_PASSWORD`, `parseEnvFile` (Task 2).
- Produces:
  ```ts
  export function buildDevEnv(devEnvFile: Record<string, string>, processEnv: Record<string, string | undefined>): Record<string, string>;
  export async function checkGuard(env: Record<string, string>, fetchInfo: (url: string) => Promise<boolean>): Promise<string | null>; // null = ok, else Spanish reason
  ```

- [ ] **Step 1: Write the failing tests**

Append to `scripts/dev/sandbox-lib.test.ts` (add `buildDevEnv, checkGuard, DEV_URL` to the import):

```ts
describe('buildDevEnv', () => {
  const hostile = {
    PATH: '/usr/bin', HOME: '/Users/x',
    ACTUAL_SERVER_URL: 'https://produccion.example', ACTUAL_SERVER_PASSWORD: 'real', ACTUAL_SYNC_ID: 'real-id',
    ACTUAL_DATA_DIR: '/real/cache', ENABLE_WRITE: 'false',
  };
  it('forces every Actual variable to the sandbox, whatever the parent environment says', () => {
    const env = buildDevEnv({ ACTUAL_SYNC_ID: '11111111-1111-4111-8111-111111111111' }, hostile);
    expect(env).toMatchObject({
      ACTUAL_SERVER_URL: 'http://localhost:5007', ACTUAL_SERVER_PASSWORD: 'actual-dev',
      ACTUAL_SYNC_ID: '11111111-1111-4111-8111-111111111111', ENABLE_WRITE: 'true',
      LOCALE: 'es-ES', CURRENCY: 'EUR', MESSAGES_LANG: 'es',
    });
    expect(env.ACTUAL_DATA_DIR).toMatch(/dev\/\.cache$/);
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('checkGuard', () => {
  const ok = { ACTUAL_SERVER_URL: DEV_URL, ACTUAL_SYNC_ID: '11111111-1111-4111-8111-111111111111' };
  const up = async () => true;
  it('accepts the sandbox URL with a valid Sync ID and a live server', async () => {
    expect(await checkGuard(ok, up)).toBeNull();
  });
  it.each(['http://localhost:5006', 'http://127.0.0.1:5007', 'https://localhost:5007', 'https://produccion.example', 'http://localhost:5007/'])(
    'rejects %s', async (url) => {
      expect(await checkGuard({ ...ok, ACTUAL_SERVER_URL: url }, up)).toMatch(/5007/);
    },
  );
  it('rejects a missing or non-UUID Sync ID', async () => {
    expect(await checkGuard({ ...ok, ACTUAL_SYNC_ID: '' }, up)).toMatch(/dev:refresh/);
    expect(await checkGuard({ ...ok, ACTUAL_SYNC_ID: 'nope' }, up)).toMatch(/dev:refresh/);
  });
  it('rejects when the sandbox is not running', async () => {
    expect(await checkGuard(ok, async () => false)).toMatch(/npm run dev:refresh/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run scripts/dev/sandbox-lib.test.ts`
Expected: FAIL — `buildDevEnv`/`checkGuard` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/dev/sandbox-lib.ts`:

```ts
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
```

Create `scripts/dev/mcp-dev.ts`:

```ts
// Lanzador del MCP de desarrollo para Claude Code (.mcp.json → actual-dev).
// Se niega a arrancar si no va a hablar con el sandbox local. stdout es el canal MCP:
// los mensajes de error van SOLO a stderr.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDevEnv, checkGuard, parseEnvFile } from './sandbox-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const devEnvPath = path.join(ROOT, 'dev', '.env');
const devEnvFile = fs.existsSync(devEnvPath) ? parseEnvFile(fs.readFileSync(devEnvPath, 'utf8')) : {};
const env = buildDevEnv(devEnvFile, process.env);

const reason = await checkGuard(env, async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
});
if (reason) {
  console.error(`[actual-dev] ${reason}`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'index.ts')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
```

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "actual-dev": {
      "command": "npx",
      "args": ["tsx", "scripts/dev/mcp-dev.ts"]
    }
  }
}
```

Check that `node_modules/tsx/dist/cli.mjs` exists (`ls`); if tsx's entry has another name, use the path of `node_modules/.bin/tsx`'s target instead and say so in the report.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run scripts/dev/sandbox-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Smoke-test the guard without a sandbox**

Run (sandbox NOT running): `npx tsx scripts/dev/mcp-dev.ts < /dev/null; echo "exit=$?"`
Expected: stderr `[actual-dev] Falta el Sync ID…` or `…no responde…`, `exit=1`, nothing on stdout.

- [ ] **Step 6: Update the spec section 5** (rename to `scripts/dev/mcp-dev.ts`; one sentence: TypeScript instead of shell so the guard is unit-tested; `.mcp.json` runs `npx tsx scripts/dev/mcp-dev.ts`).

- [ ] **Step 7: Full suite, commit**

```bash
npm run build && npm test
git add scripts/dev/sandbox-lib.ts scripts/dev/sandbox-lib.test.ts scripts/dev/mcp-dev.ts .mcp.json docs/superpowers/specs/2026-10-08-dev-sandbox-design.md
git commit -m "feat(dev): actual-dev MCP launcher that only talks to the sandbox"
```

---

### Task 4: `npm run dev:refresh`

**Files:**
- Create: `scripts/dev/refresh.ts`
- Modify: `package.json` (`"dev:refresh": "tsx scripts/dev/refresh.ts"`)

**Interfaces:**
- Consumes: everything in `scripts/dev/sandbox-lib.ts`.
- Produces: the command the maintainer runs.

- [ ] **Step 1: Implement `scripts/dev/refresh.ts`**

```ts
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
      return execFileSync('lsof', ['-nP', '-iTCP:5007', '-sTCP:LISTEN'], { encoding: 'utf8' });
    } catch {
      return '';
    }
  })();
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
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar terminó con ${code}`))));
    ssh.on('exit', (code) => code !== 0 && reject(new Error(`ssh terminó con ${code}`)));
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
```

Add to `package.json` `scripts`: `"dev:refresh": "tsx scripts/dev/refresh.ts"`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --skipLibCheck --ignoreConfig --module nodenext --moduleResolution nodenext --target es2022 --types node scripts/dev/refresh.ts scripts/dev/mcp-dev.ts`
Expected: clean.

- [ ] **Step 3: Check the failure paths without production**

- With no `dev/.env`: `npm run dev:refresh` → `✗ Falta dev/.env…`, exit 1.
- With `dev/.env` copied from `.env.example` (empty values): `✗ Faltan en dev/.env: DEV_SOURCE_SSH, …`, exit 1. Delete that `dev/.env` afterwards.
Do NOT run a real refresh: it contacts production (that is the maintainer's acceptance in Task 5).

- [ ] **Step 4: Commit**

```bash
npm test
git add scripts/dev/refresh.ts package.json
git commit -m "feat(dev): npm run dev:refresh rebuilds the sandbox from a neutralised copy"
```

---

### Task 5: Docs and hand-off

**Files:**
- Modify: `README.md` and `README.es.md` (new subsection in the developer part, after "Tests and smoke" / "Tests y smoke")
- Modify: `CLAUDE.md` ("Estado y próximos pasos": one line)

- [ ] **Step 1: README section** (English; Spanish equivalent in `README.es.md`)

```markdown
### Development sandbox (a copy of your own budget)

For trying the MCP against your real data without touching your server:

1. `cp dev/.env.example dev/.env` and fill in where the copy comes from (an SSH alias and the path
   of your nightly backups of Actual's data dir) and the budget name. `dev/.env` is git-ignored.
2. `npm run dev:refresh` — rebuilds a local Actual on `127.0.0.1:5007` from the newest backup, with
   bank-sync credentials removed and the password set to `actual-dev`. `-- --cold` takes a fresh
   copy instead (stops your server for a few seconds; asks you to type `detener`).
3. Open Claude Code in this repo: the `actual-dev` MCP server (from `.mcp.json`) runs the code in
   `src/` with writes enabled, and refuses to start unless it points at the sandbox.
4. Broke something? `npm run dev:refresh` again.
```

- [ ] **Step 2: CLAUDE.md line**

```markdown
- **Sandbox de desarrollo (2026-10-08)**: `npm run dev:refresh` + MCP `actual-dev` en Claude Code (solo `localhost:5007`). Spec `docs/superpowers/specs/2026-10-08-dev-sandbox-design.md`.
```

- [ ] **Step 3: Run everything and commit**

```bash
npm run build && npm test && npm run bundle
unzip -l build/actual-budget-mcp-es.mcpb | grep -c 'scripts/dev\|dev/docker-compose\|\.mcp\.json' || true
git add README.md README.es.md CLAUDE.md
git commit -m "docs: development sandbox"
```

Expected: tests green; bundle OK; the `grep -c` prints `0` (nothing from the sandbox in the bundle).

- [ ] **Step 4: Hand-off to the maintainer (manual — do not do it for them)**

1. Create `dev/.env` with the real source values (the controller session can fill it on request; it is never committed).
2. `npm run dev:refresh`.
3. Open Claude Code in `~/GITs/Actual-MCP`, approve the project MCP server `actual-dev`, and ask for the accounts: balances must be last night's.
4. Create a test transaction in the sandbox; check it does not appear in production.
5. Ask for a bank sync in the sandbox: it must fail.
