import { describe, it, expect } from 'vitest';
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
});
