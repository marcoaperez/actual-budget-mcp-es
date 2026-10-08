// End-to-end check of the reconciliation tools against the EPHEMERAL actual-server (26.10.0).
// Run as a subprocess (not in-process under vitest): mergeTransactions deletes rows, and
// @actual-app/api's delete paths deadlock under vitest (see scripts/demo/reset-check.ts).
//
//   docker compose -f test/integration/docker-compose.actual.yml up -d
//   npx tsx scripts/verify/reconcile-check.ts
//
// Fixture (mirrors the spec's motivating case):
//   Banco A (bank-synced): -100,00 "Traspaso a Banco B" and -50,00 "Retirada efectivo cajero"
//   Banco B (bank-synced): +100,00 the next day (the other leg, imported) and +25,00 "Bizum"
//                          imported plus the same +25,00 typed by hand (duplicate)
//   Efectivo (manual): empty
// Expected: link (alta), merge (alta), create_transfer to Efectivo (dudosa, by name); after
// applying all of them: A = -150,00, B = 125,00, Efectivo = 50,00; every imported_id survives.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as api from '@actual-app/api';
import type { Config } from '../../src/core/config.js';
import { tool as findTransferIssues } from '../../src/tools/find_transfer_issues.js';
import { tool as applyFixes } from '../../src/tools/apply_reconciliation_fixes.js';
import { tool as reconcileAccount } from '../../src/tools/reconcile_account.js';
import { tool as markReconciled } from '../../src/tools/mark_reconciled.js';

const URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
const PASSWORD = process.env.ACTUAL_SERVER_PASSWORD ?? 'test-pass';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(URL)) {
  throw new Error(`Solo contra el servidor efímero local, no ${URL}`);
}

async function run(): Promise<number> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-reconcile-check-'));
  const config: Config = {
    serverUrl: URL, password: PASSWORD, syncId: '', dataDir, locale: 'es-ES', currency: 'EUR',
    syncTtlSeconds: 60, enableWrite: true, messagesLang: 'es',
  };
  const ctx = { api, config };
  try {
    await api.init({ dataDir, serverURL: URL, password: PASSWORD });
    await api.runImport('ReconcileCheck', async () => {});
    const A = await api.createAccount({ name: 'Banco A', offbudget: false }, 0);
    const B = await api.createAccount({ name: 'Banco B', offbudget: false }, 0);
    const C = await api.createAccount({ name: 'Efectivo', offbudget: false }, 0);
    await api.importTransactions(A, [
      { date: '2026-09-15', amount: -10000, account: A, payee_name: 'Traspaso a Banco B', imported_id: 'rc-a1' },
      { date: '2026-09-15', amount: -5000, account: A, payee_name: 'Retirada efectivo cajero', imported_id: 'rc-a2' },
    ]);
    await api.importTransactions(B, [
      { date: '2026-09-16', amount: 10000, account: B, payee_name: 'Traspaso desde Banco A', imported_id: 'rc-b1' },
      { date: '2026-09-15', amount: 2500, account: B, payee_name: 'Bizum', imported_id: 'rc-b2' },
    ]);
    // addTransactions does not reconcile against existing rows: this is the duplicate.
    await api.addTransactions(B, [{ date: '2026-09-15', amount: 2500, payee_name: 'Bizum' }]);
    await api.sync();

    const found: any = await findTransferIssues.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, ctx);
    const proposals = [...found.proposals.link, ...found.proposals.merge, ...found.proposals.create_transfer];
    const applied: any = await applyFixes.handler({ operations: proposals.map((p: any) => p.operation) }, ctx);

    const balances = {
      A: await api.getAccountBalance(A),
      B: await api.getAccountBalance(B),
      C: await api.getAccountBalance(C),
    };
    const rec: any = await reconcileAccount.handler({ account: 'Banco B', bank_balance: 125, date: '2026-09-30' }, ctx);
    const marked: any = await markReconciled.handler({ account: 'banco b', bank_balance: 125, date: '2026-09-30' }, ctx);
    const { data } = (await api.runQuery(
      api.q('transactions').filter({ imported_id: { $ne: null } }).select(['imported_id', 'transfer_id']),
    )) as { data: any[] };
    const imported = (data as any[]).map((r) => r.imported_id).sort();
    const linkedImported = (data as any[]).filter((r) => r.transfer_id).map((r) => r.imported_id).sort();

    const result = {
      proposals: proposals.map((p: any) => `${p.operation.type}:${p.confidence}`),
      statuses: applied.results.map((r: any) => r.status),
      balances,
      reconcileMatches: rec.matches,
      marked: marked.marked_count,
      imported,
      linkedImported,
    };
    console.log('RESULT=' + JSON.stringify(result));
    const ok =
      result.proposals.includes('link:alta') &&
      result.proposals.includes('merge:alta') &&
      result.proposals.includes('create_transfer:dudosa') &&
      result.statuses.every((s: string) => s === 'aplicada') &&
      balances.A === -15000 && balances.B === 12500 && balances.C === 5000 &&
      rec.matches === true && marked.reconciled === true && marked.marked_count > 0 &&
      JSON.stringify(imported) === JSON.stringify(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b2']) &&
      ['rc-a1', 'rc-a2', 'rc-b1'].every((id) => linkedImported.includes(id));
    return ok ? 0 : 1;
  } finally {
    try {
      await api.shutdown();
    } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
