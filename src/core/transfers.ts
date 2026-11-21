// transfers.ts — ayudas compartidas para trabajar con transferencias (y partes de split
// que son transferencias): cuenta destino de un pagador y lado de presupuesto.
import { getPayeeIndex } from './payees.js';

/** Cuenta a la que apunta un pagador de transferencia; null si no lo es (o no existe). */
export async function transferAccountOfPayee(api: any, payeeId: string | null): Promise<string | null> {
  if (!payeeId) return null;
  const { all } = await getPayeeIndex(api);
  return all.find((p) => p.id === payeeId)?.transfer_acct ?? null;
}

/**
 * ¿Las dos cuentas están del mismo lado (ambas en presupuesto o ambas fuera)?
 * null si alguna no se conoce: quien llama decide qué hacer sin confirmación.
 */
export function sameBudgetSide(
  accounts: Array<{ id: string; offbudget?: boolean | number }>,
  a: string,
  b: string,
): boolean | null {
  const accA = accounts.find((x) => x.id === a);
  const accB = accounts.find((x) => x.id === b);
  if (!accA || !accB) return null;
  return !!accA.offbudget === !!accB.offbudget;
}
