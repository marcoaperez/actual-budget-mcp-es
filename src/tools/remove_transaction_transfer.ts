import { z } from 'zod';
import { getCategoryIndex } from '../core/categories.js';
import { getPayeeIndex, resolvePayeeName } from '../core/payees.js';
import { getTransactionById, getTransactionRow, mapTxEcho, readBack } from '../core/tx-read.js';
import { syncAfterWrite } from '../core/write-sync.js';
import { ID, type ToolDef } from '../core/types.js';
import { msg } from '../core/messages.js';

const input = {
  transaction_id: ID.describe('Transfer transaction UUID (a normal transfer leg or a transfer split part)'),
  payee_id: ID.optional().describe('Payee the transaction becomes, by id (from get_payees). Not a transfer payee'),
  payee_name: z.string().max(200).optional().describe('Payee the transaction becomes, by name (resolved or created server-side; never a transfer payee)'),
  category_id: ID.nullable().optional().describe('Category UUID for the transaction; null leaves it uncategorized'),
  notes: z.string().max(1000).optional(),
  force: z.boolean().default(false).describe('Allow removing the transfer when the other leg is reconciled or a bank import'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'remove_transaction_transfer',
  title: 'Turn transfer into ordinary transaction',
  description: 'Turn a transfer (a normal transfer leg or a transfer split part) back into an ordinary transaction with the given payee (payee_id or payee_name) and optional category and notes. This is the explicit form of changing the payee to a non-transfer payee: Actual deletes the matching transaction on the other account, or, when that one is itself a split part, only detaches it (clears its payee and link). Refuses when the other leg is reconciled or a bank import (has imported_id) unless force is true; with force on a bank-imported leg the result warns that bank sync may bring it back. Returns the transaction, the removed twin id and twin_action (deleted | detached).',
  readOnly: false,
  annotations: { destructiveHint: true, idempotentHint: false },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);

    if (a.payee_id === undefined && a.payee_name === undefined) throw new Error(m.payeeRequired);
    if (a.payee_id !== undefined && a.payee_name !== undefined) throw new Error(m.payeeIdAndNameTogether);

    const existing = await getTransactionById(api, a.transaction_id);
    if (!existing) throw new Error(m.txNotFound(a.transaction_id));
    // Lectura agrupada con id de hijo devuelve el PADRE: así se detecta una parte de split.
    const isChild = existing.id !== a.transaction_id;
    if (!isChild && (existing.is_parent || (Array.isArray(existing.subtransactions) && existing.subtransactions.length > 0))) {
      throw new Error(m.removeTransferSplitParent(a.transaction_id));
    }
    const current = isChild ? await getTransactionRow(api, a.transaction_id) : existing;
    if (!current) throw new Error(m.txNotFound(a.transaction_id));
    const twinId: string | null = current.transfer_id ?? null;
    if (!twinId) throw new Error(m.notATransfer(a.transaction_id));

    // La otra pata se lee ANTES de escribir: removeTransfer la borra y luego ya no está.
    const twin = await getTransactionRow(api, twinId);
    if (twin && !a.force) {
      if (twin.reconciled) throw new Error(m.twinProtected(twinId, 'reconciled'));
      if (twin.imported_id) throw new Error(m.twinProtected(twinId, 'imported'));
    }
    const twinAction: 'deleted' | 'detached' | 'none' = !twin ? 'none' : twin.is_child ? 'detached' : 'deleted';

    if (a.category_id !== undefined && a.category_id !== null) {
      const cats = await getCategoryIndex(api);
      if (!cats.has(a.category_id)) throw new Error(m.categoryNotFound(a.category_id));
    }
    let payeeId: string;
    if (a.payee_id !== undefined) {
      const { byId } = await getPayeeIndex(api);
      const p = byId.get(a.payee_id);
      if (!p) throw new Error(m.payeeIdNotFound(a.payee_id));
      if (p.transfer_acct) throw new Error(m.payeeIdIsTransfer(a.payee_id));
      payeeId = a.payee_id;
    } else {
      payeeId = await resolvePayeeName(api, a.payee_name!);
    }

    const fields: Record<string, any> = { payee: payeeId };
    if (a.category_id !== undefined) fields.category = a.category_id;
    if (a.notes !== undefined) fields.notes = a.notes;
    await api.updateTransaction(a.transaction_id, fields);
    // transfer_id: null forma parte de lo sondeado: confirma que el vínculo desapareció.
    const { row, settled } = await readBack(api, a.transaction_id, { ...fields, transfer_id: null },
      isChild ? { read: getTransactionRow } : {});
    const twinAfter = twin && twinAction === 'deleted' ? await getTransactionRow(api, twinId) : null;
    const sync = await syncAfterWrite(api);

    let warning: string | undefined;
    if (twin && a.force && twin.imported_id) {
      const accounts = ((await api.getAccounts()) ?? []) as any[];
      const accName = accounts.find((acc) => acc.id === twin.account)?.name ?? twin.account;
      warning = m.twinMayReturn(accName);
    }
    return {
      updated: true,
      ...(warning ? { warning } : {}),
      ...(settled ? {} : { echo_pending: true, note: m.echoPending }),
      ...(sync.synced ? {} : { sync_pending: true, note: m.syncPending(sync.error!) }),
      removed_twin_id: twinId,
      twin_action: twinAction,
      ...(twinAfter ? { twin_still_present: true } : {}),
      ...(isChild ? { parent_id: (row ?? current).parent_id ?? existing.id } : {}),
      transaction: mapTxEcho(row ?? current, config.locale, config.currency),
    };
  },
};
