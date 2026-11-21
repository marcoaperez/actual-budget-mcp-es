import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/split_transaction.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

// Los ids de entrada se validan como UUID (ID en src/core/types.ts).
const T1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'cccccccc-1111-4111-8111-111111111111';
const C2 = 'cccccccc-2222-4222-8222-222222222222';
const C_GHOST = 'cccccccc-0000-4000-8000-000000000000';
const SCH1 = 'dddddddd-1111-4111-8111-111111111111';

// Grupos de categorías del presupuesto: sólo C1 y C2 existen.
const GROUPS = [{ id: 'g1', name: 'Gastos', is_income: false, categories: [
  { id: C1, name: 'Alimentacion' }, { id: C2, name: 'Ocio' },
] }];

const original = { id: T1, date: '2026-07-10', account: 'a1', payee: 'p1', amount: -18000, notes: 'super', cleared: true, transfer_id: null, is_parent: false };
const asSplit = { ...original, is_parent: true, subtransactions: [
  { amount: -12000, category: C1 }, { amount: -6000, category: C2 },
] };

/** Primera lectura (pre-check) devuelve `orig`; toda lectura posterior (readBackSplit) devuelve
 * `after` — igual que el servidor real una vez aplicado el update. */
function apiForSplit(orig: Record<string, unknown> = original, after: Record<string, unknown> = asSplit) {
  let call = 0;
  return mockApi({
    getCategoryGroups: vi.fn(async () => GROUPS),
    runQuery: vi.fn(async () => {
      call += 1;
      return { data: [call === 1 ? orig : after] };
    }),
  });
}

describe('split_transaction', () => {
  it('updates the transaction in place with subtransactions, echoes the split', async () => {
    const api = apiForSplit();
    const r: any = await tool.handler(
      { transaction_id: T1, splits: [
        { amount: -120, category_id: C1 },
        { amount: -60, category_id: C2 },
      ] },
      { api, config: testConfig },
    );
    expect(api.updateTransaction).toHaveBeenCalledWith(T1, {
      subtransactions: [
        { amount: -12000, category: C1 },
        { amount: -6000, category: C2 },
      ],
    });
    expect(api.addTransactions).not.toHaveBeenCalled();
    expect(api.deleteTransaction).not.toHaveBeenCalled();
    expect(r).toMatchObject({ split: true, original_id: T1 });
    expect(r.transaction.id).toBe(T1);
    expect(r.transaction.splits).toHaveLength(2);
  });

  it('rejects when parts do not sum to the total, reporting the difference', async () => {
    const api = mockApi({ runQuery: async () => ({ data: [original] }) });
    await expect(tool.handler(
      { transaction_id: T1, splits: [{ amount: -120, category_id: C1 }, { amount: -50, category_id: C2 }] },
      { api, config: testConfig },
    )).rejects.toThrow(/-10|10,00|difieren/i);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('reports "sobran" when the parts overshoot the total', async () => {
    const positive = { ...original, amount: 18000 };
    const api = mockApi({ runQuery: async () => ({ data: [positive] }) });
    await expect(tool.handler(
      { transaction_id: T1, splits: [{ amount: 120, category_id: C1 }, { amount: 70, category_id: C2 }] },
      { api, config: testConfig },
    )).rejects.toThrow(/sobran/i);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('adjust_last computes the remainder server-side', async () => {
    const api = apiForSplit();
    await tool.handler(
      { transaction_id: T1, adjust_last: true, splits: [
        { amount: -120, category_id: C1 },
        { amount: 0, category_id: C2 },
      ] },
      { api, config: testConfig },
    );
    const sent = (api.updateTransaction as any).mock.calls[0][1].subtransactions;
    expect(sent[1].amount).toBe(-6000); // -18000 - (-12000)
  });

  it('refuses a transaction that is already split -- an in-place update would silently overwrite its existing parts', async () => {
    const alreadySplit = { ...original, is_parent: true, subtransactions: [
      { amount: -12000, category: C1 }, { amount: -6000, category: C2 },
    ] };
    const api = mockApi({ runQuery: async () => ({ data: [alreadySplit] }) });
    await expect(tool.handler(
      { transaction_id: T1, splits: [{ amount: -90, category_id: C1 }, { amount: -90, category_id: C2 }] },
      { api, config: testConfig },
    )).rejects.toThrow(/dividida|already split/i);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a well-formed but non-existent category in any part, before writing', async () => {
    const api = mockApi({
      getCategoryGroups: async () => GROUPS,
      runQuery: async () => ({ data: [original] }),
    });
    await expect(tool.handler(
      { transaction_id: T1, splits: [
        { amount: -120, category_id: C1 },
        { amount: -60, category_id: C_GHOST },
      ] },
      { api, config: testConfig },
    )).rejects.toThrow(C_GHOST);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('sends only { subtransactions } -- imported_id/imported_payee/schedule/reconciled are never read or touched', async () => {
    const withMetadata = { ...original, imported_id: 'imp-1', imported_payee: 'MERCADONA S.A.', schedule: SCH1, reconciled: true };
    const api = apiForSplit(withMetadata, { ...withMetadata, is_parent: true, subtransactions: asSplit.subtransactions });
    await tool.handler(
      { transaction_id: T1, force: true, splits: [
        { amount: -120, category_id: C1 },
        { amount: -60, category_id: C2 },
      ] },
      { api, config: testConfig },
    );
    // toHaveBeenCalledWith compara el segundo argumento por igualdad profunda: si el payload
    // llevara imported_id/schedule/reconciled, esta aserción fallaría.
    expect(api.updateTransaction).toHaveBeenCalledWith(T1, {
      subtransactions: [
        { amount: -12000, category: C1 },
        { amount: -6000, category: C2 },
      ],
    });
  });

  it('propagates the error from updateTransaction, with no cleanup step to run', async () => {
    const api = mockApi({
      getCategoryGroups: async () => GROUPS,
      runQuery: async () => ({ data: [original] }),
      updateTransaction: vi.fn(async () => { throw new Error('server exploded'); }),
    });
    await expect(tool.handler(
      { transaction_id: T1, splits: [
        { amount: -120, category_id: C1 },
        { amount: -60, category_id: C2 },
      ] },
      { api, config: testConfig },
    )).rejects.toThrow('server exploded');
  });

  it('refuses to split a reconciled transaction unless forced', async () => {
    const api = apiForSplit({ ...original, reconciled: true });
    await expect(tool.handler(
      { transaction_id: T1, splits: [
        { amount: -120, category_id: C1 },
        { amount: -60, category_id: C2 },
      ] },
      { api, config: testConfig },
    )).rejects.toThrow(/conciliad/i);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('reports echo_pending when the split is not yet reflected after writing', async () => {
    const api = mockApi({
      getCategoryGroups: async () => GROUPS,
      runQuery: vi.fn(async () => ({ data: [original] })), // siempre devuelve la fila sin dividir
    });
    const r: any = await tool.handler(
      { transaction_id: T1, splits: [
        { amount: -120, category_id: C1 },
        { amount: -60, category_id: C2 },
      ] },
      { api, config: testConfig },
    );
    expect(r.echo_pending).toBe(true);
  });

  describe('transfer parts and transfer originals', () => {
    const CHK = 'aaaaaaaa-1111-4111-8111-111111111111'; // on-budget (a1 del original)
    const HIP = 'aaaaaaaa-2222-4222-8222-222222222222'; // off-budget
    const SAV = 'aaaaaaaa-3333-4333-8333-333333333333'; // on-budget
    const OLD = 'aaaaaaaa-4444-4444-8444-444444444444'; // cerrada
    const GHOST = 'aaaaaaaa-0000-4000-8000-000000000000';
    const P_HIP = 'pppppppp-2222-4222-8222-222222222222';
    const P_SAV = 'pppppppp-3333-4333-8333-333333333333';
    const P_OLD = 'pppppppp-4444-4444-8444-444444444444';
    const P_CHK = 'pppppppp-1111-4111-8111-111111111111';
    const P_BANK = 'pppppppp-5555-4555-8555-555555555555';
    const TWIN = 'bbbbbbbb-1111-4111-8111-111111111111';

    const ACCOUNTS = [
      { id: CHK, name: 'Checking', offbudget: false, closed: false },
      { id: HIP, name: 'Hipoteca Ampliación', offbudget: true, closed: false },
      { id: SAV, name: 'Savings', offbudget: false, closed: false },
      { id: OLD, name: 'Old', offbudget: true, closed: true },
    ];
    const PAYEES = [
      { id: P_HIP, name: 'Transfer: Hipoteca', transfer_acct: HIP },
      { id: P_SAV, name: 'Transfer: Savings', transfer_acct: SAV },
      { id: P_OLD, name: 'Transfer: Old', transfer_acct: OLD },
      { id: P_CHK, name: 'Transfer: Checking', transfer_acct: CHK },
      { id: P_BANK, name: 'Banco Sabadell', transfer_acct: null },
    ];
    const mortgage = { ...original, account: CHK, amount: -80000 };
    const mortgageSplit = { ...mortgage, is_parent: true, subtransactions: [
      { amount: -60000, category: C1, payee: P_HIP, transfer_id: 'tw-1' }, { amount: -20000, category: C2 },
    ] };

    /** Enruteo por id: cada runQuery lee el id del filtro del builder. */
    function apiById(rows: Record<string, any>, afterOrig?: any) {
      let origReads = 0;
      return mockApi({
        getCategoryGroups: vi.fn(async () => GROUPS),
        getAccounts: vi.fn(async () => ACCOUNTS),
        getPayees: vi.fn(async () => PAYEES),
        runQuery: vi.fn(async (q: any) => {
          const id = q.calls.filter?.[0]?.id;
          if (id === T1 && afterOrig) { origReads += 1; return { data: [origReads === 1 ? rows[T1] : afterOrig] }; }
          return { data: rows[id] ? [rows[id]] : [] };
        }),
      });
    }
    const ctx = (api: any) => ({ api, config: testConfig });

    it('mortgage case: transfer part with category crossing budget sides, one updateTransaction', async () => {
      const api = apiById({ [T1]: mortgage }, mortgageSplit);
      const r: any = await tool.handler(
        { transaction_id: T1, splits: [
          { amount: -600, transfer_account_id: HIP, category_id: C1 },
          { amount: -200, category_id: C2 },
        ] }, ctx(api));
      expect(api.updateTransaction).toHaveBeenCalledTimes(1);
      expect(api.updateTransaction).toHaveBeenCalledWith(T1, { subtransactions: [
        { amount: -60000, category: C1, payee: P_HIP },
        { amount: -20000, category: C2 },
      ] });
      expect(r.echo_pending).toBeUndefined();
      expect(r.transaction.splits[0]).toMatchObject({ payee: P_HIP, transfer_id: 'tw-1' });
      expect(r.replaced_twin_id).toBeUndefined();
    });

    it('allows a crossing transfer part without category', async () => {
      const api = apiById({ [T1]: mortgage }, mortgageSplit);
      await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP },
        { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect(api.updateTransaction).toHaveBeenCalledWith(T1, { subtransactions: [
        { amount: -60000, category: null, payee: P_HIP },
        { amount: -20000, category: C2 },
      ] });
    });

    it('rejects a part with neither category nor transfer, naming the part, before writing', async () => {
      const api = apiById({ [T1]: mortgage });
      await expect(tool.handler({ transaction_id: T1, splits: [
        { amount: -600, category_id: C1 }, { amount: -200 },
      ] }, ctx(api))).rejects.toThrow(/2/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects a same-side transfer part that carries a category', async () => {
      const api = apiById({ [T1]: mortgage });
      await expect(tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: SAV, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api))).rejects.toThrow(/Savings/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects a transfer part whose side cannot be confirmed when it carries a category', async () => {
      const api = apiById({ [T1]: { ...mortgage, account: 'zz' } });
      await expect(tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api))).rejects.toThrow();
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects a transfer part to the own account, to an unknown account and to a closed account', async () => {
      for (const [acct, re] of [[CHK, /propia|own/i], [GHOST, new RegExp(GHOST)], [OLD, /cerrada|closed/i]] as const) {
        const api = apiById({ [T1]: mortgage });
        await expect(tool.handler({ transaction_id: T1, splits: [
          { amount: -600, transfer_account_id: acct }, { amount: -200, category_id: C2 },
        ] }, ctx(api))).rejects.toThrow(re);
        expect(api.updateTransaction).not.toHaveBeenCalled();
      }
    });

    const transferOrig = { ...mortgage, transfer_id: TWIN, payee: P_HIP, imported_payee: ' banco sabadell ' };
    const twinManual = { id: TWIN, account: HIP, amount: 80000, transfer_id: T1, imported_id: null, reconciled: false, is_child: false, parent_id: null };

    it('splits an existing transfer whose twin is manual: replaced_twin_id and parent payee from imported_payee, same call', async () => {
      const api = apiById({ [T1]: transferOrig, [TWIN]: twinManual }, { ...mortgageSplit, transfer_id: null, payee: P_BANK });
      const r: any = await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect(api.updateTransaction).toHaveBeenCalledTimes(1);
      expect(api.updateTransaction).toHaveBeenCalledWith(T1, {
        payee: P_BANK,
        subtransactions: [
          { amount: -60000, category: C1, payee: P_HIP },
          { amount: -20000, category: C2 },
        ],
      });
      expect(r).toMatchObject({ replaced_twin_id: TWIN, parent_payee_id: P_BANK });
    });

    it('a dangling transfer payee on the original (no transfer_id) is replaced on the parent too', async () => {
      const dangling = { ...mortgage, payee: P_HIP, transfer_id: null, imported_payee: 'Banco Sabadell' };
      const api = apiById({ [T1]: dangling }, mortgageSplit);
      const r: any = await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect((api.updateTransaction as any).mock.calls[0][1].payee).toBe(P_BANK);
      expect(r.parent_payee_id).toBe(P_BANK);
      expect(r.replaced_twin_id).toBeUndefined();
    });

    it('a normal payee on the original is left alone (no parent payee written)', async () => {
      const api = apiById({ [T1]: mortgage }, mortgageSplit);
      await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP }, { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect((api.updateTransaction as any).mock.calls[0][1]).not.toHaveProperty('payee');
    });

    it('echo parts carry id, and transfer parts carry transfer_account_id', async () => {
      const after = { ...mortgageSplit, subtransactions: [
        { id: 'part-1', amount: -60000, category: C1, payee: P_HIP, transfer_id: 'tw-1' },
        { id: 'part-2', amount: -20000, category: C2 },
      ] };
      const api = apiById({ [T1]: mortgage }, after);
      const r: any = await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect(r.transaction.splits[0]).toMatchObject({ id: 'part-1', transfer_account_id: HIP });
      expect(r.transaction.splits[1].id).toBe('part-2');
      expect(r.transaction.splits[1]).not.toHaveProperty('transfer_account_id');
    });

    it('sets the parent payee to null when no existing payee matches imported_payee (never creates one)', async () => {
      const api = apiById({ [T1]: { ...transferOrig, imported_payee: 'Nadie' }, [TWIN]: twinManual }, mortgageSplit);
      const r: any = await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect((api.updateTransaction as any).mock.calls[0][1].payee).toBeNull();
      expect(r.parent_payee_id).toBeNull();
      expect(api.createPayee).not.toHaveBeenCalled();
    });

    it.each([
      ['reconciled', { reconciled: true }],
      ['imported', { imported_id: 'bank-9' }],
      ['split part', { is_child: true, parent_id: 'zzz' }],
    ])('refuses when the twin is %s, even with force, before writing', async (_n, patch) => {
      const api = apiById({ [T1]: transferOrig, [TWIN]: { ...twinManual, ...patch } });
      await expect(tool.handler({ transaction_id: T1, force: true, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api))).rejects.toThrow(new RegExp(TWIN));
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('refuses a child id naming the parent', async () => {
      const api = mockApi({ getCategoryGroups: async () => GROUPS,
        runQuery: async () => ({ data: [{ ...asSplit, id: 'parent-1' }] }) });
      await expect(tool.handler({ transaction_id: T1, splits: [
        { amount: -90, category_id: C1 }, { amount: -90, category_id: C2 },
      ] }, ctx(api))).rejects.toThrow(/parent-1/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    });

    it('is not settled until every transfer part has transfer_id', async () => {
      const noTwin = { ...mortgageSplit, subtransactions: [
        { amount: -60000, category: C1, payee: P_HIP }, { amount: -20000, category: C2 },
      ] };
      const api = apiById({ [T1]: mortgage }, noTwin);
      const r: any = await tool.handler({ transaction_id: T1, splits: [
        { amount: -600, transfer_account_id: HIP, category_id: C1 }, { amount: -200, category_id: C2 },
      ] }, ctx(api));
      expect(r.echo_pending).toBe(true);
    });
  });
});
