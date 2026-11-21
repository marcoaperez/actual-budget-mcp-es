import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/set_transaction_transfer.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const A_SRC = '22222222-2222-4222-8222-222222222222';
const A_DST = '33333333-3333-4333-8333-333333333333';
const A_OTHER = '44444444-4444-4444-8444-444444444444';
const P_DST = '55555555-5555-4555-8555-555555555555';
const LEG = '66666666-6666-4666-8666-666666666666';

const accounts = [{ id: A_SRC, name: 'Checking' }, { id: A_DST, name: 'Savings' }, { id: A_OTHER, name: 'Cash' }];
const payees = [{ id: P_DST, name: 'Savings', transfer_acct: A_DST }];

/** api.runQuery is how getTransactionById/readBack read: return `rows` each time. */
function apiWithRows(rows: any[][], overrides: Record<string, unknown> = {}) {
  let i = 0;
  return mockApi({
    getAccounts: async () => accounts,
    getPayees: async () => payees,
    runQuery: vi.fn(async () => ({ data: rows[Math.min(i++, rows.length - 1)] })),
    ...overrides,
  });
}

const plain = { id: T1, account: A_SRC, date: '2026-05-01', amount: -5000, payee: 'p-old', category: 'c-old', transfer_id: null };
const linked = { ...plain, payee: P_DST, category: null, transfer_id: LEG };

describe('set_transaction_transfer', () => {
  it('points the transaction at the destination transfer payee and echoes the linked leg', async () => {
    const api = apiWithRows([[plain], [linked]]);
    const r: any = await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(api.updateTransaction).toHaveBeenCalledWith(T1, { payee: P_DST });
    expect(r.updated).toBe(true);
    expect(r.transfer_id).toBe(LEG);
    expect(r.transaction.id).toBe(T1);
  });

  it('reports transfer_id null when Actual did not link a counterpart', async () => {
    const api = apiWithRows([[plain], [{ ...plain, payee: P_DST }]]);
    const r: any = await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(r.transfer_id).toBeNull();
  });

  it('rejects a target account with no transfer payee', async () => {
    const api = apiWithRows([[plain]]);
    await expect(tool.handler({ transaction_id: T1, target_account_id: A_OTHER }, { api, config: testConfig }))
      .rejects.toThrow(A_OTHER);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown target account', async () => {
    const unknown = '99999999-9999-4999-8999-999999999999';
    const api = apiWithRows([[plain]]);
    await expect(tool.handler({ transaction_id: T1, target_account_id: unknown }, { api, config: testConfig }))
      .rejects.toThrow(/cuenta inexistente|unknown account/);
  });

  it('rejects transferring a transaction into its own account', async () => {
    const api = apiWithRows([[plain]]);
    await expect(tool.handler({ transaction_id: T1, target_account_id: A_SRC }, { api, config: testConfig }))
      .rejects.toThrow(/distinta|different/);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a missing transaction', async () => {
    const api = apiWithRows([[]]);
    await expect(tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig }))
      .rejects.toThrow(T1);
  });

  it('rejects a split parent — Actual cannot make one a transfer', async () => {
    const api = apiWithRows([[{ ...plain, is_parent: true, subtransactions: [{ id: 'x' }, { id: 'y' }] }]]);
    await expect(tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig }))
      .rejects.toThrow(T1);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('syncs after writing', async () => {
    const api = apiWithRows([[plain], [linked]]);
    await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('avisa de duplicado probable si la cuenta destino se sincroniza con el banco', async () => {
    const syncedAccounts = accounts.map((a) => (a.id === A_DST ? { ...a, balance_current: 1000 } : a));
    const api = apiWithRows([[plain], [linked]], { getAccounts: async () => syncedAccounts });
    const r: any = await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(r.warning).toMatch(/find_transfer_issues/);
  });

  it('no avisa si la cuenta destino se lleva a mano', async () => {
    const api = apiWithRows([[plain], [linked]]);
    const r: any = await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(r.warning).toBeUndefined();
  });

  describe('split parts and category', () => {
    const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const T_CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const A_HIP = '77777777-7777-4777-8777-777777777777';
    const P_HIP = '88888888-8888-4888-8888-888888888888';
    const CUOTAS = '99999999-9999-4999-8999-999999999999';
    const splitAccounts = [
      { id: A_SRC, name: 'Checking', offbudget: false },
      { id: A_DST, name: 'Savings', offbudget: false },
      { id: A_HIP, name: 'Hipoteca', offbudget: true },
    ];
    const splitPayees = [
      { id: P_DST, name: 'Savings', transfer_acct: A_DST },
      { id: P_HIP, name: 'Hipoteca', transfer_acct: A_HIP },
    ];
    const parentRow = { id: PARENT, account: A_SRC, is_parent: true, subtransactions: [{ id: T_CHILD }] };
    const childRow = { id: T_CHILD, account: A_SRC, parent_id: PARENT, is_child: true, amount: -3000, payee: 'p-old', category: 'c-old', transfer_id: null };
    const groups = async () => [{ id: 'g', name: 'G', categories: [{ id: CUOTAS, name: 'Cuotas' }] }];
    // Lecturas: padre agrupado, fila hijo, y re-lecturas del hijo.
    const build = (rows: any[][]) => apiWithRows(rows, {
      getAccounts: async () => splitAccounts,
      getPayees: async () => splitPayees,
      getCategoryGroups: groups,
    });

    it('turns a child into a cross-budget transfer keeping a category', async () => {
      const after = { ...childRow, payee: P_HIP, category: CUOTAS, transfer_id: LEG };
      const api = build([[parentRow], [childRow], [after]]);
      const r: any = await tool.handler({ transaction_id: T_CHILD, target_account_id: A_HIP, category_id: CUOTAS }, { api, config: testConfig });
      expect(api.updateTransaction).toHaveBeenCalledTimes(1);
      expect(api.updateTransaction).toHaveBeenCalledWith(T_CHILD, { payee: P_HIP, category: CUOTAS });
      expect(r.transfer_id).toBe(LEG);
      expect(r.clears_category).toBe(false);
      expect(r.parent_id).toBe(PARENT);
    });

    it('refuses category_id when the target is on the same budget side', async () => {
      const api = build([[parentRow], [childRow]]);
      await expect(tool.handler({ transaction_id: T_CHILD, target_account_id: A_DST, category_id: CUOTAS }, { api, config: testConfig }))
        .rejects.toThrow(/Savings/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('refuses category_id when the side cannot be confirmed', async () => {
      const api = build([[parentRow], [{ ...childRow, account: 'unknown-acc' }]]);
      await expect(tool.handler({ transaction_id: T_CHILD, target_account_id: A_HIP, category_id: CUOTAS }, { api, config: testConfig }))
        .rejects.toThrow(/Hipoteca/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('allows same-side target without category and reports clears_category', async () => {
      const after = { ...childRow, payee: P_DST, category: null, transfer_id: LEG };
      const api = build([[parentRow], [childRow], [after]]);
      const r: any = await tool.handler({ transaction_id: T_CHILD, target_account_id: A_DST }, { api, config: testConfig });
      expect(api.updateTransaction).toHaveBeenCalledWith(T_CHILD, { payee: P_DST });
      expect(r.clears_category).toBe(true);
    });

    it('clears_category is false when the row had no category', async () => {
      const bare = { ...childRow, category: null };
      const after = { ...bare, payee: P_DST, transfer_id: LEG };
      const api = build([[parentRow], [bare], [after]]);
      const r: any = await tool.handler({ transaction_id: T_CHILD, target_account_id: A_DST }, { api, config: testConfig });
      expect(r.clears_category).toBe(false);
    });

    it('still rejects a parent', async () => {
      const api = build([[parentRow]]);
      await expect(tool.handler({ transaction_id: PARENT, target_account_id: A_DST }, { api, config: testConfig }))
        .rejects.toThrow(PARENT);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects the child own account', async () => {
      const api = build([[parentRow], [childRow]]);
      await expect(tool.handler({ transaction_id: T_CHILD, target_account_id: A_SRC }, { api, config: testConfig }))
        .rejects.toThrow(/distinta|different/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects a closed target account', async () => {
      const api = build([[parentRow], [childRow]]);
      (api.getAccounts as any) = async () => splitAccounts.map((a) => (a.id === A_HIP ? { ...a, closed: true } : a));
      await expect(tool.handler({ transaction_id: T_CHILD, target_account_id: A_HIP }, { api, config: testConfig }))
        .rejects.toThrow(/cerrada|closed/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects a category id not in the index', async () => {
      const api = build([[parentRow], [childRow]]);
      const bogus = '12121212-1212-4121-8121-121212121212';
      await expect(tool.handler({ transaction_id: T_CHILD, target_account_id: A_HIP, category_id: bogus }, { api, config: testConfig }))
        .rejects.toThrow(bogus);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('re-pointing a leg moves its twin', () => {
    const TWIN = 'eeeeeeee-1111-4111-8111-111111111111';
    const leg = { ...plain, payee: P_DST, category: null, transfer_id: TWIN };
    const twinOk = { id: TWIN, account: A_DST, amount: 5000, transfer_id: T1, is_child: false, parent_id: null, imported_id: null, reconciled: false };
    const P_OTHER = 'ffffffff-1111-4111-8111-111111111111';
    const withOther = { getPayees: async () => [...payees, { id: P_OTHER, name: 'Cash', transfer_acct: A_OTHER }] };
    function byId(twin: any, afterLeg: any = { ...leg, payee: P_OTHER }) {
      let legReads = 0;
      return mockApi({
        getAccounts: async () => accounts,
        ...withOther,
        runQuery: vi.fn(async (q: any) => {
          const id = q.calls.filter?.[0]?.id;
          if (id === T1) { legReads += 1; return { data: [legReads === 1 ? leg : afterLeg] }; }
          return { data: id === TWIN && twin ? [twin] : [] };
        }),
      });
    }
    it.each([
      ['a split part', { is_child: true, parent_id: 'pp' }, false],
      ['reconciled', { reconciled: true }, true],
      ['a bank import', { imported_id: 'bank-1' }, true],
    ])('refuses when the twin is %s', async (_n, patch, forceable) => {
      const api = byId({ ...twinOk, ...patch });
      await expect(tool.handler({ transaction_id: T1, target_account_id: A_OTHER }, { api, config: testConfig }))
        .rejects.toThrow(new RegExp(TWIN));
      expect(api.updateTransaction).not.toHaveBeenCalled();
      // force salta reconciliada/importada, nunca una parte de split
      const api2 = byId({ ...twinOk, ...patch });
      const p = tool.handler({ transaction_id: T1, target_account_id: A_OTHER, force: true }, { api: api2, config: testConfig });
      if (forceable) { await p; expect(api2.updateTransaction).toHaveBeenCalledTimes(1); }
      else { await expect(p).rejects.toThrow(new RegExp(TWIN)); expect(api2.updateTransaction).not.toHaveBeenCalled(); }
    });
    it('re-points when the twin is a plain manual row', async () => {
      const api = byId(twinOk);
      await tool.handler({ transaction_id: T1, target_account_id: A_OTHER }, { api, config: testConfig });
      expect(api.updateTransaction).toHaveBeenCalledWith(T1, { payee: P_OTHER });
    });
  });
});
