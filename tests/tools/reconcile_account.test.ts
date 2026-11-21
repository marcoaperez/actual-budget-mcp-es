import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/reconcile_account.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';
import { dateRange } from '../../src/core/aql.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function apiWith(opts: { balance: number; reconciledSum?: number; rows?: any[] }) {
  return mockApi({
    getAccounts: async () => [{ id: A, name: 'BBVA Nómina', balance_current: 1 }, { id: B, name: 'ING', balance_current: 1 }],
    getPayees: async () => [],
    getAccountBalance: vi.fn(async () => opts.balance),
    runQuery: vi.fn(async (q: any) => {
      if (q.calls.calculate) return { data: opts.reconciledSum ?? 0 };
      if (q.calls.filter?.[0]?.transfer_id) return { data: [] };
      return { data: opts.rows ?? [] };
    }),
  });
}

describe('reconcile_account', () => {
  it('cuadra: diferencia cero, sugiere mark_reconciled y no propone nada', async () => {
    const api = apiWith({ balance: 123456, reconciledSum: 100000 });
    const r: any = await tool.handler({ account: 'bbva nomina', bank_balance: 1234.56, date: '2026-09-30' }, { api, config: testConfig });
    expect(r.account).toEqual({ id: A, name: 'BBVA Nómina' });
    expect(r.matches).toBe(true);
    expect(r.difference.amount).toBe(0);
    expect(r.reconciled_balance.amount).toBe(1000);
    expect(r.next_step).toMatch(/mark_reconciled/);
    expect(r.proposals).toEqual([]);
  });

  it('pide el saldo al cierre del día (mediodía local de la fecha)', async () => {
    const api = apiWith({ balance: 0 });
    await tool.handler({ account: A, bank_balance: 0, date: '2026-09-30' }, { api, config: testConfig });
    const [id, cutoff] = (api.getAccountBalance as any).mock.calls[0];
    expect(id).toBe(A);
    expect([cutoff.getFullYear(), cutoff.getMonth() + 1, cutoff.getDate()]).toEqual([2026, 9, 30]);
  });

  it('no cuadra: devuelve la diferencia, las propuestas de esa cuenta y las pistas por importe', async () => {
    const rows = [
      { id: 'x', account: A, date: '2026-09-15', amount: -10000, imported_id: 'i1' },
      { id: 'y', account: B, date: '2026-09-15', amount: 10000, imported_id: 'i2' },
      { id: 'dup', account: A, date: '2026-09-20', amount: -2500 },
      { id: 'later', account: A, date: '2026-10-05', amount: -2500 },
    ];
    // banco 1000,00 y Actual 975,00 → diferencia +25,00 → sobra en Actual un movimiento de -25,00
    const api = apiWith({ balance: 97500, rows });
    const r: any = await tool.handler({ account: 'BBVA Nómina', bank_balance: 1000, date: '2026-09-30' }, { api, config: testConfig });
    expect(r.matches).toBe(false);
    expect(r.difference.amount).toBe(25);
    expect(r.proposals.map((p: any) => p.operation.type)).toEqual(['link']);
    expect(r.hints.map((h: any) => h.id)).toEqual(['dup']);
    expect(r.hints[0].note).toBeTruthy();
  });

  it('lee con margen de 2 × LINK_MAX_DAYS y avisa en la descripción de la ventana de 90 días', async () => {
    const api = apiWith({ balance: 97500, rows: [] });
    await tool.handler({ account: A, bank_balance: 1000, date: '2026-09-30' }, { api, config: testConfig });
    const q = (api.q as any).mock.results.map((r: any) => r.value).find((v: any) => v.calls.filter?.[0]?.$and);
    expect(q.calls.filter[0]).toEqual(dateRange('2026-06-26', '2026-10-06'));
    expect(tool.description).toMatch(/90 days before date/);
  });

  it('falla con un mensaje útil si la cuenta no existe', async () => {
    await expect(tool.handler({ account: 'Revolut', bank_balance: 1, date: '2026-09-30' }, { api: apiWith({ balance: 0 }), config: testConfig }))
      .rejects.toThrow(/Revolut.*BBVA Nómina/);
  });
});
