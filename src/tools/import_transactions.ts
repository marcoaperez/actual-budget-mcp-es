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

type Outcome = 'add' | 'update' | 'unchanged' | 'kept_deleted' | 'fuzzy' | 'skipped_fuzzy' | 'error';

export const tool: ToolDef = {
  name: 'import_transactions',
  title: 'Import transactions',
  description:
    'Import transactions identified by a stable imported_id (e.g. fcf-<name>-2026-11 for a monthly fund return) without duplicates. ' +
    'Dry run by default: shows per row whether it would be added, updated, unchanged or merged into an existing row without imported_id (fuzzy); ' +
    'review it, then call again with dry_run false. Fuzzy rows are skipped unless allow_fuzzy is true. Deleted rows are never re-imported (reported as kept_deleted). Amounts in currency units.',
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

    // Clasifica cada fila según una vista previa (las que se añadirían no aparecen en ella).
    const classify = (pv: any, subset: typeof a.transactions) => {
      const byId = new Map<string, any>();
      for (const e of pv?.updatedPreview ?? []) {
        const id = e?.transaction?.imported_id;
        if (id) byId.set(id, e);
      }
      return subset.map((t) => {
        const e = byId.get(t.imported_id);
        let outcome: Outcome = 'add';
        let matched: any;
        if (e) {
          if (e.tombstone || e.existing?.tombstone) outcome = 'kept_deleted';
          else if (e.ignored || !e.existing) outcome = 'unchanged';
          else {
            const ex = e.existing;
            outcome = ex.imported_id && ex.imported_id === t.imported_id ? 'update' : 'fuzzy';
            matched = { id: ex.id, date: ex.date, payee: ex.payee_name, amount: ex.amount };
          }
        }
        return { imported_id: t.imported_id, outcome, ...(matched ? { matched } : {}) } as { imported_id: string; outcome: Outcome; matched?: any; error?: string };
      });
    };
    const results = classify(preview, a.transactions);
    let warning: string | undefined;

    if (!a.dry_run) {
      const sendable = (r: { outcome: Outcome }) => r.outcome === 'add' || r.outcome === 'update' || (r.outcome === 'fuzzy' && a.allow_fuzzy);
      for (const r of results) if (r.outcome === 'fuzzy' && !a.allow_fuzzy) r.outcome = 'skipped_fuzzy';
      // Al descartar una fila fuzzy, su candidato queda libre y otra fila podría fusionarse con él en
      // silencio: se vuelve a previsualizar el subconjunto hasta que no aparezcan filas fuzzy nuevas.
      if (!a.allow_fuzzy) {
        for (let i = 0; i < a.transactions.length; i++) {
          const ids = new Set(results.filter(sendable).map((r) => r.imported_id));
          if (ids.size === 0 || !results.some((r) => r.outcome === 'skipped_fuzzy')) break;
          const sub = rows.filter((r) => ids.has(r.imported_id));
          const pv: any = await api.importTransactions(a.account_id, sub, { dryRun: true, reimportDeleted: false, defaultCleared: true });
          if (pv?.errors?.length) throw new Error(m.importErrors(pv.errors.map((e: any) => e.message).join('; ')));
          const again = classify(pv, a.transactions.filter((t) => ids.has(t.imported_id)));
          let changed = false;
          for (const n of again) {
            if (n.outcome !== 'fuzzy') continue;
            const r = results.find((x) => x.imported_id === n.imported_id)!;
            r.outcome = 'skipped_fuzzy';
            r.matched = n.matched;
            changed = true;
          }
          if (!changed) break;
        }
      }
      const send = new Set(results.filter(sendable).map((r) => r.imported_id));
      if (send.size > 0) {
        const res: any = await api.importTransactions(a.account_id, rows.filter((r) => send.has(r.imported_id)), { dryRun: false, reimportDeleted: false, defaultCleared: true });
        if (res?.errors?.length) throw new Error(m.importErrors(res.errors.map((e: any) => e.message).join('; ')));
        const plannedAdd = results.filter((r) => r.outcome === 'add').length;
        const plannedUpd = results.filter((r) => r.outcome === 'update' || (r.outcome === 'fuzzy' && a.allow_fuzzy)).length;
        const gotAdd = res?.added?.length ?? 0;
        const gotUpd = res?.updated?.length ?? 0;
        if (gotAdd !== plannedAdd || gotUpd !== plannedUpd) {
          warning = m.importCountMismatch(`${plannedAdd} add, ${plannedUpd} update`, `${gotAdd} add, ${gotUpd} update`);
        }
      }
    }

    const totals: Record<string, number> = {};
    for (const r of results) totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
    return { dry_run: a.dry_run, results, totals, errors: [], ...(warning ? { warning } : {}) };
  },
};
