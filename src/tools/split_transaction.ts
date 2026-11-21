import { z } from 'zod';
import { getCategoryIndex } from '../core/categories.js';
import { toCents, formatAmount } from '../core/money.js';
import { getTransactionById, getTransactionRow, mapTxEcho, readBackSplit } from '../core/tx-read.js';
import { getPayeeIndex } from '../core/payees.js';
import { sameBudgetSide } from '../core/transfers.js';
import { ID, type ToolDef } from '../core/types.js';
import { msg } from '../core/messages.js';

const input = {
  transaction_id: ID,
  splits: z.array(z.object({
    amount: z.number().describe('Units; same sign as the original. With adjust_last, the LAST part may be 0 (computed server-side)'),
    category_id: ID.optional().describe('Category of the part. Required unless the part is a transfer; on a transfer part only allowed when the transfer crosses the budget side (on-budget <-> off-budget)'),
    notes: z.string().max(1000).optional(),
    transfer_account_id: ID.optional().describe('Make this part a transfer to that account (Actual creates the linked transaction there)'),
  })).min(2).max(20).describe('Parts of the split (min 2, max 20)'),
  adjust_last: z.boolean().default(false).describe('Compute the last part as the exact remainder'),
  force: z.boolean().default(false).describe('Allow splitting a reconciled transaction'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'split_transaction',
  title: 'Split transaction',
  description: 'Split an existing transaction into parts with real subtransactions. Parts must sum exactly to the original amount (integer-cent validation); adjust_last=true computes the final part. Each part needs a category_id or a transfer_account_id. A part with transfer_account_id becomes a transfer to that account (Actual creates its linked transaction); the account must exist, be open and differ from the transaction account. When the transfer crosses the budget side (on-budget <-> off-budget, e.g. the principal of a mortgage payment going to a loan account) the part may also carry category_id; between accounts on the same side a category is refused because Actual would clear it. An existing transfer can be split too: Actual deletes its other leg and creates one per transfer part, and the parent payee becomes the existing payee matching the original imported_payee (or none); the result reports replaced_twin_id and parent_payee_id. It is refused (force does not bypass it) when the other leg is bank-imported (has imported_id), reconciled or itself a split part: fix that first in Actual or with remove_transaction_transfer. Splitting a reconciled original still needs force=true.',
  readOnly: false,
  annotations: { destructiveHint: true, idempotentHint: false },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    // Los guards del objetivo (existe, no es una parte, no está ya dividido) son más
    // fundamentales que la cardinalidad de partes: se validan ANTES del schema completo.
    const m = msg(config);
    const { transaction_id, force } = z
      .object({ transaction_id: input.transaction_id, force: input.force })
      .parse(raw ?? {});
    const orig = await getTransactionById(api, transaction_id);
    if (!orig) throw new Error(m.txNotFound(transaction_id));
    // La lectura agrupada con id de hijo devuelve el PADRE.
    if (orig.id !== transaction_id) throw new Error(m.splitChild(transaction_id, orig.id));
    if (orig.is_parent || (Array.isArray(orig.subtransactions) && orig.subtransactions.length > 0)) {
      throw new Error(m.alreadySplit);
    }
    // Dividir modifica la conciliación de la fila si estaba conciliada: Actual la conserva
    // (nunca se toca cleared/reconciled aquí), pero exigimos confirmación explícita igual que
    // antes, porque el split cambia la forma de la transacción.
    if (orig.reconciled && !force) {
      throw new Error(m.reconciledNeedsForce);
    }

    const a = schema.parse(raw ?? {});
    const totalCents = orig.amount ?? 0;
    // Cada parte necesita categoría o ser transferencia (índices 1-based en los mensajes).
    a.splits.forEach((s, i) => {
      if (!s.category_id && !s.transfer_account_id) throw new Error(m.partNeedsCategoryOrTransfer(i + 1));
    });
    const parts: Array<{ amount: number; category?: string; notes?: string; payee?: string }> =
      a.splits.map((s) => ({
        amount: toCents(s.amount),
        ...(s.category_id ? { category: s.category_id } : {}),
        ...(s.notes ? { notes: s.notes } : {}),
      }));
    const partialSum = parts.slice(0, -1).reduce((s, p) => s + p.amount, 0);
    if (a.adjust_last) {
      parts[parts.length - 1].amount = totalCents - partialSum;
    }
    const sum = parts.reduce((s, p) => s + p.amount, 0);
    if (sum !== totalCents) {
      const diff = totalCents - sum;
      throw new Error(
        m.partsDoNotSum(
          formatAmount(sum, config.locale, config.currency),
          formatAmount(totalCents, config.locale, config.currency),
          diff > 0,
          formatAmount(Math.abs(diff), config.locale, config.currency),
        ),
      );
    }

    // Validar TODAS las categorías antes de tocar nada: un id inexistente dejaría
    // la parte sin categoría en silencio.
    const cats = await getCategoryIndex(api);
    for (const p of parts) {
      if (p.category && !cats.has(p.category)) throw new Error(m.categoryNotFound(p.category));
    }

    // Partes-transferencia: cuenta existente, abierta y distinta de la propia; el pagador
    // de transferencia de la cuenta convierte la parte en transferencia.
    const transferParts = a.splits.map((s, i) => ({ s, i })).filter(({ s }) => s.transfer_account_id);
    const transferPayeeIds = new Set<string>();
    if (transferParts.length > 0) {
      const accounts = ((await api.getAccounts()) ?? []) as any[];
      const { byTransferAccount } = await getPayeeIndex(api);
      for (const { s, i } of transferParts) {
        const target = accounts.find((acc) => acc.id === s.transfer_account_id);
        if (!target) throw new Error(m.accountNotFound(s.transfer_account_id!));
        if (s.transfer_account_id === orig.account) throw new Error(m.partTransferSameAccount(i + 1));
        if (target.closed) throw new Error(m.accountClosed(target.name));
        // true/null con categoría: Actual la limpiaría (o no se puede confirmar) => se rechaza.
        if (s.category_id && sameBudgetSide(accounts, orig.account, s.transfer_account_id!) !== false) {
          throw new Error(m.transferCategorySameSide(target.name));
        }
        const payee = byTransferAccount.get(s.transfer_account_id!);
        if (!payee) throw new Error(m.transferPayeeNotFound(s.transfer_account_id!));
        parts[i].payee = payee.id;
        transferPayeeIds.add(payee.id);
      }
    }

    // Dividir una transferencia: Actual borra la otra pata (el padre no puede ser transferencia).
    // Si esa pata es del banco, está conciliada o es parte de un split, se rechaza ANTES de
    // escribir y force no lo salta.
    const fields: Record<string, any> = { subtransactions: parts };
    let replacedTwinId: string | undefined;
    let parentPayee: string | null | undefined;
    if (orig.transfer_id) {
      const twin = await getTransactionRow(api, orig.transfer_id);
      if (twin) {
        if (twin.reconciled) throw new Error(m.splitTransferTwinProtected(twin.id, 'reconciled'));
        if (twin.imported_id) throw new Error(m.splitTransferTwinProtected(twin.id, 'imported'));
        if (twin.is_child || twin.parent_id) throw new Error(m.splitTransferTwinProtected(twin.id, 'split_part'));
        replacedTwinId = twin.id;
      }
      // El padre pierde el pagador de transferencia: se busca un pagador NORMAL existente
      // con el nombre importado (nunca se crea uno), si no, queda sin pagador.
      const wanted = typeof orig.imported_payee === 'string' ? orig.imported_payee.trim().toLowerCase() : '';
      const { all } = await getPayeeIndex(api);
      parentPayee = (wanted && all.find((p) => !p.transfer_acct && (p.name ?? '').trim().toLowerCase() === wanted)?.id) || null;
      fields.payee = parentPayee;
    }

    // Update in-place: @actual-app/api 26.8.0 convierte correctamente una transacción normal
    // en split (upstream PR #8467). date/amount/notes/cleared/imported_id/imported_payee/
    // schedule/reconciled ya viven en la fila y no se tocan -- no hace falta copiarlos.
    await api.updateTransaction(transaction_id, fields);
    // Asentado = nº de partes correcto Y cada parte-transferencia ya tiene su pata (transfer_id).
    const { row, settled } = await readBackSplit(api, transaction_id, parts.length, {
      isSettled: (r) => (r.subtransactions as any[])
        .filter((sub) => transferPayeeIds.has(sub.payee))
        .every((sub) => !!sub.transfer_id),
    });

    return {
      split: true,
      original_id: transaction_id,
      ...(replacedTwinId ? { replaced_twin_id: replacedTwinId } : {}),
      ...(parentPayee !== undefined ? { parent_payee_id: parentPayee } : {}),
      // El eco es lo LEÍDO. Si la escritura aún no se refleja se avisa en vez de
      // devolver los valores pedidos como si estuvieran guardados.
      ...(settled ? {} : { echo_pending: true, note: m.echoPending }),
      transaction: mapTxEcho(row ?? { ...orig, subtransactions: parts }, config.locale, config.currency),
    };
  },
};
