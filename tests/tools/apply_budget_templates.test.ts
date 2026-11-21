import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/apply_budget_templates.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const month = (a: number, b: number) => ({ categoryGroups: [{ categories: [
  { id: 'c1', name: 'Comida', budgeted: a },
  { id: 'c2', name: 'Ocio', budgeted: b },
] }] });

function setup(send: any, ...months: any[]) {
  let i = 0;
  return mockApi({
    getBudgetMonth: async () => months[Math.min(i++, months.length - 1)],
    runQuery: async () => ({ data: [{ id: 'c2', template_settings: { source: 'ui' } }] }),
    internal: { send: vi.fn(send) },
  });
}

describe('apply_budget_templates', () => {
  it('por defecto usa apply-goal-template y lista solo lo cambiado en unidades', async () => {
    const send = async () => ({ type: 'message', message: 'templates-applied', count: 1 });
    const api: any = setup(send, month(0, 500), month(35000, 500));
    const r: any = await tool.handler({ month: '2026-12' }, { api, config: testConfig });
    expect(api.internal.send).toHaveBeenCalledWith('budget/apply-goal-template', { month: '2026-12' });
    expect(r.count).toBe(1);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0]).toMatchObject({ category_id: 'c1', category: 'Comida' });
    expect(r.changed[0].before.amount).toBe(0);
    expect(r.changed[0].after.amount).toBe(350);
    expect(r.ui_template_categories).toEqual(['Ocio']);
    expect(r.warning).toBeTruthy();
  });
  it('overwrite usa overwrite-goal-template', async () => {
    const api: any = setup(async () => ({ type: 'message', message: 'templates-up-to-date' }), month(0, 0));
    const r: any = await tool.handler({ month: '2026-12', overwrite: true }, { api, config: testConfig });
    expect(api.internal.send).toHaveBeenCalledWith('budget/overwrite-goal-template', { month: '2026-12' });
    expect(r.count).toBe(0);
    expect(r.changed).toEqual([]);
  });
  it('errores de plantilla (sticky) → error con el texto pre, sin releer', async () => {
    const api: any = setup(async () => ({ sticky: true, message: 'template-errors', pre: 'Comida: línea rota' }), month(0, 0));
    await expect(tool.handler({ month: '2026-12' }, { api, config: testConfig })).rejects.toThrow('Comida: línea rota');
  });
  it('type error también es error', async () => {
    const api: any = setup(async () => ({ type: 'error', message: 'boom' }), month(0, 0));
    await expect(tool.handler({ month: '2026-12' }, { api, config: testConfig })).rejects.toThrow('boom');
  });
  it('mes con formato incorrecto', async () => {
    const api: any = setup(async () => ({}), month(0, 0));
    await expect(tool.handler({ month: '2026-13' }, { api, config: testConfig })).rejects.toThrow();
    expect(api.internal.send).not.toHaveBeenCalled();
  });
});
