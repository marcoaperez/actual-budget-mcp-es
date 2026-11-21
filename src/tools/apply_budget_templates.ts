import { z } from 'zod';
import { moneyFields } from '../core/money.js';
import { sendInternal, templateSources } from '../core/templates.js';
import type { ToolDef } from '../core/types.js';
import { activeMessages, msg } from '../core/messages.js';

const input = {
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: () => activeMessages().monthFormat }),
  overwrite: z.boolean().default(false).describe('false: only fill categories with no budget; true: recompute and overwrite every category with a template'),
};
const schema = z.object(input);

/** Presupuestado por categoría (céntimos) a partir de getBudgetMonth. */
function budgetedMap(month: any): Map<string, { name: string; budgeted: number }> {
  const out = new Map<string, { name: string; budgeted: number }>();
  for (const g of month?.categoryGroups ?? []) {
    for (const c of g.categories ?? []) out.set(c.id, { name: c.name, budgeted: c.budgeted ?? 0 });
  }
  return out;
}

export const tool: ToolDef = {
  name: 'apply_budget_templates',
  title: 'Apply budget templates',
  description: 'Run the budget templates (#template / #goal lines in category notes) for a month. By default only categories with no budget are filled; overwrite: true recomputes all of them. Experimental in Actual 26.11: categories defined with the template UI ignore note templates. Returns what changed (units); template errors are reported and nothing is written.',
  readOnly: false,
  annotations: { destructiveHint: true, idempotentHint: false },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const fmt = (c: number) => moneyFields(c, config.locale, config.currency);
    const before = budgetedMap(await api.getBudgetMonth(a.month));
    const result = await sendInternal(
      api,
      a.overwrite ? 'budget/overwrite-goal-template' : 'budget/apply-goal-template',
      { month: a.month },
    );
    if (result?.type === 'error' || result?.sticky === true) {
      throw new Error(m.templateErrors(result.pre ?? result.message));
    }
    const after = budgetedMap(await api.getBudgetMonth(a.month));
    const changed = [];
    for (const [id, { name, budgeted }] of after) {
      const prev = before.get(id)?.budgeted ?? 0;
      if (prev !== budgeted) {
        changed.push({ category_id: id, category: name, before: fmt(prev), after: fmt(budgeted) });
      }
    }
    const sources = await templateSources(api);
    const uiNames = [...after].filter(([id]) => sources.get(id) === 'ui').map(([, v]) => v.name);
    return {
      month: a.month,
      overwrite: a.overwrite,
      count: result?.count ?? 0,
      changed,
      ui_template_categories: uiNames,
      ...(uiNames.length > 0 ? { warning: m.uiTemplateIgnoresNote(uiNames.join(', ')) } : {}),
    };
  },
};
