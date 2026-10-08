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
  const syncId = (await api.getBudgets()).find((b: any) => b.groupId)?.groupId as string;
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
