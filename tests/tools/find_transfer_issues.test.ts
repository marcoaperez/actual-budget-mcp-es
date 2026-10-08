import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/find_transfer_issues.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function apiWith(rows: any[]) {
  return mockApi({
    getAccounts: async () => [{ id: A, name: 'BBVA', balance_current: 1 }, { id: B, name: 'ING', balance_current: 1 }],
    getPayees: async () => [],
    runQuery: vi.fn(async (q: any) => ({ data: q.calls.filter?.[0]?.transfer_id ? [] : rows })),
  });
}

const x = { id: 'x', account: A, date: '2026-09-15', amount: -10000, imported_id: 'i1' };
const y = { id: 'y', account: B, date: '2026-09-16', amount: 10000, imported_id: 'i2' };

describe('find_transfer_issues', () => {
  it('agrupa las propuestas por tipo y cuenta las de alta', async () => {
    const r: any = await tool.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, { api: apiWith([x, y]), config: testConfig });
    expect(r.start_date).toBe('2026-09-01');
    expect(r.proposals.link).toHaveLength(1);
    expect(r.proposals.link[0].operation).toEqual({ type: 'link', a: 'x', b: 'y' });
    expect(r.proposals.link[0].transactions[0]).toMatchObject({ id: 'x', amount: -100 });
    expect(r.proposals.merge).toEqual([]);
    expect(r.total_count).toBe(1);
    expect(r.alta_count).toBe(1);
  });

  it('lee con margen de LINK_MAX_DAYS a cada lado y descarta propuestas fuera del rango', async () => {
    const api = apiWith([{ ...x, date: '2026-08-30' }, { ...y, date: '2026-08-31' }]);
    const r: any = await tool.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, { api, config: testConfig });
    const firstQuery = (api.q as any).mock.results[0].value;
    expect(firstQuery.calls.filter[0]).toEqual({ date: { $gte: '2026-08-29', $lte: '2026-10-03' } });
    expect(r.total_count).toBe(0);
  });

  it('por defecto revisa los últimos 90 días hasta hoy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 8, 10, 0));
    try {
      const r: any = await tool.handler({}, { api: apiWith([]), config: testConfig });
      expect(r.end_date).toBe('2026-10-08');
      expect(r.start_date).toBe('2026-07-10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('filtra por cuentas y rechaza una cuenta inexistente', async () => {
    const r: any = await tool.handler({ start_date: '2026-09-01', end_date: '2026-09-30', account_ids: [B] }, { api: apiWith([x, y]), config: testConfig });
    expect(r.total_count).toBe(1); // la pareja toca B
    const unknown = '99999999-9999-4999-8999-999999999999';
    await expect(tool.handler({ account_ids: [unknown] }, { api: apiWith([]), config: testConfig })).rejects.toThrow(unknown);
  });
});
