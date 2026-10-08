// reconcile-model.ts — contratos de la conciliación (pieza A, spec 2026-10-08).
// Herramientas sin estado: las propuestas llevan la operación exacta, y quien aplica
// recibe esas operaciones (no ids de propuesta) y las revalida contra los datos del momento.
import { z } from 'zod';
import { ID } from './types.js';
import { moneyFields } from './money.js';

export type Confidence = 'alta' | 'dudosa';

export const OperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('link'), a: ID, b: ID }),
  z.object({ type: z.literal('create_transfer'), transaction: ID, account: ID }),
  z.object({ type: z.literal('merge'), keep: ID, drop: ID }),
]);
export type Operation = z.infer<typeof OperationSchema>;

/** Movimiento normalizado: lo único que leen las reglas de detección. Importe en céntimos. */
export interface TxRow {
  id: string;
  account: string;
  date: string;
  amount: number;
  imported_id: string | null;
  transfer_id: string | null;
  reconciled: boolean;
  cleared: boolean;
  payee: string | null;
  imported_payee: string | null;
  notes: string | null;
  /** id de categoría (null si no tiene). */
  category: string | null;
}

export interface AccountInfo {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
  /** balance_current solo lo rellena el bank-sync. */
  bankSynced: boolean;
}

export interface Proposal {
  operation: Operation;
  confidence: Confidence;
  reason: string;
  transactions: TxRow[];
  /** Convertir en transferencia entre cuentas del mismo lado del presupuesto limpia la categoría de ambas patas (Actual). */
  clears_category: boolean;
}

export interface DetectInput {
  rows: TxRow[];
  accounts: AccountInfo[];
  /** imported_payee normalizado → cuentas a las que ya se convirtió en transferencia. */
  history: Map<string, Set<string>>;
  payeeNames: Map<string, string>;
}

export function summarizeTx(row: TxRow, payeeNames: Map<string, string>, locale: string, currency: string) {
  const name = row.payee ? payeeNames.get(row.payee) : undefined;
  return {
    id: row.id,
    account_id: row.account,
    date: row.date,
    payee: name ?? row.imported_payee ?? null,
    category: row.category,
    imported: row.imported_id !== null,
    ...moneyFields(row.amount, locale, currency),
  };
}

export function presentProposal(p: Proposal, payeeNames: Map<string, string>, locale: string, currency: string) {
  return {
    operation: p.operation,
    confidence: p.confidence,
    reason: p.reason,
    clears_category: p.clears_category,
    transactions: p.transactions.map((t) => summarizeTx(t, payeeNames, locale, currency)),
  };
}

/**
 * ¿Hacer transferencia entre estas cuentas borrará categorías que hoy existen? Actual limpia la
 * categoría de ambas patas cuando las dos cuentas están del mismo lado del presupuesto
 * (ambas dentro o ambas fuera). Si no se conoce alguna cuenta, no se afirma nada.
 */
export function clearsCategory(rows: TxRow[], accountIds: string[], accounts: AccountInfo[]): boolean {
  const sides = accountIds.map((id) => accounts.find((a) => a.id === id)?.offbudget);
  if (sides.some((s) => s === undefined) || new Set(sides).size > 1) return false;
  return rows.some((r) => r.category !== null);
}
