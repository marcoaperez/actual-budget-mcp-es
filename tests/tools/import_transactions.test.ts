import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/import_transactions.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const C1 = 'cccccccc-1111-4111-8111-111111111111';
const C_GHOST = 'cccccccc-9999-4999-8999-999999999999';
const GROUPS = [{ id: 'aaaaaaaa-2222-4222-8222-222222222222', name: 'G', is_income: false, categories: [{ id: C1, name: 'Cat' }] }];
const ACCS = [{ id: A1, name: 'Fondo', closed: false }];
const ROWS = [
  { date: '2026-11-01', amount: 12.34, imported_id: 'fcf-a-2026-11', payee_name: 'Fondo', category_id: C1 },
  { date: '2026-11-02', amount: -5, imported_id: 'fcf-b-2026-11' },
];
const FUZZY_PREVIEW = {
  errors: [], added: ['x'], updated: ['y'],
  updatedPreview: [{ transaction: { imported_id: 'fcf-b-2026-11' }, existing: { id: 'e1', date: '2026-11-03', imported_id: null, payee_name: 'Otro', amount: -5 } }],
};
const mk = (imp: any) => mockApi({ getAccounts: vi.fn(async () => ACCS), getCategoryGroups: vi.fn(async () => GROUPS), importTransactions: imp });
const ctx = (api: any) => ({ api, config: testConfig });

describe('import_transactions', () => {
  it('default call only previews, converts to cents, never reimports deleted', async () => {
    const imp = vi.fn(async () => FUZZY_PREVIEW);
    const api = mk(imp);
    const r: any = await tool.handler({ account_id: A1, transactions: ROWS }, ctx(api));
    expect(imp).toHaveBeenCalledTimes(1);
    expect(imp).toHaveBeenCalledWith(A1, [
      expect.objectContaining({ amount: 1234, imported_id: 'fcf-a-2026-11', payee_name: 'Fondo', category: C1 }),
      expect.objectContaining({ amount: -500, imported_id: 'fcf-b-2026-11' }),
    ], { dryRun: true, reimportDeleted: false, defaultCleared: true });
    expect(r.dry_run).toBe(true);
    expect(r.results.map((x: any) => x.outcome)).toEqual(['add', 'fuzzy']);
    expect(r.results[1].matched).toMatchObject({ id: 'e1', payee: 'Otro', amount: -5 });
    expect(r.totals).toMatchObject({ add: 1, fuzzy: 1 });
  });
  it('real run excludes fuzzy rows without allow_fuzzy', async () => {
    const imp = vi.fn(async (_a: any, _t: any, o: any) => o.dryRun ? FUZZY_PREVIEW : { errors: [], added: ['n'], updated: [], updatedPreview: [] });
    const api = mk(imp);
    const r: any = await tool.handler({ account_id: A1, transactions: ROWS, dry_run: false }, ctx(api));
    expect(imp).toHaveBeenCalledTimes(3);
    const [, rows, opts] = imp.mock.calls[2] as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].imported_id).toBe('fcf-a-2026-11');
    expect(opts).toEqual({ dryRun: false, reimportDeleted: false, defaultCleared: true });
    expect(r.results.map((x: any) => x.outcome)).toEqual(['add', 'skipped_fuzzy']);
    expect(r.results[1].matched.id).toBe('e1');
  });
  it('real run with allow_fuzzy sends both rows', async () => {
    const imp = vi.fn(async (_a: any, _t: any, o: any) => o.dryRun ? FUZZY_PREVIEW : { errors: [], added: [], updated: [], updatedPreview: [] });
    const r: any = await tool.handler({ account_id: A1, transactions: ROWS, dry_run: false, allow_fuzzy: true }, ctx(mk(imp)));
    expect((imp.mock.calls[1] as any[])[1]).toHaveLength(2);
    expect(r.results.map((x: any) => x.outcome)).toEqual(['add', 'fuzzy']);
  });
  it('does not call the real import when no rows remain', async () => {
    const prev = { errors: [], added: [], updated: [], updatedPreview: [{ transaction: { imported_id: 'fcf-b-2026-11' }, existing: { id: 'e1', date: 'd', imported_id: null, payee_name: 'P', amount: -5 } }] };
    const imp = vi.fn(async () => prev);
    await tool.handler({ account_id: A1, transactions: [ROWS[1]], dry_run: false }, ctx(mk(imp)));
    expect(imp).toHaveBeenCalledTimes(1);
  });
  it('classifies update and unchanged', async () => {
    const prev = { errors: [], added: [], updated: ['u'], updatedPreview: [
      { transaction: { imported_id: 'fcf-a-2026-11' }, existing: { id: 'e1', date: 'd', imported_id: 'fcf-a-2026-11', payee_name: 'P', amount: 1 } },
      { transaction: { imported_id: 'fcf-b-2026-11' }, ignored: true },
    ] };
    const r: any = await tool.handler({ account_id: A1, transactions: ROWS }, ctx(mk(vi.fn(async () => prev))));
    expect(r.results.map((x: any) => x.outcome)).toEqual(['update', 'unchanged']);
  });
  it('rejects duplicate imported_id before any call', async () => {
    const imp = vi.fn();
    await expect(tool.handler({ account_id: A1, transactions: [ROWS[0], ROWS[0]] }, ctx(mk(imp)))).rejects.toThrow(/fcf-a-2026-11/);
    expect(imp).not.toHaveBeenCalled();
  });
  it('rejects unknown/closed account and unknown category before any call', async () => {
    const imp = vi.fn();
    const none = mockApi({ importTransactions: imp });
    await expect(tool.handler({ account_id: A1, transactions: ROWS }, ctx(none))).rejects.toThrow(A1);
    const closed = mockApi({ importTransactions: imp, getAccounts: vi.fn(async () => [{ id: A1, name: 'Fondo', closed: true }]) });
    await expect(tool.handler({ account_id: A1, transactions: ROWS }, ctx(closed))).rejects.toThrow(/Fondo/);
    await expect(tool.handler({ account_id: A1, transactions: [{ ...ROWS[0], category_id: C_GHOST }] }, ctx(mk(imp)))).rejects.toThrow(C_GHOST);
    expect(imp).not.toHaveBeenCalled();
  });
  it('rejects when the preview returns errors', async () => {
    const imp = vi.fn(async () => ({ errors: [{ message: 'boom' }], added: [], updated: [], updatedPreview: [] }));
    await expect(tool.handler({ account_id: A1, transactions: ROWS, dry_run: false }, ctx(mk(imp)))).rejects.toThrow(/boom/);
    expect(imp).toHaveBeenCalledTimes(1);
  });
  it('re-previews after dropping a fuzzy row and skips rows that become fuzzy', async () => {
    const fz = (id: string) => ({ transaction: { imported_id: id }, existing: { id: 'e1', date: 'd', imported_id: null, payee_name: 'X', amount: -5 } });
    let n = 0;
    const imp = vi.fn(async (_a: any, _t: any, o: any) => {
      n += 1;
      if (n === 1) return { errors: [], added: ['n'], updated: [], updatedPreview: [fz('fcf-a-2026-11')] };
      if (n === 2) return { errors: [], added: [], updated: [], updatedPreview: [fz('fcf-b-2026-11')] };
      return { errors: [], added: [], updated: [], updatedPreview: [] };
    });
    const r: any = await tool.handler({ account_id: A1, transactions: ROWS, dry_run: false }, ctx(mk(imp)));
    expect(r.results.map((x: any) => x.outcome)).toEqual(['skipped_fuzzy', 'skipped_fuzzy']);
    expect(imp.mock.calls.every((c: any[]) => c[2].dryRun === true)).toBe(true);
  });
  it('warns when the real response differs from the plan', async () => {
    const imp = vi.fn(async (_a: any, _t: any, o: any) => o.dryRun
      ? { errors: [], added: ['x', 'y'], updated: [], updatedPreview: [] }
      : { errors: [], added: ['x'], updated: [], updatedPreview: [] });
    const r: any = await tool.handler({ account_id: A1, transactions: ROWS, dry_run: false }, ctx(mk(imp)));
    expect(r.warning).toMatch(/2 add/);
  });
  it('reports tombstones as kept_deleted', async () => {
    const prev = { errors: [], added: [], updated: [], updatedPreview: [{ transaction: { imported_id: 'fcf-a-2026-11' }, existing: false, tombstone: true }] };
    const r: any = await tool.handler({ account_id: A1, transactions: [ROWS[0]] }, ctx(mk(vi.fn(async () => prev))));
    expect(r.results[0].outcome).toBe('kept_deleted');
  });
});
