import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { msg, activeMessages } from '../core/messages.js';
import { moneyFields, toCents } from '../core/money.js';
import { addDays, closeOfDay, loadAccounts, loadDetectInput, resolveAccount } from '../core/reconcile-data.js';
import { DEFAULT_RANGE_DAYS, LINK_MAX_DAYS, detectAll } from '../core/reconcile-detect.js';
import { presentProposal, summarizeTx } from '../core/reconcile-model.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  account: z.string().min(1).describe('Account id or exact name (case and accents are ignored)'),
  bank_balance: z.number().describe('Balance the bank shows at the close of date, in account currency units (e.g. 1234.56)'),
  date: DATE.describe('Statement date (YYYY-MM-DD); transactions dated that day are included'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'reconcile_account',
  title: 'Reconcile account against bank',
  description:
    'Compare an account with the balance the bank shows at the close of a date. Returns the Actual balance at that ' +
    'date, the difference (bank − Actual), the already reconciled balance, and when they differ the proposed fixes ' +
    'touching this account (see find_transfer_issues) plus transactions whose amount alone explains the gap. ' +
    `Proposals and hints only cover about ${DEFAULT_RANGE_DAYS} days before date. ` +
    'link and create_transfer between two accounts on the same side of the budget (both on-budget or both off-budget) clear the category ' +
    'of both legs, as Actual does; proposals flag it with clears_category. Writes nothing.',
  readOnly: true,
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const money = (cents: number) => moneyFields(cents, config.locale, config.currency);

    const account = resolveAccount(await loadAccounts(api), a.account, m);
    const bank = toCents(a.bank_balance);
    const actual: number = await api.getAccountBalance(account.id, closeOfDay(a.date));
    const { data: reconciledSum } = await api.runQuery(
      api.q('transactions')
        .filter({ account: account.id, reconciled: true, date: { $lte: a.date } })
        .options({ splits: 'inline' })
        .calculate({ $sum: '$amount' }),
    );
    const difference = bank - actual;
    const base = {
      account: { id: account.id, name: account.name },
      date: a.date,
      bank_balance: money(bank),
      actual_balance: money(actual),
      difference: money(difference),
      reconciled_balance: money(reconciledSum ?? 0),
      matches: difference === 0,
    };
    if (difference === 0) return { ...base, next_step: m.reconcileMatchesNext, proposals: [], hints: [] };

    const detectInput = await loadDetectInput(api, {
      // Doble margen de enlace: ver también a las candidatas de las candidatas en los bordes.
      start: addDays(a.date, -(DEFAULT_RANGE_DAYS + 2 * LINK_MAX_DAYS)),
      end: addDays(a.date, 2 * LINK_MAX_DAYS),
    });
    const proposals = detectAll(detectInput, m).filter((p) =>
      p.transactions.some((t) => t.account === account.id && t.date <= a.date),
    );
    const hints = detectInput.rows
      .filter((r) => r.account === account.id && r.date <= a.date && !r.reconciled && r.amount === -difference)
      .map((r) => ({ ...summarizeTx(r, detectInput.payeeNames, config.locale, config.currency), note: m.reconcileHintExtra }));
    return {
      ...base,
      proposals: proposals.map((p) => presentProposal(p, detectInput.payeeNames, config.locale, config.currency)),
      hints,
    };
  },
};
