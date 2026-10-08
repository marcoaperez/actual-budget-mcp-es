import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NEUTRALISE_SQL, SOURCE_KEYS_BACKUP, parseEnvFile, setEnvValue, missingKeys, buildFetch, findBudget,
  portHolderIsSandbox, keepOnly, cacheEntries, buildDevEnv, checkGuard, DEV_URL, forwardSignals, missingCopyMessage,
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
    expect(f.member).toBe('opt/x/actual/data');
  });
  it('backup: member filter and strip count do not depend on a trailing slash', () => {
    const a = buildFetch('backup', env);
    const b = buildFetch('backup', { ...env, DEV_SOURCE_TAR_MEMBER_PREFIX: 'opt/x/actual/data' });
    expect(b.member).toBe(a.member);
    expect(b.stripComponents).toBe(a.stripComponents);
  });
  it('cold: stops the container, tars the data dir, always starts it again', () => {
    const f = buildFetch('cold', env);
    expect(f.remote).toBe('docker stop actual >/dev/null && sudo tar -czf - -C /opt/x/actual data ; s=$?; docker start actual >/dev/null || s=97; exit $s');
    expect(f.stripComponents).toBe(1);
    expect(f.member).toBe('data');
    expect(buildFetch('cold', { ...env, DEV_SOURCE_DATA_DIR: '/opt/x/actual/data/' }).member).toBe('data');
  });
});

describe('keepOnly / cacheEntries', () => {
  it('keeps server-files/account.sqlite*, user-files and .migrate; removes everything else', () => {
    expect(keepOnly(['server-files', 'user-files', '.migrate', 'config.json', '.DS_Store'], ['account.sqlite', 'account.sqlite-wal', 'x.bak']))
      .toEqual(['config.json', '.DS_Store', 'server-files/x.bak']);
  });
  it('removes nothing from a clean copy', () => {
    expect(keepOnly(['server-files', 'user-files', '.migrate'], ['account.sqlite'])).toEqual([]);
  });
  it('cacheEntries picks .cache and .cache-instance-*, nothing else', () => {
    expect(cacheEntries(['.cache', '.cache-instance-12', '.cache.bak', 'data', '.env', 'docker-compose.yml']))
      .toEqual(['.cache', '.cache-instance-12']);
  });
});

describe('missingCopyMessage', () => {
  it('points at the right setting for each mode', () => {
    expect(missingCopyMessage('backup')).toMatch(/DEV_SOURCE_TAR_MEMBER_PREFIX/);
    const cold = missingCopyMessage('cold');
    expect(cold).toMatch(/DEV_SOURCE_DATA_DIR/);
    expect(cold).toMatch(/DEV_SOURCE_CONTAINER/);
    expect(cold).toMatch(/sudo/);
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
      "INSERT INTO secrets VALUES('gocardless_secretId','TOY-SECRET-VALUE-123'); INSERT INTO auth VALUES('password','TOY-HASH-VALUE-456');" +
      "INSERT INTO sessions VALUES('TOY-TOKEN-VALUE-789'); INSERT INTO files VALUES('f','g',0,'Personal');"]);
    execFileSync('sqlite3', [db, NEUTRALISE_SQL]);
    const counts = execFileSync('sqlite3', [db, 'select (select count(*) from secrets),(select count(*) from auth),(select count(*) from sessions),(select count(*) from files);'], { encoding: 'utf8' }).trim();
    expect(counts).toBe('0|0|0|1');
    // Borrado de verdad: ni rastro de los valores en los bytes del fichero.
    const bytes = fs.readFileSync(db);
    for (const v of ['TOY-SECRET-VALUE-123', 'TOY-HASH-VALUE-456', 'TOY-TOKEN-VALUE-789']) {
      expect(bytes.includes(v), v).toBe(false);
    }
  });
});

describe('dev/.env.example', () => {
  it('every key parses to an empty string despite trailing comments', () => {
    const text = fs.readFileSync('dev/.env.example', 'utf8');
    const env = parseEnvFile(text);
    expect(Object.keys(env).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(env)) expect(v, k).toBe('');
  });
});

describe('.gitignore', () => {
  it('keeps the copy, the cache and dev/.env out of git', () => {
    for (const p of ['dev/data/server-files/account.sqlite', 'dev/.cache/x', 'dev/data.new/server-files/account.sqlite', 'dev/.cache-instance-123/x', 'dev/.env', 'dev/data.old/x', 'dev/.cache.bak/x']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', p])).not.toThrow();
    }
    for (const p of ['dev/.env.example', 'dev/docker-compose.yml']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', p]), p).toThrow();
    }
  });
});

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

describe('forwardSignals', () => {
  it('forwards SIGINT/SIGTERM/SIGHUP to the child and kills it when stdin ends', () => {
    const proc = new EventEmitter() as EventEmitter & { stdin: EventEmitter };
    proc.stdin = new EventEmitter();
    const child = { kill: vi.fn() };
    forwardSignals(proc, child);
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    proc.emit('SIGHUP');
    expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM'], ['SIGHUP']]);
    proc.stdin.emit('end');
    expect(child.kill).toHaveBeenCalledTimes(4);
    expect(child.kill).toHaveBeenLastCalledWith('SIGTERM');
  });
});
