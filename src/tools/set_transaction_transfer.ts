import { z } from 'zod';
import { getPayeeIndex } from '../core/payees.js';
import { getCategoryIndex } from '../core/categories.js';
import { sameBudgetSide } from '../core/transfers.js';
import { getTransactionById, getTransactionRow, mapTxEcho, readBack } from '../core/tx-read.js';
import { syncAfterWrite } from '../core/write-sync.js';
import { ID, type ToolDef } from '../core/types.js';
import { msg } from '../core/messages.js';

const input = {
  transaction_id: ID.describe('Transaction UUID to convert (from get_transactions)'),
  target_account_id: ID.describe('Account UUID the money moves to/from (from get_accounts)'),
  category_id: ID.optional().describe('Category to keep on the transaction. Only for transfers that cross the budget side (on-budget <-> off-budget); refused when both accounts are on the same side'),
  force: z.boolean().default(false).describe('Allow re-pointing an existing transfer whose other leg is reconciled or a bank import (never a split part)'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'set_transaction_transfer',
  title: 'Turn transaction into transfer',
  description: 'Turn an ordinary transaction into a transfer with another account, by pointing it at that account transfer payee. Also works on a split part (child id), not on the split parent. For a transfer that crosses the budget side (e.g. the principal of a mortgage payment going to an off-budget loan account) pass category_id to keep the category. Actual creates and links the matching transaction on the other account, and clears the category on both when the two accounts are on the same side of the budget (both on-budget or both off-budget). If the transaction is already a transfer, it is re-pointed to the new destination (Actual moves the other leg): refused when that other leg is a split part, and when it is reconciled or a bank import unless force is true. Returns the transaction and the id of the linked counterpart. If the target account syncs with the bank, the result carries a warning: the bank will import its own leg, so joining two existing transactions is better done with find_transfer_issues (link).',
  readOnly: false,
  annotations: { destructiveHint: true, idempotentHint: true },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);

    const accounts = ((await api.getAccounts()) ?? []) as any[];
    const target = accounts.find((acc) => acc.id === a.target_account_id);
    if (!target) throw new Error(m.accountNotFound(a.target_account_id));
    // balance_current solo lo rellena el bank-sync: el banco traerá su propia pata.
    const syncedTarget = target.balance_current !== null && target.balance_current !== undefined;

    if (target.closed) throw new Error(m.accountClosed(target.name));

    const existing = await getTransactionById(api, a.transaction_id);
    if (!existing) throw new Error(m.txNotFound(a.transaction_id));
    // Lectura agrupada con id de hijo devuelve el PADRE: así se detecta una parte de split.
    const isChild = existing.id !== a.transaction_id;
    if (!isChild && (existing.is_parent || (Array.isArray(existing.subtransactions) && existing.subtransactions.length > 0))) {
      // transfer.onUpdate removes the transfer for a parent instead of adding one.
      throw new Error(m.cannotTransferSplitParent(a.transaction_id));
    }
    // Una parte se lee cruda (splits:'all'); su cuenta es la del padre.
    const current = isChild ? await getTransactionRow(api, a.transaction_id) : existing;
    if (!current) throw new Error(m.txNotFound(a.transaction_id));
    if (current.account === a.target_account_id) throw new Error(m.transferSameAccount);

    if (a.category_id !== undefined) {
      const cats = await getCategoryIndex(api);
      if (!cats.has(a.category_id)) throw new Error(m.categoryNotFound(a.category_id));
    }
    // true = mismo lado (Actual limpia la categoría de ambas patas); null = sin confirmar.
    const same = sameBudgetSide(accounts, current.account, a.target_account_id);
    if (a.category_id !== undefined && same !== false) throw new Error(m.transferCategorySameSide(target.name));
    const clearsCategory = same === true && !!current.category;

    // Re-apuntar una pata ya enlazada hace que Actual MUEVA la otra a la cuenta nueva: una
    // parte de split saldría de la cuenta de su padre; una fila del banco o conciliada se
    // movería y al reimportar duplicaría el dinero. Se lee ANTES de escribir.
    if (current.transfer_id) {
      const twin = await getTransactionRow(api, current.transfer_id);
      if (twin && twin.account !== a.target_account_id) {
        if (twin.is_child || twin.parent_id) throw new Error(m.twinMoveSplitPart(twin.id));
        if (!a.force) {
          if (twin.reconciled) throw new Error(m.twinMoveProtected(twin.id, 'reconciled'));
          if (twin.imported_id) throw new Error(m.twinMoveProtected(twin.id, 'imported'));
        }
      }
    }

    const { byTransferAccount } = await getPayeeIndex(api);
    const payee = byTransferAccount.get(a.target_account_id);
    if (!payee) throw new Error(m.transferPayeeNotFound(a.target_account_id));

    const fields: Record<string, any> = { payee: payee.id };
    if (a.category_id !== undefined) fields.category = a.category_id;
    await api.updateTransaction(a.transaction_id, fields);
    const { row, settled } = await readBack(api, a.transaction_id, fields, isChild ? { read: getTransactionRow } : {});
    const sync = await syncAfterWrite(api);
    return {
      updated: true,
      ...(syncedTarget ? { warning: m.transferTargetSynced(target.name) } : {}),
      ...(settled ? {} : { echo_pending: true, note: m.echoPending }),
      ...(sync.synced ? {} : { sync_pending: true, note: m.syncPending(sync.error!) }),
      target_account_id: a.target_account_id,
      // Present => Actual linked the counterpart leg. Reported as read, never assumed.
      transfer_id: row?.transfer_id ?? null,
      clears_category: clearsCategory,
      ...(isChild ? { parent_id: (row ?? current).parent_id ?? existing.id } : {}),
      transaction: mapTxEcho(row ?? current, config.locale, config.currency),
    };
  },
};
