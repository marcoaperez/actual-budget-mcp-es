import { getCategoryIndex } from '../core/categories.js';
import { templateLines, templateSources } from '../core/templates.js';
import { z } from 'zod';
import { ID, type ToolDef } from '../core/types.js';
import { msg } from '../core/messages.js';

const input = {
  category_id: ID.describe('Category UUID (from get_categories)'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'get_category_note',
  title: 'Get category note',
  description: 'Read the note of a category, the #template/#goal lines in it and whether the category takes its budget template from the note or from the template UI (UI categories ignore note templates; templates are experimental in Actual 26.11).',
  readOnly: true,
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const cat = (await getCategoryIndex(api)).get(a.category_id);
    if (!cat) throw new Error(m.categoryNotFound(a.category_id));
    const note: string | null = ((await api.getNote(a.category_id)) as any)?.note ?? null;
    const source = (await templateSources(api)).get(a.category_id) ?? 'notes';
    const lines = templateLines(note);
    return {
      category_id: a.category_id,
      category_name: cat.name,
      note,
      template_source: source,
      template_lines: lines,
      ...(source === 'ui' && lines.length > 0 ? { warning: m.uiTemplateIgnoresNote(cat.name) } : {}),
    };
  },
};
