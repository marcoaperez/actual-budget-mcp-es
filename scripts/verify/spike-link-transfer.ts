// Spike (Piece 0.3 of the 2026-10-08 reconciliation spec). THROWAWAY: it answers questions,
// it is not product code. Runs against the ephemeral 26.10.0 server ONLY:
//
//   docker compose -f test/integration/docker-compose.actual.yml up -d
//   npx tsx scripts/verify/spike-link-transfer.ts
//
// Not under vitest: NODE_ENV=test makes @actual-app/api take an eager resync path that hangs
// (see scripts/demo/reset-check.ts). Questions answered, all printed in RESULT=:
//   A. transfer + merge: set X's payee to B's transfer payee (Actual creates X' in B), then
//      mergeTransactions([X', Y]). Which row survives? Is imported_id kept? Linked both ways?
//   B. direct link: write transfer_id on X and Y, then set the transfer payees.
//   C. getAccountBalance(id, cutoff): does cutoff include transactions dated ON cutoff?
//   D. after shutdown, a second client downloading the budget sees the same state.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as api from '@actual-app/api';

const URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
const PASSWORD = process.env.ACTUAL_SERVER_PASSWORD ?? 'test-pass';
if (!/localhost|127\.0\.0\.1/.test(URL)) throw new Error(`Spike solo contra el servidor efímero local, no ${URL}`);

const DATE = '2026-09-15';

async function rows(filter: Record<string, unknown>) {
  const { data } = (await api.runQuery(
    api.q('transactions').filter(filter).options({ splits: 'all' }).select(['*']),
  )) as { data: unknown };
  return data as any[];
}

async function transferPayeeOf(accountId: string): Promise<string> {
  const payees = await api.getPayees();
  const p = payees.find((x: any) => x.transfer_acct === accountId);
  if (!p) throw new Error(`sin payee de transferencia para ${accountId}`);
  return p.id;
}

/** Two on-budget accounts, one imported transaction each, opposite amounts, same date. */
async function fixture(tag: string) {
  const a = await api.createAccount({ name: `${tag} A`, offbudget: false }, 0);
  const b = await api.createAccount({ name: `${tag} B`, offbudget: false }, 0);
  await api.importTransactions(a, [
    { account: a, date: DATE, amount: -10000, payee_name: 'Traspaso banco', imported_id: `${tag}-x` },
  ]);
  await api.importTransactions(b, [
    { account: b, date: DATE, amount: 10000, payee_name: 'Traspaso banco', imported_id: `${tag}-y` },
  ]);
  const [x] = await rows({ account: a });
  const [y] = await rows({ account: b });
  return { a, b, x, y };
}

function summary(r: any) {
  return r && {
    id: r.id, account: r.account, amount: r.amount, date: r.date,
    imported_id: r.imported_id ?? null, transfer_id: r.transfer_id ?? null,
    payee: r.payee ?? null, tombstone: r.tombstone ?? false,
  };
}

async function mechanismA(tag: string, reversed: boolean) {
  const { a, b, x, y } = await fixture(tag);
  const updateReturn = await api.updateTransaction(x.id, { payee: await transferPayeeOf(b) });
  // EXTENSION (run 2): the first run read account B right after the update and saw no X'.
  // Poll to learn whether X' appears late (and after how many ms) or never.
  let xPrime: any;
  let waitedMs = 0;
  for (; waitedMs <= 5000; waitedMs += 250) {
    xPrime = (await rows({ account: b })).find((r) => r.id !== y.id);
    if (xPrime) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const xAfterUpdate = summary((await rows({ id: x.id }))[0]);
  const ids: [string, string] | null = xPrime ? (reversed ? [y.id, xPrime.id] : [xPrime.id, y.id]) : null;
  const mergeReturn = ids ? await api.mergeTransactions(ids) : 'no X′ created';
  return {
    updateReturn,
    waitedMs,
    xPrimeBeforeMerge: summary(xPrime),
    xAfterUpdate,
    mergeReturn,
    afterX: summary((await rows({ id: x.id }))[0]),
    accountA: (await rows({ account: a })).map(summary),
    accountB: (await rows({ account: b })).map(summary),
    balanceA: await api.getAccountBalance(a),
    balanceB: await api.getAccountBalance(b),
  };
}

async function mechanismB() {
  const { a, b, x, y } = await fixture('SpikeB');
  let error: string | null = null;
  try {
    await api.updateTransaction(x.id, { transfer_id: y.id });
    await api.updateTransaction(y.id, { transfer_id: x.id });
    await api.updateTransaction(x.id, { payee: await transferPayeeOf(b) });
    await api.updateTransaction(y.id, { payee: await transferPayeeOf(a) });
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    error,
    accountA: (await rows({ account: a })).map(summary),
    accountB: (await rows({ account: b })).map(summary),
    balanceA: await api.getAccountBalance(a),
    balanceB: await api.getAccountBalance(b),
  };
}

async function cutoffSemantics() {
  const acc = await api.createAccount({ name: 'SpikeCutoff', offbudget: false }, 0);
  await api.addTransactions(acc, [{ date: DATE, amount: 500 }]);
  return {
    cutoffSameDayLocalMidnight: await api.getAccountBalance(acc, new Date(`${DATE}T00:00:00`)),
    cutoffSameDayEndOfDay: await api.getAccountBalance(acc, new Date(`${DATE}T23:59:59`)),
    cutoffDayBeforeEndOfDay: await api.getAccountBalance(acc, new Date('2026-09-14T23:59:59')),
    cutoffDayBeforeNoon: await api.getAccountBalance(acc, new Date('2026-09-14T12:00:00')),
    cutoffUtcMidnightString: await api.getAccountBalance(acc, new Date(`${DATE}T00:00:00Z`)),
    cutoffNextDay: await api.getAccountBalance(acc, new Date('2026-09-16T00:00:00')),
    noCutoff: await api.getAccountBalance(acc),
  };
}

async function run(): Promise<void> {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-link-1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-link-2-'));
  const result: Record<string, unknown> = {};
  try {
    await api.init({ dataDir: dir1, serverURL: URL, password: PASSWORD });
    await api.runImport('SpikeLink', async () => {});
    const budgets = await api.getBudgets();
    const syncId = (budgets.find((b: any) => b.groupId) ?? budgets[0])?.groupId;
    result.A = await mechanismA('SpikeA', false);
    result.A2 = await mechanismA('SpikeAR', true); // EXTENSION: merge order reversed [Y, X′]
    result.B = await mechanismB();
    result.C = await cutoffSemantics();
    await api.sync();
    await api.shutdown();

    await api.init({ dataDir: dir2, serverURL: URL, password: PASSWORD });
    await api.downloadBudget(syncId);
    result.D = {
      allSpikeRows: (await rows({ imported_id: { $like: 'Spike%' } })).map(summary),
      transfersSeen: (await rows({ transfer_id: { $ne: null } })).map(summary),
    };
  } finally {
    try { await api.shutdown(); } catch {}
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  console.log('RESULT=' + JSON.stringify(result, null, 2));
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
