import { z } from 'zod';
import { ID, type ToolDef } from '../core/types.js';
import { msg, activeMessages } from '../core/messages.js';
import { addDays, loadDetectInput, todayLocal } from '../core/reconcile-data.js';
import { DEFAULT_RANGE_DAYS, LINK_MAX_DAYS, detectAll } from '../core/reconcile-detect.js';
import { presentProposal } from '../core/reconcile-model.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  start_date: DATE.optional().describe('First day to review (YYYY-MM-DD). Default: 90 days before end_date'),
  end_date: DATE.optional().describe('Last day to review (YYYY-MM-DD). Default: today'),
  account_ids: z.array(ID).optional().describe('Only proposals touching these accounts (from get_accounts)'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'find_transfer_issues',
  title: 'Find transfer issues',
  description:
    'Review a date range for reconciliation problems and propose fixes, each with a confidence (alta = clear, dudosa = check first): ' +
    'link (two existing opposite transactions in two accounts that should be one transfer), ' +
    'merge (a bank-imported transaction duplicated by a non-imported one in the same account) and ' +
    'create_transfer (a bank transaction that should be a transfer to a manually kept account). ' +
    'Writes nothing: pass the accepted operations to apply_reconciliation_fixes.',
  readOnly: true,
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const end = a.end_date ?? todayLocal();
    const start = a.start_date ?? addDays(end, -DEFAULT_RANGE_DAYS);

    if (start > end) throw new Error(m.startAfterEnd(start, end));

    const detectInput = await loadDetectInput(api, { start: addDays(start, -LINK_MAX_DAYS), end: addDays(end, LINK_MAX_DAYS) });
    for (const id of a.account_ids ?? []) {
      if (!detectInput.accounts.some((acc) => acc.id === id)) throw new Error(m.accountNotFound(id));
    }

    const proposals = detectAll(detectInput, m).filter((p) =>
      p.transactions.some(
        (t) => t.date >= start && t.date <= end && (!a.account_ids || a.account_ids.includes(t.account)),
      ),
    );
    const present = (type: string) =>
      proposals
        .filter((p) => p.operation.type === type)
        .map((p) => presentProposal(p, detectInput.payeeNames, config.locale, config.currency));
    return {
      start_date: start,
      end_date: end,
      total_count: proposals.length,
      alta_count: proposals.filter((p) => p.confidence === 'alta').length,
      proposals: { link: present('link'), merge: present('merge'), create_transfer: present('create_transfer') },
    };
  },
};
