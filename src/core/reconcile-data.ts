// reconcile-data.ts — lecturas y utilidades de la conciliación: filas, cuentas,
// historial de transferencias y fechas. Nada de reglas aquí (eso es reconcile-detect).
import type { Messages } from './messages.js';
import { getPayeeIndex } from './payees.js';
import type { AccountInfo, DetectInput, TxRow } from './reconcile-model.js';

const TX_FIELDS = [
  'id', 'account', 'date', 'amount', 'imported_id', 'transfer_id', 'reconciled', 'cleared',
  'payee', 'imported_payee', 'notes', 'is_parent', 'is_child',
];
const MS_PER_DAY = 86_400_000;

export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysApart(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY);
}

/** Mediodía local del día D. getAccountBalance toma el día LOCAL del corte y lo incluye
 *  (spike 2026-10-08); el mediodía evita que un desfase horario lo mueva de día. */
export function closeOfDay(date: string): Date {
  return new Date(`${date}T12:00:00`);
}

export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function toTxRow(r: any): TxRow {
  return {
    id: r.id,
    account: r.account,
    date: r.date,
    amount: r.amount ?? 0,
    imported_id: r.imported_id ?? null,
    transfer_id: r.transfer_id ?? null,
    reconciled: !!r.reconciled,
    cleared: !!r.cleared,
    payee: r.payee ?? null,
    imported_payee: r.imported_payee ?? null,
    notes: r.notes ?? null,
  };
}

/** Movimientos sueltos del rango: sin padres ni hijos de split (no se concilian por separado). */
export async function loadTxRows(api: any, range: { start: string; end: string }): Promise<TxRow[]> {
  const { data } = await api.runQuery(
    api.q('transactions')
      .filter({ date: { $gte: range.start, $lte: range.end } })
      .options({ splits: 'all' })
      .select(TX_FIELDS),
  );
  return ((data ?? []) as any[]).filter((r) => !r.is_parent && !r.is_child).map(toTxRow);
}

export async function loadAccounts(api: any): Promise<AccountInfo[]> {
  const raw = ((await api.getAccounts()) ?? []) as any[];
  return raw.map((a) => ({
    id: a.id,
    name: a.name,
    offbudget: !!a.offbudget,
    closed: !!a.closed,
    bankSynced: a.balance_current !== null && a.balance_current !== undefined,
  }));
}

/** Cuentas sincronizadas con el banco: las que marca balance_current y, por si acaso,
 *  cualquiera con movimientos importados en las filas leídas. */
export function syncedAccountIds(accounts: AccountInfo[], rows: TxRow[]): Set<string> {
  const ids = new Set(accounts.filter((a) => a.bankSynced).map((a) => a.id));
  for (const r of rows) if (r.imported_id) ids.add(r.account);
  return ids;
}

export function resolveAccount(accounts: AccountInfo[], ref: string, m: Messages): AccountInfo {
  const byId = accounts.find((a) => a.id === ref);
  if (byId) return byId;
  const wanted = normalizeText(ref);
  const matches = accounts.filter((a) => normalizeText(a.name) === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(m.accountRefAmbiguous(ref, matches.map((a) => a.id)));
  throw new Error(m.accountRefNotFound(ref, accounts.filter((a) => !a.closed).map((a) => a.name)));
}

export async function loadTransferHistory(
  api: any,
  transferAcctByPayee: Map<string, string>,
): Promise<Map<string, Set<string>>> {
  const { data } = await api.runQuery(
    api.q('transactions')
      .filter({ transfer_id: { $ne: null }, imported_payee: { $ne: null } })
      .options({ splits: 'all' })
      .select(['imported_payee', 'payee']),
  );
  const history = new Map<string, Set<string>>();
  for (const r of (data ?? []) as any[]) {
    const target = r.payee ? transferAcctByPayee.get(r.payee) : undefined;
    if (!target || !r.imported_payee) continue;
    const key = normalizeText(r.imported_payee);
    if (!history.has(key)) history.set(key, new Set());
    history.get(key)!.add(target);
  }
  return history;
}

export async function loadDetectInput(api: any, range: { start: string; end: string }): Promise<DetectInput> {
  const [rows, accounts, payees] = await Promise.all([loadTxRows(api, range), loadAccounts(api), getPayeeIndex(api)]);
  const payeeNames = new Map(payees.all.map((p) => [p.id, p.name]));
  const transferAcctByPayee = new Map(
    payees.all.filter((p) => p.transfer_acct).map((p) => [p.id, p.transfer_acct as string]),
  );
  const history = await loadTransferHistory(api, transferAcctByPayee);
  return { rows, accounts, history, payeeNames };
}
