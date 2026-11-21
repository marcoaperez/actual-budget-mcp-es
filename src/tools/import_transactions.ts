import { z } from 'zod';
import { getCategoryIndex } from '../core/categories.js';
import { toCents } from '../core/money.js';
import { ID, type ToolDef } from '../core/types.js';
import { activeMessages, msg } from '../core/messages.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  account_id: ID,
  transactions: z.array(z.object({
    date: DATE,
    amount: z.number().describe('Units; negative = expense, positive = income'),
    imported_id: z.string().min(1).max(100).describe('Stable unique id, e.g. fcf-<name>-2026-11 for a monthly fund return'),
    payee_name: z.string().max(200).optional(),
    category_id: ID.optional(),
    notes: z.string().max(1000).optional(),
    cleared: z.boolean().optional(),
  })).min(1).max(100),
  dry_run: z.boolean().default(true).describe('Default true: only preview. Call again with false to write'),
  allow_fuzzy: z.boolean().default(false).describe('Also import rows that would merge into an existing row without imported_id (same amount, date within 7 days)'),
};
const schema = z.object(input);

type Outcome = 'add' | 'update' | 'unchanged' | 'fuzzy' | 'skipped_fuzzy' | 'error';

export const tool: ToolDef = {
  name: 'import_transactions',
  title: 'Import transactions',
  description:
    'Import transactions identified by a stable imported_id (e.g. fcf-<name>-2026-11 for a monthly fund return) without duplicates. ' +
    'Dry run by default: shows per row whether it would be added, updated, unchanged or merged into an existing row without imported_id (fuzzy); ' +
    'review it, then call again with dry_run false. Fuzzy rows are skipped unless allow_fuzzy is true. Deleted rows are never re-imported. Amounts in currency units.',
  readOnly: false,
  annotations: { destructiveHint: false, idempotentHint: true },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);

    const seen = new Set<string>();
    for (const t of a.transactions) {
      if (seen.has(t.imported_id)) throw new Error(m.duplicateImportedId(t.imported_id));
      seen.add(t.imported_id);
    }
    const account = (((await api.getAccounts()) ?? []) as any[]).find((x) => x.id === a.account_id);
    if (!account) throw new Error(m.accountNotFound(a.account_id));
    if (account.closed) throw new Error(m.accountClosed(account.name));
    const wanted = [...new Set(a.transactions.flatMap((t) => (t.category_id ? [t.category_id] : [])))];
    if (wanted.length > 0) {
      const cats = await getCategoryIndex(api);
      for (const id of wanted) if (!cats.has(id)) throw new Error(m.categoryNotFound(id));
    }

    const rows = a.transactions.map((t) => ({
      date: t.date,
      amount: toCents(t.amount),
      imported_id: t.imported_id,
      ...(t.payee_name ? { payee_name: t.payee_name } : {}),
      ...(t.category_id ? { category: t.category_id } : {}),
      ...(t.notes ? { notes: t.notes } : {}),
      ...(t.cleared !== undefined ? { cleared: t.cleared } : {}),
    }));

    // Siempre vista previa primero: en ella las filas que se añadirían NO aparecen en updatedPreview.
    const preview: any = await api.importTransactions(a.account_id, rows, { dryRun: true, reimportDeleted: false, defaultCleared: true });
    if (preview?.errors?.length) throw new Error(m.importErrors(preview.errors.map((e: any) => e.message).join('; ')));

    const byId = new Map<string, any>();
    for (const e of preview?.updatedPreview ?? []) {
      const id = e?.transaction?.imported_id;
      if (id) byId.set(id, e);
    }
    const results = a.transactions.map((t) => {
      const e = byId.get(t.imported_id);
      let outcome: Outcome = 'add';
      let matched: any;
      if (e) {
        if (e.ignored || !e.existing) outcome = 'unchanged';
        else {
          const ex = e.existing;
          outcome = ex.imported_id && ex.imported_id === t.imported_id ? 'update' : 'fuzzy';
          matched = { id: ex.id, date: ex.date, payee: ex.payee_name, amount: ex.amount };
        }
      }
      return { imported_id: t.imported_id, outcome, ...(matched ? { matched } : {}) } as { imported_id: string; outcome: Outcome; matched?: any; error?: string };
    });

    if (!a.dry_run) {
      const send = new Set(results.filter((r) => r.outcome === 'add' || r.outcome === 'update' || (r.outcome === 'fuzzy' && a.allow_fuzzy)).map((r) => r.imported_id));
      for (const r of results) if (r.outcome === 'fuzzy' && !a.allow_fuzzy) r.outcome = 'skipped_fuzzy';
      if (send.size > 0) {
        const res: any = await api.importTransactions(a.account_id, rows.filter((r) => send.has(r.imported_id)), { dryRun: false, reimportDeleted: false, defaultCleared: true });
        if (res?.errors?.length) throw new Error(m.importErrors(res.errors.map((e: any) => e.message).join('; ')));
      }
    }

    const totals: Record<string, number> = {};
    for (const r of results) totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
    return { dry_run: a.dry_run, results, totals, errors: [] };
  },
};
