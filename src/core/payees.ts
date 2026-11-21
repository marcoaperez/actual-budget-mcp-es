// payees.ts — payee index.
//
// Actual creates one hidden "transfer payee" per account, marked by transfer_acct.
// Pointing a transaction at one is what turns it into a transfer, so the lookup
// account -> transfer payee is the core of set_transaction_transfer.

import { activeMessages } from './messages.js';

export interface PayeeInfo {
  id: string;
  name: string;
  transfer_acct: string | null;
}

export async function getPayeeIndex(api: any): Promise<{
  byId: Map<string, PayeeInfo>;
  byTransferAccount: Map<string, PayeeInfo>;
  all: PayeeInfo[];
}> {
  const raw = (await api.getPayees()) ?? [];
  const all: PayeeInfo[] = (raw as any[]).map((p) => ({
    id: p.id,
    name: p.name,
    transfer_acct: p.transfer_acct ?? null,
  }));
  const byId = new Map<string, PayeeInfo>();
  const byTransferAccount = new Map<string, PayeeInfo>();
  for (const p of all) {
    byId.set(p.id, p);
    if (p.transfer_acct) byTransferAccount.set(p.transfer_acct, p);
  }
  return { byId, byTransferAccount, all };
}

/**
 * Resuelve un nombre de pagador a su id, creándolo si no existe (comparación sin
 * mayúsculas ni espacios sobrantes). Nunca resuelve a un pagador de transferencia:
 * asignarlo convertiría el movimiento en transferencia sin que nadie lo pidiera.
 */
export async function resolvePayeeName(api: any, name: string): Promise<string> {
  if (!name.trim()) throw new Error(activeMessages().payeeNameBlank);
  const wanted = name.trim().toLowerCase();
  const payees = ((await api.getPayees()) ?? []) as any[];
  const same = payees.filter((p) => (p.name ?? '').trim().toLowerCase() === wanted);
  const normal = same.find((p) => !p.transfer_acct);
  if (normal) return normal.id;
  if (same.length > 0) throw new Error(activeMessages().payeeNameIsTransfer(name.trim()));
  return await api.createPayee({ name: name.trim() });
}
