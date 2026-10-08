import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { tool } from '../../src/tools/apply_reconciliation_fixes.js';
import { testConfig } from '../helpers/mock-api.js';
import { fakeLedger } from '../helpers/fake-ledger.js';

const X = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const IMP = '33333333-3333-4333-8333-333333333333';
const MAN = '44444444-4444-4444-8444-444444444444';
const accounts = [{ id: 'A', name: 'BBVA' }, { id: 'B', name: 'ING' }];
const rows = [
  { id: X, account: 'A', date: '2026-09-15', amount: -10000, imported_id: 'ix' },
  { id: Y, account: 'B', date: '2026-09-15', amount: 10000, imported_id: 'iy' },
  { id: IMP, account: 'B', date: '2026-09-15', amount: 2500, imported_id: 'ib' },
  { id: MAN, account: 'B', date: '2026-09-15', amount: 2500 },
];

describe('apply_reconciliation_fixes', () => {
  it('aplica cada operación, informa de cada una y sincroniza antes de revalidar y después de escribir', async () => {
    const { api, db } = fakeLedger({ accounts, rows });
    const r: any = await tool.handler({ operations: [
      { type: 'link', a: X, b: Y },
      { type: 'merge', keep: IMP, drop: MAN },
    ] }, { api, config: testConfig });
    expect(r.results.map((x: any) => x.status)).toEqual(['aplicada', 'aplicada']);
    expect(r).toMatchObject({ applied: 2, skipped: 0, failed: 0 });
    expect(db.get(X).transfer_id).toBe(Y);
    expect(db.has(MAN)).toBe(false);
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('una operación omitida no detiene las demás', async () => {
    const { api } = fakeLedger({ accounts, rows: rows.map((r) => (r.id === X ? { ...r, reconciled: true } : r)) });
    const r: any = await tool.handler({ operations: [
      { type: 'link', a: X, b: Y },
      { type: 'merge', keep: IMP, drop: MAN },
    ] }, { api, config: testConfig });
    expect(r.results.map((x: any) => x.status)).toEqual(['omitida', 'aplicada']);
    expect(r).toMatchObject({ applied: 1, skipped: 1, failed: 0 });
  });

  it('avisa si la sincronización final falla, sin dar la escritura por perdida', async () => {
    const { api } = fakeLedger({ accounts, rows });
    api.sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    const r: any = await tool.handler({ operations: [{ type: 'merge', keep: IMP, drop: MAN }] }, { api, config: testConfig });
    expect(r.applied).toBe(1);
    expect(r.sync_pending).toBe(true);
    expect(r.note).toMatch(/offline/);
  });

  it('rechaza una lista vacía, de más de 50 o con operaciones mal formadas', async () => {
    const { api } = fakeLedger({ accounts, rows });
    await expect(tool.handler({ operations: [] }, { api, config: testConfig })).rejects.toBeInstanceOf(ZodError);
    const many = Array.from({ length: 51 }, () => ({ type: 'merge', keep: IMP, drop: MAN }));
    await expect(tool.handler({ operations: many }, { api, config: testConfig })).rejects.toBeInstanceOf(ZodError);
    await expect(tool.handler({ operations: [{ type: 'link', a: 'x', b: Y }] }, { api, config: testConfig })).rejects.toBeInstanceOf(ZodError);
  });

  it('si la sincronización inicial falla, rechaza y no escribe nada', async () => {
    const { api } = fakeLedger({ accounts, rows });
    api.sync.mockRejectedValueOnce(new Error('offline'));
    await expect(tool.handler({ operations: [{ type: 'merge', keep: IMP, drop: MAN }] }, { api, config: testConfig })).rejects.toThrow(/offline/);
    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(api.mergeTransactions).not.toHaveBeenCalled();
  });

  it('es una tool de escritura', () => {
    expect(tool.readOnly).toBe(false);
  });
});
