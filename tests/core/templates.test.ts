import { describe, it, expect, vi } from 'vitest';
import { templateLines, templateSources, sendInternal } from '../../src/core/templates.js';
import { mockApi } from '../helpers/mock-api.js';

describe('templateLines', () => {
  it('detecta #template y #goal desde la primera #', () => {
    expect(templateLines('Comida\n#template 350\n  #goal 1000\nnota')).toEqual(['#template 350', '#goal 1000']);
  });
  it('null o sin líneas → []', () => {
    expect(templateLines(null)).toEqual([]);
    expect(templateLines('solo una #nota')).toEqual([]);
  });
});

describe('templateSources', () => {
  it('mapea objeto, cadena JSON y null', async () => {
    const api = mockApi({
      runQuery: async () => ({ data: [
        { id: 'a', template_settings: { source: 'ui' } },
        { id: 'b', template_settings: '{"source":"ui"}' },
        { id: 'c', template_settings: null },
        { id: 'd', template_settings: { source: 'notes' } },
      ] }),
    });
    const m = await templateSources(api);
    expect([m.get('a'), m.get('b'), m.get('c'), m.get('d')]).toEqual(['ui', 'ui', 'notes', 'notes']);
  });
});

describe('sendInternal', () => {
  it('lanza si api.internal no existe', async () => {
    await expect(sendInternal({ internal: null }, 'x', {})).rejects.toThrow(/interna/i);
  });
  it('usa default.internal cuando el export con nombre es la instantánea nula del ESM', async () => {
    // Node ESM copia los exports de un módulo CJS al importarlo: `internal` queda en null aunque
    // después se abra el presupuesto; la copia viva está en `default.internal` (verificado en Actual 26.11).
    const send = vi.fn().mockResolvedValue({ count: 1 });
    const live = { send };
    const out = await sendInternal({ internal: null, default: { internal: live } }, 'x', { month: '2026-12' });
    expect(out).toEqual({ count: 1 });
    expect(send).toHaveBeenCalledWith('x', { month: '2026-12' });
    expect(send.mock.contexts[0]).toBe(live);
  });
});
