import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { msg, activeMessages } from '../core/messages.js';
import { formatAmount, moneyFields, toCents } from '../core/money.js';
import { closeOfDay, loadAccounts, resolveAccount } from '../core/reconcile-data.js';
import { syncAfterWrite } from '../core/write-sync.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  account: z.string().min(1).describe('Account id or exact name (case and accents are ignored)'),
  date: DATE.describe('Statement date (YYYY-MM-DD); transactions dated that day are included'),
  bank_balance: z.number().describe('Balance the bank shows at the close of date, in account currency units'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'mark_reconciled',
  title: 'Mark account reconciled',
  description:
    'Once an account matches the bank, mark every unreconciled transaction in it dated on or before date as cleared ' +
    'and reconciled (rows not yet cleared are also set to cleared; the reconcile button in the Actual app may behave differently). Recomputes the balance first and refuses (writing nothing) ' +
    'if it does not match bank_balance. Never adds a balance-adjustment transaction.',
  readOnly: false,
  annotations: { destructiveHint: false, idempotentHint: true },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const money = (cents: number) => moneyFields(cents, config.locale, config.currency);

    // Calcular el saldo sobre datos frescos: ensureReady solo sincroniza si su TTL ha caducado.
    await api.sync();
    const account = resolveAccount(await loadAccounts(api), a.account, m);
    const bank = toCents(a.bank_balance);
    const actual: number = await api.getAccountBalance(account.id, closeOfDay(a.date));
    const who = { id: account.id, name: account.name };
    if (actual !== bank) {
      const difference = bank - actual;
      return {
        reconciled: false,
        account: who,
        date: a.date,
        bank_balance: money(bank),
        actual_balance: money(actual),
        difference: money(difference),
        note: m.reconcileMismatch(formatAmount(difference, config.locale, config.currency)),
      };
    }

    const { data } = await api.runQuery(
      api.q('transactions')
        .filter({ account: account.id, reconciled: false, date: { $lte: a.date } })
        .options({ splits: 'all' })
        .select(['id']),
    );
    const ids = ((data ?? []) as any[]).map((r) => r.id);
    let done = 0;
    let failure: { id: string; error: string } | null = null;
    for (const id of ids) {
      try {
        await api.updateTransaction(id, { cleared: true, reconciled: true });
        done++;
      } catch (e) {
        failure = { id, error: e instanceof Error ? e.message : String(e) };
        break;
      }
    }
    // Siempre sincronizar: lo ya escrito debe llegar al servidor aunque el bucle fallase a medias.
    const sync = await syncAfterWrite(api);
    const syncNote = sync.synced ? undefined : m.syncPending(sync.error!);
    if (failure) {
      return {
        reconciled: false,
        account: who,
        date: a.date,
        marked_count: done,
        failed_id: failure.id,
        error: failure.error,
        note: m.reconcilePartial(done, ids.length),
        ...(sync.synced ? {} : { sync_pending: true, sync_note: syncNote }),
      };
    }
    return {
      reconciled: true,
      account: who,
      date: a.date,
      balance: money(actual),
      marked_count: done,
      ...(sync.synced ? {} : { sync_pending: true, note: syncNote }),
    };
  },
};
