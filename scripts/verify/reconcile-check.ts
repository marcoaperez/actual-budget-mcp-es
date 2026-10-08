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
//   Banco B also: -40,00 typed by hand and turned into a transfer with Ahorro (updateTransaction
//                 payee = Ahorro's transfer payee, the set_transaction_transfer mechanism), plus the
//                 bank's imported duplicate of that same leg (imported_id rc-b3, same date and amount)
//   Efectivo, Ahorro (manual): empty
// Expected: link (alta), 2 merges (alta), create_transfer to Efectivo (dudosa, by name); after
// applying all of them: A = -150,00, B = 85,00, Efectivo = 50,00, Ahorro = 40,00; every imported_id
// survives; rc-b3 keeps its link to the Ahorro leg and that leg points back; every link is mutual.
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
    const D = await api.createAccount({ name: 'Ahorro', offbudget: false }, 0);
    await api.importTransactions(A, [
      { date: '2026-09-15', amount: -10000, account: A, payee_name: 'Traspaso a Banco B', imported_id: 'rc-a1' },
      { date: '2026-09-15', amount: -5000, account: A, payee_name: 'Retirada efectivo cajero', imported_id: 'rc-a2' },
    ]);
    await api.importTransactions(B, [
      { date: '2026-09-16', amount: 10000, account: B, payee_name: 'Traspaso desde Banco A', imported_id: 'rc-b1' },
      { date: '2026-09-15', amount: 2500, account: B, payee_name: 'Bizum', imported_id: 'rc-b2' },
    ]);
    // The bank's import of the Ahorro leg lands BEFORE the hand-made one is added: importTransactions
    // would otherwise fuzzy-match and absorb it.
    await api.importTransactions(B, [
      { date: '2026-09-17', amount: -4000, account: B, payee_name: 'Aporte Ahorro', imported_id: 'rc-b3' },
    ]);
    // addTransactions does not reconcile against existing rows: this is the duplicate.
    await api.addTransactions(B, [{ date: '2026-09-15', amount: 2500, payee_name: 'Bizum' }]);
    // Hand-made leg of a transfer with Ahorro that the bank later imported again (the rc-b3 row).
    await api.addTransactions(B, [{ date: '2026-09-17', amount: -4000, payee_name: 'Aporte Ahorro' }]);
    const payees = (await api.getPayees()) as any[];
    const ahorroPayee = payees.find((p) => p.transfer_acct === D)!.id;
    const { data: manualLeg } = (await api.runQuery(
      api.q('transactions').filter({ account: B, amount: -4000, imported_id: null }).select(['id']),
    )) as { data: any[] };
    await api.updateTransaction(manualLeg[0].id, { payee: ahorroPayee });
    // Actual creates the counterpart asynchronously: wait for the link.
    for (let i = 0; i < 40; i++) {
      const { data } = (await api.runQuery(
        api.q('transactions').filter({ id: manualLeg[0].id }).select(['transfer_id']),
      )) as { data: any[] };
      if (data[0]?.transfer_id) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await api.sync();

    const found: any = await findTransferIssues.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, ctx);
    const proposals = [...found.proposals.link, ...found.proposals.merge, ...found.proposals.create_transfer];
    const applied: any = await applyFixes.handler({ operations: proposals.map((p: any) => p.operation) }, ctx);

    const balances = {
      A: await api.getAccountBalance(A),
      B: await api.getAccountBalance(B),
      C: await api.getAccountBalance(C),
      D: await api.getAccountBalance(D),
    };
    const rec: any = await reconcileAccount.handler({ account: 'Banco B', bank_balance: 85, date: '2026-09-30' }, ctx);
    const marked: any = await markReconciled.handler({ account: 'banco b', bank_balance: 85, date: '2026-09-30' }, ctx);
    const { data: bUnreconciled } = (await api.runQuery(
      api.q('transactions').filter({ account: B, reconciled: false }).select(['id']),
    )) as { data: any[] };
    const { data } = (await api.runQuery(
      api.q('transactions').filter({ imported_id: { $ne: null } }).select(['imported_id', 'transfer_id']),
    )) as { data: any[] };
    const imported = (data as any[]).map((r) => r.imported_id).sort();
    const linkedImported = (data as any[]).filter((r) => r.transfer_id).map((r) => r.imported_id).sort();
    // Every link must be mutual: the row a transfer_id points to exists and points back.
    const { data: linked } = (await api.runQuery(
      api.q('transactions').filter({ transfer_id: { $ne: null } }).select(['id', 'account', 'imported_id', 'transfer_id']),
    )) as { data: any[] };
    const byId = new Map(linked.map((r) => [r.id, r]));
    const mutualLinks = linked.length > 0 && linked.every((r) => byId.get(r.transfer_id)?.transfer_id === r.id);
    const b3 = linked.find((r) => r.imported_id === 'rc-b3');
    const b3LinkedToAhorro = !!b3 && b3.account === B && byId.get(b3.transfer_id)?.account === D;

    const result = {
      proposals: proposals.map((p: any) => `${p.operation.type}:${p.confidence}`),
      statuses: applied.results.map((r: any) => r.status),
      balances,
      reconcileMatches: rec.matches,
      marked: marked.marked_count,
      markedAll: marked.reconciled === true && bUnreconciled.length === 0,
      mutualLinks,
      b3LinkedToAhorro,
      imported,
      linkedImported,
    };
    console.log('RESULT=' + JSON.stringify(result));
    const ok =
      result.proposals.includes('link:alta') &&
      result.proposals.filter((p: string) => p === 'merge:alta').length === 2 &&
      result.proposals.includes('create_transfer:dudosa') &&
      result.statuses.length === 4 &&
      result.statuses.every((s: string) => s === 'aplicada') &&
      balances.A === -15000 && balances.B === 8500 && balances.C === 5000 && balances.D === 4000 &&
      rec.matches === true && marked.reconciled === true && marked.marked_count === 3 &&
      result.markedAll && mutualLinks && b3LinkedToAhorro &&
      JSON.stringify(imported) === JSON.stringify(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b2', 'rc-b3']) &&
      JSON.stringify(linkedImported) === JSON.stringify(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b3']);
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
