import { describe, it, expect } from 'vitest';
import { tool } from '../../src/tools/get_category_note.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const C1 = '11111111-1111-4111-8111-111111111111';
const groups = [{ id: 'g1', name: 'Comida', is_income: false, categories: [{ id: C1, name: 'Alimentacion' }] }];
const mk = (source: string) => mockApi({
  getCategoryGroups: async () => groups,
  getNote: async () => ({ id: C1, note: 'x\n#template 350' }),
  runQuery: async () => ({ data: [{ id: C1, template_settings: { source } }] }),
});

describe('get_category_note', () => {
  it('avisa si la categoría usa plantillas de interfaz y la nota tiene #template', async () => {
    const r: any = await tool.handler({ category_id: C1 }, { api: mk('ui'), config: testConfig });
    expect(r).toMatchObject({ category_name: 'Alimentacion', template_source: 'ui', template_lines: ['#template 350'] });
    expect(r.warning).toContain('Alimentacion');
  });
  it('sin aviso con origen notes', async () => {
    const r: any = await tool.handler({ category_id: C1 }, { api: mk('notes'), config: testConfig });
    expect(r.template_source).toBe('notes');
    expect(r.warning).toBeUndefined();
  });
});
