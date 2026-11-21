// End-to-end check of the household cleanup tools against the EPHEMERAL actual-server (26.11.0):
// split with transfer parts, update/set/remove transfer on parts, dateRange, import_transactions,
// budget templates and the find_transfer_issues compensation/keyword rules.
// Run as a subprocess (not in-process under vitest): deleting rows deadlocks @actual-app/api there.
//
//   docker compose -f test/integration/docker-compose.actual.yml up -d
//   npx tsx scripts/verify/household-check.ts
//
// Prints RESULT=<json> with one {name, ok, detail} per check; exit code 1 if any fails.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as api from '@actual-app/api';
import type { Config } from '../../src/core/config.js';
import { tool as splitTransaction } from '../../src/tools/split_transaction.js';
import { tool as updateTransaction } from '../../src/tools/update_transaction.js';
import { tool as setTransactionTransfer } from '../../src/tools/set_transaction_transfer.js';
import { tool as removeTransactionTransfer } from '../../src/tools/remove_transaction_transfer.js';
import { tool as getTransactions } from '../../src/tools/get_transactions.js';
import { tool as importTransactions } from '../../src/tools/import_transactions.js';
import { tool as applyBudgetTemplates } from '../../src/tools/apply_budget_templates.js';
import { tool as getCategoryNote } from '../../src/tools/get_category_note.js';
import { tool as findTransferIssues } from '../../src/tools/find_transfer_issues.js';

const URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
const PASSWORD = process.env.ACTUAL_SERVER_PASSWORD ?? 'test-pass';
if (!/^https?:\/\/(localhost|127\.0\.0\.1):5006\/?$/.test(URL)) {
  throw new Error(`Solo contra el servidor efímero local (puerto 5006), no ${URL}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Check = { name: string; ok: boolean; detail: unknown };

async function run(): Promise<number> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-household-check-'));
  const config: Config = {
    serverUrl: URL, password: PASSWORD, syncId: '', dataDir, locale: 'es-ES', currency: 'EUR',
    syncTtlSeconds: 60, enableWrite: true, messagesLang: 'es',
  };
  const ctx = { api, config };
  const checks: Check[] = [];
  const run1 = async (name: string, fn: () => Promise<{ ok: boolean; detail: unknown }>) => {
    try {
      const r = await fn();
      checks.push({ name, ok: r.ok, detail: r.detail });
    } catch (e: any) {
      checks.push({ name, ok: false, detail: { error: String(e?.message ?? e) } });
    }
  };

  // Lecturas crudas (splits:'all' incluye partes de split).
  const rows = async (filter: any, fields = ['*']): Promise<any[]> => {
    const { data } = (await api.runQuery(api.q('transactions').filter(filter).options({ splits: 'all' }).select(fields))) as { data: any[] };
    return data;
  };
  const raw = async (id: string) => (await rows({ id }))[0] ?? null;
  const addTx = async (account: string, tx: { date: string; amount: number; notes: string; payee_name?: string }): Promise<string> => {
    await api.addTransactions(account, [tx]);
    const found = await rows({ notes: tx.notes, account });
    if (found.length !== 1) throw new Error(`addTx ${tx.notes}: ${found.length} filas`);
    return found[0].id;
  };
  const waitLink = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      if ((await raw(id))?.transfer_id) return;
      await sleep(50);
    }
    throw new Error(`transfer_id no apareció en ${id}`);
  };
  const makeTransfer = async (acct: string, tx: { date: string; amount: number; notes: string }, toPayee: string) => {
    const id = await addTx(acct, tx);
    await api.updateTransaction(id, { payee: toPayee });
    await waitLink(id);
    return id;
  };

  try {
    await api.init({ dataDir, serverURL: URL, password: PASSWORD });
    await api.runImport('HouseholdCheck', async () => {});
    const CUENTA = await api.createAccount({ name: 'Cuenta', offbudget: false }, 0);
    const HIPOTECA = await api.createAccount({ name: 'Hipoteca Ampliación', offbudget: true }, 0);
    const ADELANTOS = await api.createAccount({ name: 'Adelantos', offbudget: false }, 0);
    const FONDOS = await api.createAccount({ name: 'Fondos', offbudget: true }, 0);
    const grupo = await api.createCategoryGroup({ name: 'Grupo' });
    const cat = async (name: string) => api.createCategory({ name, group_id: grupo });
    const CUOTAS = await cat('Cuotas');
    const BANCO = await cat('Banco');
    const COMIDA = await cat('Comida');
    const OCIO = await cat('Ocio');
    const payees = (await api.getPayees()) as any[];
    const tp = (acct: string) => payees.find((p) => p.transfer_acct === acct)!.id as string;
    // Plantillas: Comida por notas, Ocio con la plantilla de la UI (preparación de la prueba).
    await (api as any).default.internal.send('notes-save', { id: COMIDA, note: '#template 100' });
    await (api as any).default.internal.send('notes-save', { id: OCIO, note: '#template 50' });
    await (api as any).default.internal.send('category-update', { id: OCIO, template_settings: { source: 'ui' } });

    // 1. Split -800 con parte-transferencia a Hipoteca (cruza el lado) que conserva «Cuotas».
    await run1('1 split with transfer part (cross-side keeps category)', async () => {
      const id = await addTx(CUENTA, { date: '2026-11-02', amount: -80000, notes: 'chk1' });
      const res: any = await splitTransaction.handler({
        transaction_id: id,
        splits: [
          { amount: -600, category_id: CUOTAS, transfer_account_id: HIPOTECA },
          { amount: -200, category_id: BANCO },
        ],
      }, ctx);
      await sleep(300);
      const kids = (await rows({ parent_id: id })).sort((a, b) => a.amount - b.amount);
      const twins = await rows({ account: HIPOTECA, amount: 60000 });
      const transferKid = kids.find((k) => k.amount === -60000);
      const ok = kids.length === 2 && twins.length === 1 && transferKid?.category === CUOTAS
        && !!transferKid?.transfer_id && kids.every((k) => k.account === CUENTA) && !res.echo_pending;
      return { ok, detail: { kids: kids.length, twinsInHipoteca: twins.length, transferPartCategoryKept: transferKid?.category === CUOTAS,
        childrenCarryAccount: kids.every((k) => k.account === CUENTA), echoPending: !!res.echo_pending } };
    });

    // 2. update_transaction sobre la parte «Banco»: padre y suma intactos.
    await run1('2 update_transaction on a split part', async () => {
      const parent = (await rows({ notes: 'chk1', account: CUENTA, is_parent: true }))[0];
      const kids = await rows({ parent_id: parent.id });
      const bancoKid = kids.find((k) => k.amount === -20000)!;
      await updateTransaction.handler({ transaction_id: bancoKid.id, category_id: COMIDA, notes: 'chk2-part' }, ctx);
      await sleep(300);
      const after = await rows({ parent_id: parent.id });
      const parentAfter = await raw(parent.id);
      const sum = after.reduce((s, k) => s + k.amount, 0);
      const k2 = after.find((k) => k.id === bancoKid.id);
      const ok = k2?.category === COMIDA && k2?.notes === 'chk2-part' && parentAfter.amount === -80000 && sum === -80000 && after.length === 2;
      return { ok, detail: { partCategory: k2?.category === COMIDA, partNotes: k2?.notes, parentAmount: parentAfter.amount, sum } };
    });

    // 3. set_transaction_transfer sobre una parte de un segundo split (con categoría, cruza el lado).
    await run1('3 set_transaction_transfer on a split part', async () => {
      const id = await addTx(CUENTA, { date: '2026-11-03', amount: -50000, notes: 'chk3' });
      await splitTransaction.handler({
        transaction_id: id,
        splits: [{ amount: -300, category_id: BANCO }, { amount: -200, category_id: BANCO }],
      }, ctx);
      await sleep(300);
      const part = (await rows({ parent_id: id })).find((k) => k.amount === -20000)!;
      const res: any = await setTransactionTransfer.handler({ transaction_id: part.id, target_account_id: FONDOS, category_id: CUOTAS }, ctx);
      await sleep(300);
      const after = await raw(part.id);
      const twins = await rows({ account: FONDOS, amount: 20000 });
      const ok = !!after.transfer_id && after.category === CUOTAS && twins.length === 1 && after.parent_id === id;
      return { ok, detail: { linked: !!after.transfer_id, categoryKept: after.category === CUOTAS, twinsInFondos: twins.length,
        childCarriesAccount: after.account === CUENTA, toolTransferId: !!res.transfer_id } };
    });

    // 4. Dividir una transferencia manual: la pata vieja desaparece y queda UNA nueva por parte-transferencia.
    await run1('4 split an existing manual transfer', async () => {
      const id = await makeTransfer(CUENTA, { date: '2026-11-04', amount: -30000, notes: 'chk4' }, tp(ADELANTOS));
      const oldTwinId = (await raw(id)).transfer_id as string;
      const res: any = await splitTransaction.handler({
        transaction_id: id,
        splits: [{ amount: -100, category_id: COMIDA }, { amount: -200, transfer_account_id: ADELANTOS }],
      }, ctx);
      await sleep(500);
      const oldTwin = await raw(oldTwinId);
      const oldAmount = await rows({ account: ADELANTOS, amount: 30000 });
      const newTwins = await rows({ account: ADELANTOS, amount: 20000 });
      const parent = await raw(id);
      const ok = !oldTwin && oldAmount.length === 0 && newTwins.length === 1 && !!res.replaced_twin_id && parent.payee !== tp(ADELANTOS);
      return { ok, detail: { oldTwinGone: !oldTwin, old300RowsLeft: oldAmount.length, newTwins200: newTwins.length,
        replacedTwinReported: res.replaced_twin_id === oldTwinId, parentPayeeIsTransfer: parent.payee === tp(ADELANTOS), echoPending: !!res.echo_pending } };
    });

    // 5. Split de una transferencia cuya pata tiene imported_id: rechazado, nada cambia.
    await run1('5 split refused when twin is bank-imported', async () => {
      const id = await makeTransfer(CUENTA, { date: '2026-11-05', amount: -25000, notes: 'chk5' }, tp(FONDOS));
      const twinId = (await raw(id)).transfer_id as string;
      await api.updateTransaction(twinId, { imported_id: 'chk5-bank' });
      await sleep(300);
      let refused = '';
      try {
        await splitTransaction.handler({
          transaction_id: id,
          splits: [{ amount: -100, category_id: COMIDA }, { amount: -150, category_id: BANCO }],
        }, ctx);
      } catch (e: any) { refused = String(e.message); }
      await sleep(300);
      const after = await raw(id);
      const kids = await rows({ parent_id: id });
      const twin = await raw(twinId);
      const ok = !!refused && kids.length === 0 && after.transfer_id === twinId && !after.is_parent && !!twin && twin.imported_id === 'chk5-bank';
      return { ok, detail: { refused: !!refused, children: kids.length, stillLinked: after.transfer_id === twinId, twinIntact: !!twin } };
    });

    // 6. remove_transaction_transfer: la pata se borra de verdad, pagador y categoría puestos.
    await run1('6 remove_transaction_transfer deletes the twin', async () => {
      const id = await makeTransfer(CUENTA, { date: '2026-11-06', amount: -15000, notes: 'chk6' }, tp(ADELANTOS));
      const twinId = (await raw(id)).transfer_id as string;
      const res: any = await removeTransactionTransfer.handler({ transaction_id: id, payee_name: 'Proveedor chk6', category_id: COMIDA }, ctx);
      await sleep(300);
      const after = await raw(id);
      const twin = await raw(twinId);
      const payee = ((await api.getPayees()) as any[]).find((p) => p.id === after.payee);
      const ok = !twin && !after.transfer_id && payee?.name === 'Proveedor chk6' && after.category === COMIDA && res.twin_action === 'deleted' && !res.twin_still_present;
      return { ok, detail: { twinGone: !twin, linkCleared: !after.transfer_id, payeeSet: payee?.name === 'Proveedor chk6', categorySet: after.category === COMIDA, twinAction: res.twin_action } };
    });

    // 7. get_transactions con start = end devuelve solo ese día ($and de dateRange en AQL real).
    await run1('7 get_transactions single-day dateRange', async () => {
      for (const [d, n] of [['2026-11-09', 'chk7a'], ['2026-11-10', 'chk7b'], ['2026-11-11', 'chk7c']]) {
        await addTx(CUENTA, { date: d, amount: -100, notes: n });
      }
      const res: any = await getTransactions.handler({ start_date: '2026-11-10', end_date: '2026-11-10', account_id: CUENTA }, ctx);
      const ok = res.transactions.length === 1 && res.transactions[0].date === '2026-11-10' && res.total_count === 1;
      return { ok, detail: { returned: res.transactions.length, totalCount: res.total_count, dates: res.transactions.map((t: any) => t.date) } };
    });

    // 8. import_transactions: vista previa, alta, repetición, borrado (tombstone) y fuzzy.
    await run1('8 import_transactions preview/add/rerun/tombstone/fuzzy', async () => {
      const imp = async (txs: any[], extra: any = {}) => (await importTransactions.handler({ account_id: CUENTA, transactions: txs, ...extra }, ctx)) as any;
      const countImp = async (id: string) => (await rows({ imported_id: id, account: CUENTA })).length;
      const t1 = { date: '2026-10-05', amount: -25, imported_id: 'hh-1', payee_name: 'Cafe' };
      const t2 = { date: '2026-10-06', amount: -10, imported_id: 'hh-2', payee_name: 'Kiosco' };
      const dry = await imp([t1, t2]);
      const afterDry = (await countImp('hh-1')) + (await countImp('hh-2'));
      const real = await imp([t1, t2], { dry_run: false });
      const afterReal = (await countImp('hh-1')) + (await countImp('hh-2'));
      const again = await imp([t1, t2], { dry_run: false });
      const afterAgain = (await countImp('hh-1')) + (await countImp('hh-2'));
      const victim = (await rows({ imported_id: 'hh-2', account: CUENTA }))[0];
      await api.deleteTransaction(victim.id);
      await sleep(300);
      const afterDelete = await imp([t2], { dry_run: false });
      const stillGone = await countImp('hh-2');
      // Fuzzy: fila manual sin imported_id mismo importe a 2 días.
      await addTx(CUENTA, { date: '2026-10-08', amount: -4000, notes: 'chk8-fz' });
      const t3 = { date: '2026-10-10', amount: -40, imported_id: 'hh-3', payee_name: 'Otro' };
      const fzDry = await imp([t3]);
      const fzReal = await imp([t3], { dry_run: false });
      const t3Rows = await countImp('hh-3');
      const ok = dry.totals.add === 2 && afterDry === 0 && real.totals.add === 2 && afterReal === 2
        && again.totals.unchanged === 2 && afterAgain === 2
        && afterDelete.results[0].outcome === 'kept_deleted' && stillGone === 0
        && fzDry.results[0].outcome === 'fuzzy' && fzReal.results[0].outcome === 'skipped_fuzzy' && t3Rows === 0;
      return { ok, detail: { dryTotals: dry.totals, rowsAfterDry: afterDry, realTotals: real.totals, rowsAfterReal: afterReal,
        rerunTotals: again.totals, rowsAfterRerun: afterAgain, afterDeleteOutcome: afterDelete.results[0].outcome, deletedRowsBack: stillGone,
        fuzzyPreview: fzDry.results[0].outcome, fuzzyReal: fzReal.results[0].outcome, fuzzyRowsWritten: t3Rows } };
    });

    // 9. Plantillas: apply-goal-template por api.internal, recarga con getBudgetMonth, fuente UI.
    await run1('9 apply_budget_templates + get_category_note', async () => {
      const res: any = await applyBudgetTemplates.handler({ month: '2026-12' }, ctx);
      const month: any = await api.getBudgetMonth('2026-12');
      const comida = month.categoryGroups.flatMap((g: any) => g.categories).find((c: any) => c.id === COMIDA);
      const note: any = await getCategoryNote.handler({ category_id: OCIO }, ctx);
      const ok = comida?.budgeted === 10000 && (res.ui_template_categories ?? []).includes('Ocio')
        && note.template_source === 'ui' && /Ocio/.test(note.warning ?? '') && /Ocio/.test(res.warning ?? '') && res.changed.some((c: any) => c.category === 'Comida');
      return { ok, detail: { count: res.count, comidaBudgeted: comida?.budgeted, changed: res.changed, uiCategories: res.ui_template_categories,
        resultWarning: !!res.warning, noteSource: note.template_source, noteWarning: !!note.warning } };
    });

    // 10. find_transfer_issues con filas importadas e historial hacia Adelantos.
    await run1('10 find_transfer_issues compensated -> alta, payroll -> dudosa', async () => {
      await api.importTransactions(CUENTA, [
        { date: '2026-08-20', amount: -5000, account: CUENTA, payee_name: 'Ahorro Casa', imported_id: 'h-1' },
      ]);
      const h1 = (await rows({ imported_id: 'h-1', account: CUENTA }))[0];
      await api.updateTransaction(h1.id, { payee: tp(ADELANTOS) });
      await waitLink(h1.id);
      await api.importTransactions(CUENTA, [
        { date: '2026-09-10', amount: -10000, account: CUENTA, payee_name: 'Ahorro Casa', imported_id: 'h-2' },
        { date: '2026-09-15', amount: -7000, account: CUENTA, payee_name: 'Ahorro Casa', imported_id: 'h-3', notes: 'Nómina septiembre' },
      ]);
      await addTx(ADELANTOS, { date: '2026-09-12', amount: -10000, notes: 'chk10-comp-a' });
      await addTx(ADELANTOS, { date: '2026-09-16', amount: -7000, notes: 'chk10-comp-b' });
      const res: any = await findTransferIssues.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, ctx);
      const created = res.proposals.create_transfer as any[];
      const idOf = async (impId: string) => (await rows({ imported_id: impId, account: CUENTA }))[0].id as string;
      const ids2 = { h2: await idOf('h-2'), h3: await idOf('h-3') };
      const h2 = created.find((p) => p.operation.transaction === ids2.h2 && p.operation.account === ADELANTOS);
      const h3 = created.find((p) => p.operation.transaction === ids2.h3 && p.operation.account === ADELANTOS);
      const ok = h2?.confidence === 'alta' && /se compensa en la cuenta destino/.test(h2.reason) && !/nómina/.test(h2.reason)
        && h3?.confidence === 'dudosa' && /«nómina» en las notas/.test(h3.reason);
      return { ok, detail: { compensated: h2 && { confidence: h2.confidence, reason: h2.reason },
        payroll: h3 && { confidence: h3.confidence, reason: h3.reason }, createTransferProposals: created.length } };
    });
  } finally {
    try { await api.shutdown(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('RESULT=' + JSON.stringify({ checks }));
  return checks.every((c) => c.ok) ? 0 : 1;
}

run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
