import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/remove_transaction_transfer.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const TWIN = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const CHILD = '44444444-4444-4444-8444-444444444444';
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const A2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const C9 = 'cccccccc-9999-4999-8999-999999999999';
const C_GHOST = 'cccccccc-0000-4000-8000-000000000000';
const P1 = 'eeeeeeee-1111-4111-8111-111111111111';
const P_TR = 'eeeeeeee-2222-4222-8222-222222222222';
const GROUPS = [{ id: 'g1', name: 'Gastos', is_income: false, categories: [{ id: C9, name: 'Comida' }] }];
const payees = [
  { id: P1, name: 'Mercadona', transfer_acct: null },
  { id: P_TR, name: 'Savings', transfer_acct: A2 },
];
const accounts = [{ id: A1, name: 'Checking' }, { id: A2, name: 'Savings' }];

/**
 * Lecturas por id: `rows` guarda el estado actual de cada fila; las lecturas agrupadas de un
 * id de hijo devuelven el padre. Tras updateTransaction la fila escrita refleja los campos
 * pedidos y pierde transfer_id (lo que haría removeTransfer).
 */
function api2(rows: Record<string, any>, overrides: Record<string, unknown> = {}) {
  let api: any;
  api = mockApi({
    getAccounts: async () => accounts,
    getPayees: async () => payees,
    getCategoryGroups: async () => GROUPS,
    runQuery: async (q: any) => {
      const id = q.calls.filter?.[0]?.id;
      const grouped = q.calls.options?.[0]?.splits !== 'all';
      let row = rows[id];
      if (row?.is_child && grouped) row = rows[row.parent_id];
      if (row && api.updateTransaction.mock.calls.some((c: any) => c[0] === id)) {
        const written = api.updateTransaction.mock.calls.filter((c: any) => c[0] === id).at(-1)[1];
        row = { ...row, ...written, transfer_id: null };
      }
      return { data: row ? [row] : [] };
    },
    ...overrides,
  });
  return api;
}

const leg = { id: T1, account: A1, date: '2026-07-01', amount: -5000, payee: P_TR, category: null, transfer_id: TWIN };
const twinRow = { id: TWIN, account: A2, amount: 5000, transfer_id: T1, reconciled: 0, imported_id: null };
const call = (api: any, args: any) => tool.handler(args, { api, config: testConfig });

describe('remove_transaction_transfer', () => {
  it('turns a normal transfer leg into an ordinary transaction and reports the deleted twin', async () => {
    const api = api2({ [T1]: leg, [TWIN]: twinRow });
    const r: any = await call(api, { transaction_id: T1, payee_id: P1, category_id: C9 });
    expect(api.updateTransaction).toHaveBeenCalledWith(T1, { payee: P1, category: C9 });
    expect(r.updated).toBe(true);
    expect(r.twin_action).toBe('deleted');
    expect(r.removed_twin_id).toBe(TWIN);
    expect(r.transaction.category_id).toBe(C9);
    expect(r.echo_pending).toBeUndefined();
  });

  it('writes to the child id of a transfer split part and reports a detached twin', async () => {
    const parent = { id: PARENT, is_parent: true, account: A1, subtransactions: [{ id: CHILD }] };
    const child = { id: CHILD, is_child: true, parent_id: PARENT, account: A1, amount: -2000, payee: P_TR, transfer_id: TWIN };
    const detachedTwin = { ...twinRow, is_child: true, parent_id: 'x' };
    const api = api2({ [PARENT]: parent, [CHILD]: child, [TWIN]: detachedTwin });
    const r: any = await call(api, { transaction_id: CHILD, payee_name: 'mercadona', category_id: C9 });
    expect(api.updateTransaction).toHaveBeenCalledWith(CHILD, { payee: P1, category: C9 });
    expect(r.twin_action).toBe('detached');
    expect(r.parent_id).toBe(PARENT);
  });

  it.each([
    ['reconciled', { reconciled: 1 }],
    ['imported', { imported_id: 'bank-1' }],
  ])('refuses a %s twin without force and does not write', async (_n, extra) => {
    const api = api2({ [T1]: leg, [TWIN]: { ...twinRow, ...extra } });
    await expect(call(api, { transaction_id: T1, payee_id: P1 })).rejects.toThrow(TWIN);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('with force writes; an imported twin adds a warning naming its account', async () => {
    const api = api2({ [T1]: leg, [TWIN]: { ...twinRow, imported_id: 'bank-1' } });
    const r: any = await call(api, { transaction_id: T1, payee_id: P1, force: true });
    expect(api.updateTransaction).toHaveBeenCalled();
    expect(r.warning).toContain('Savings');
  });

  it('with force on a reconciled (not imported) twin writes without the bank warning', async () => {
    const api = api2({ [T1]: leg, [TWIN]: { ...twinRow, reconciled: 1 } });
    const r: any = await call(api, { transaction_id: T1, payee_id: P1, force: true });
    expect(r.warning).toBeUndefined();
  });

  it('rejects a transaction that is not a transfer', async () => {
    const api = api2({ [T1]: { ...leg, payee: P1, transfer_id: null } });
    await expect(call(api, { transaction_id: T1, payee_id: P1 })).rejects.toThrow(/no es una transferencia|not a transfer/);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a split parent id', async () => {
    const api = api2({ [PARENT]: { id: PARENT, is_parent: true, subtransactions: [{ id: CHILD }] } });
    await expect(call(api, { transaction_id: PARENT, payee_id: P1 })).rejects.toThrow(PARENT);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('requires exactly one of payee_id / payee_name', async () => {
    const api = api2({ [T1]: leg, [TWIN]: twinRow });
    await expect(call(api, { transaction_id: T1 })).rejects.toThrow(/payee_id/);
    await expect(call(api, { transaction_id: T1, payee_id: P1, payee_name: 'X' })).rejects.toThrow(/payee_id/);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown category before writing', async () => {
    const api = api2({ [T1]: leg, [TWIN]: twinRow });
    await expect(call(api, { transaction_id: T1, payee_id: P1, category_id: C_GHOST })).rejects.toThrow(C_GHOST);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a transfer payee given by id', async () => {
    const api = api2({ [T1]: leg, [TWIN]: twinRow });
    await expect(call(api, { transaction_id: T1, payee_id: P_TR })).rejects.toThrow(P_TR);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a payee_name that only matches a transfer payee (no silent re-transfer)', async () => {
    const api = api2({ [T1]: leg, [TWIN]: twinRow });
    await expect(call(api, { transaction_id: T1, payee_name: 'savings' })).rejects.toThrow(/Savings|savings/);
    expect(api.createPayee).not.toHaveBeenCalled();
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown payee_id', async () => {
    const api = api2({ [T1]: leg, [TWIN]: twinRow });
    await expect(call(api, { transaction_id: T1, payee_id: 'eeeeeeee-9999-4999-8999-999999999999' })).rejects.toThrow(/pagador inexistente|unknown payee/);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });
});
