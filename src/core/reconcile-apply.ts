// reconcile-apply.ts — aplica UNA operación de conciliación, revalidándola antes contra los
// datos del momento (entre proponer y aplicar puede haber entrado un bank-sync).
//
// `link` usa el mecanismo que validó el spike del 2026-10-08: apuntar X al beneficiario de
// transferencia de la cuenta de Y (Actual crea X′ ahí, de forma ASÍNCRONA: hay que sondear)
// y fusionar X′ con Y. mergeTransactions conserva la fila con imported_id, así que Y — la pata
// del banco — sobrevive con su imported_id y enlazada con X. Escribir transfer_id a mano
// destruye la pata del banco: nunca se hace.
import type { Messages } from './messages.js';
import { getPayeeIndex } from './payees.js';
import type { Operation } from './reconcile-model.js';
import { getTransactionById, readBack } from './tx-read.js';

export const COUNTERPART_POLL_ATTEMPTS = 20;
export const COUNTERPART_POLL_DELAY_MS = 50;

export type OpStatus = 'aplicada' | 'omitida' | 'fallida';
export interface OpResult {
  operation: Operation;
  status: OpStatus;
  detail?: string;
  transfer_id?: string | null;
  survivor_id?: string;
}
export interface ApplyOpts {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

/** Revalida una fila: existe, no es split, no está conciliada. Devuelve el motivo si no vale. */
async function usableRow(api: any, id: string, m: Messages): Promise<{ row?: any; why?: string }> {
  const row = await getTransactionById(api, id);
  if (!row) return { why: m.opTxNotFound(id) };
  // Las lecturas agrupadas devuelven el PADRE si se pide un hijo: ese desajuste delata el split.
  if (row.id !== id || row.is_parent || row.is_child || row.parent_id) return { why: m.opSplitRow(id) };
  if (row.reconciled) return { why: m.opReconciled(id) };
  return { row };
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function applyLink(api: any, op: Extract<Operation, { type: 'link' }>, m: Messages, opts: ApplyOpts): Promise<OpResult> {
  const skip = (detail: string): OpResult => ({ operation: op, status: 'omitida', detail });
  const ra = await usableRow(api, op.a, m);
  if (!ra.row) return skip(ra.why!);
  const rb = await usableRow(api, op.b, m);
  if (!rb.row) return skip(rb.why!);
  for (const r of [ra.row, rb.row]) if (r.transfer_id) return skip(m.opAlreadyTransfer(r.id));
  if (ra.row.account === rb.row.account) return skip(m.opSameAccount);
  if (ra.row.amount === 0 || ra.row.amount !== -rb.row.amount) return skip(m.opAmountsMismatch);

  // Y = la pata que sobrevive a la fusión: la importada si solo una lo es.
  const [x, y] = !rb.row.imported_id && ra.row.imported_id ? [rb.row, ra.row] : [ra.row, rb.row];
  const accountsList = ((await api.getAccounts()) ?? []) as any[];
  if (accountsList.find((acc) => acc.id === y.account)?.closed) return skip(m.opAccountUnavailable(y.account));
  const { byTransferAccount } = await getPayeeIndex(api);
  const transferPayee = byTransferAccount.get(y.account);
  if (!transferPayee) return skip(m.opNoTransferPayee(y.account));

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? COUNTERPART_POLL_ATTEMPTS;
  const delayMs = opts.delayMs ?? COUNTERPART_POLL_DELAY_MS;
  const originalPayee = x.payee ?? null;
  const originalCategory = x.category ?? null;
  let counterpartId = '';

  // ¿X volvió a su estado original y la contrapartida ya no existe?
  const isClean = async (): Promise<boolean> => {
    const cur = await getTransactionById(api, x.id);
    if (!cur || (cur.payee ?? null) !== originalPayee || cur.transfer_id) return false;
    return !counterpartId || !(await getTransactionById(api, counterpartId));
  };
  const pollClean = async (): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      if (await isClean()) return true;
      await sleep(delayMs);
    }
    return false;
  };

  const revert = async (detail: string): Promise<OpResult> => {
    const failed = (cause: string): OpResult => ({
      operation: op,
      status: 'fallida',
      detail: m.linkRevertFailed(x.id, counterpartId || '?', cause),
    });
    try {
      // Actual borra la contrapartida a la que apunte X al cambiarle el beneficiario: si X ya
      // apunta a otra fila que no es la que creamos, revertir destruiría esa otra.
      const now = await getTransactionById(api, x.id);
      if (now?.transfer_id && now.transfer_id !== counterpartId) {
        return failed(m.linkRevertUnsafe(now.transfer_id));
      }
      // Al crear la transferencia Actual limpia la categoría de X: se restaura junto al beneficiario.
      await api.updateTransaction(x.id, { payee: originalPayee, category: originalCategory });
      if (await pollClean()) return { operation: op, status: 'fallida', detail };
      // X′ puede quedar suelta (la fusión rompió los enlaces y falló): se borra solo si es seguro.
      const orphan = counterpartId ? await getTransactionById(api, counterpartId) : null;
      if (
        orphan && !orphan.imported_id && !orphan.reconciled &&
        (orphan.transfer_id === null || orphan.transfer_id === undefined || orphan.transfer_id === x.id)
      ) {
        await api.deleteTransaction(counterpartId);
        if (await pollClean()) return { operation: op, status: 'fallida', detail };
      }
      return failed(detail);
    } catch (err) {
      return failed(errMessage(err));
    }
  };

  await api.updateTransaction(x.id, { payee: transferPayee.id });
  for (let i = 0; i < attempts && !counterpartId; i++) {
    const current = await getTransactionById(api, x.id);
    if (current?.transfer_id && (await getTransactionById(api, current.transfer_id))) counterpartId = current.transfer_id;
    else await sleep(delayMs);
  }
  if (!counterpartId) return revert(m.linkNoCounterpart(x.id));

  try {
    await api.mergeTransactions([counterpartId, y.id]);
  } catch (err) {
    return revert(m.linkReverted(errMessage(err)));
  }

  const survivor = (await getTransactionById(api, y.id)) ?? (await getTransactionById(api, counterpartId));
  const xAfter = await getTransactionById(api, x.id);
  const linked = !!survivor && survivor.transfer_id === x.id && xAfter?.transfer_id === survivor.id;
  const keptImport = !y.imported_id || survivor?.imported_id === y.imported_id;
  if (!linked || !keptImport) return { operation: op, status: 'fallida', detail: m.linkUnverified(x.id, y.id) };
  return { operation: op, status: 'aplicada', survivor_id: survivor.id, transfer_id: survivor.id };
}

async function applyMerge(api: any, op: Extract<Operation, { type: 'merge' }>, m: Messages): Promise<OpResult> {
  const skip = (detail: string): OpResult => ({ operation: op, status: 'omitida', detail });
  const rk = await usableRow(api, op.keep, m);
  if (!rk.row) return skip(rk.why!);
  const rd = await usableRow(api, op.drop, m);
  if (!rd.row) return skip(rd.why!);
  const keep = rk.row;
  const drop = rd.row;
  if (!keep.imported_id || drop.imported_id || keep.account !== drop.account || keep.amount !== drop.amount) {
    return skip(m.opMergeShape);
  }
  if (keep.transfer_id) return skip(m.opAlreadyTransfer(keep.id));
  if (drop.transfer_id) {
    // Al fusionar, Actual reescribe el transfer_id de la contrapartida: debe existir y no estar conciliada.
    const counterpart = await getTransactionById(api, drop.transfer_id);
    if (!counterpart) return skip(m.opTxNotFound(drop.transfer_id));
    if (counterpart.reconciled) return skip(m.opCounterpartReconciled(counterpart.id));
  }

  try {
    await api.mergeTransactions([keep.id, drop.id]);
  } catch (err) {
    return { operation: op, status: 'fallida', detail: errMessage(err) };
  }
  const keepAfter = await getTransactionById(api, keep.id);
  const dropGone = !(await getTransactionById(api, drop.id));
  const linkCarried = !drop.transfer_id || keepAfter?.transfer_id === drop.transfer_id;
  if (!keepAfter || keepAfter.imported_id !== keep.imported_id || !dropGone || !linkCarried) {
    return { operation: op, status: 'fallida', detail: m.mergeUnverified(keep.id, drop.id) };
  }
  return { operation: op, status: 'aplicada', survivor_id: keep.id, transfer_id: keepAfter.transfer_id ?? null };
}

async function applyCreateTransfer(
  api: any,
  op: Extract<Operation, { type: 'create_transfer' }>,
  m: Messages,
): Promise<OpResult> {
  const skip = (detail: string): OpResult => ({ operation: op, status: 'omitida', detail });
  const rt = await usableRow(api, op.transaction, m);
  if (!rt.row) return skip(rt.why!);
  if (rt.row.transfer_id) return skip(m.opAlreadyTransfer(rt.row.id));
  const accounts = ((await api.getAccounts()) ?? []) as any[];
  const target = accounts.find((acc) => acc.id === op.account);
  if (!target || target.closed || target.id === rt.row.account) return skip(m.opAccountUnavailable(op.account));
  const { byTransferAccount } = await getPayeeIndex(api);
  const payee = byTransferAccount.get(op.account);
  if (!payee) return skip(m.opNoTransferPayee(op.account));

  await api.updateTransaction(op.transaction, { payee: payee.id });
  const { row } = await readBack(api, op.transaction, { payee: payee.id });
  return { operation: op, status: 'aplicada', transfer_id: row?.transfer_id ?? null };
}

export async function applyOperation(api: any, op: Operation, m: Messages, opts: ApplyOpts = {}): Promise<OpResult> {
  try {
    if (op.type === 'link') return await applyLink(api, op, m, opts);
    if (op.type === 'merge') return await applyMerge(api, op, m);
    return await applyCreateTransfer(api, op, m);
  } catch (err) {
    return { operation: op, status: 'fallida', detail: errMessage(err) };
  }
}
