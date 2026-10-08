import { mockApi } from './mock-api.js';

/** Payee de transferencia simulado de una cuenta. */
export const transferPayeeOf = (accountId: string) => `tp-${accountId}`;

function matches(row: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object') {
      if ('$lte' in v && !(row[k] <= v.$lte)) return false;
      if ('$gte' in v && !(row[k] >= v.$gte)) return false;
      if ('$ne' in v && row[k] === v.$ne) return false;
      if ('$oneof' in v && !v.$oneof.includes(row[k])) return false;
      return true;
    }
    return row[k] === v;
  });
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function fakeLedger(setup: {
  accounts: any[];
  rows: any[];
  behaviour?: { counterpartAfterReads?: number; noCounterpart?: boolean; failMerge?: boolean; mergeLosesLink?: boolean; mergeDropsLinksThenFails?: boolean; writesLandAfterReads?: number; neverLandIds?: string[] };
}) {
  const b = setup.behaviour ?? {};
  const db = new Map<string, any>(
    setup.rows.map((r) => [r.id, { imported_id: null, transfer_id: null, reconciled: false, cleared: false, payee: null, is_parent: false, ...r }]),
  );
  let created = 0;
  let pendingCounterpart: (() => void) | null = null;
  let readsUntilCounterpart = 0;
  // Como api/transaction-update de Actual: la promesa resuelve antes de que la escritura aterrice.
  let pendingWrites: (() => void)[] = [];
  let readsUntilWrites = 0;

  const removeCounterpart = (row: any) => {
    if (row.transfer_id) db.delete(row.transfer_id);
    row.transfer_id = null;
  };

  const api = mockApi({
    getAccounts: async () => setup.accounts,
    getPayees: async () => setup.accounts.map((a) => ({ id: transferPayeeOf(a.id), name: a.name, transfer_acct: a.id })),
    getAccountBalance: async (id: string, cutoff?: Date) =>
      [...db.values()].filter((r) => r.account === id && (!cutoff || r.date <= localDay(cutoff))).reduce((s, r) => s + r.amount, 0),
    runQuery: async (q: any) => {
      if (pendingCounterpart && --readsUntilCounterpart <= 0) {
        pendingCounterpart();
        pendingCounterpart = null;
      }
      if (pendingWrites.length > 0 && --readsUntilWrites <= 0) {
        const landing = pendingWrites;
        pendingWrites = [];
        for (const land of landing) land();
      }
      const filter = Object.assign({}, ...(q.calls.filter ?? []));
      const data = [...db.values()].filter((r) => matches(r, filter));
      if (q.calls.calculate) return { data: data.reduce((s, r) => s + r.amount, 0) };
      return { data: data.map((r) => ({ ...r })) };
    },
    updateTransaction: async (id: string, fields: any) => {
      const row = db.get(id);
      if (!row) throw new Error(`no row ${id}`);
      if (b.writesLandAfterReads) {
        if (b.neverLandIds?.includes(id)) return [];
        if (pendingWrites.length === 0) readsUntilWrites = b.writesLandAfterReads;
        pendingWrites.push(() => Object.assign(row, fields));
        return [];
      }
      if ('payee' in fields) {
        const target = setup.accounts.find((a) => transferPayeeOf(a.id) === fields.payee);
        if (target && !row.transfer_id && !b.noCounterpart) {
          const make = () => {
            const cp = { id: `cp-${++created}`, account: target.id, date: row.date, amount: -row.amount, imported_id: null, transfer_id: id, reconciled: false, cleared: false, payee: transferPayeeOf(row.account), is_parent: false };
            db.set(cp.id, cp);
            row.transfer_id = cp.id;
            // Como addTransfer de Actual: con ambas cuentas del mismo lado del presupuesto se limpia la categoría.
            const srcAcct = setup.accounts.find((a) => a.id === row.account);
            if (!!srcAcct?.offbudget === !!target.offbudget) row.category = null;
          };
          if (b.counterpartAfterReads) {
            pendingCounterpart = make;
            readsUntilCounterpart = b.counterpartAfterReads;
          } else make();
        } else if (!target && row.transfer_id) {
          removeCounterpart(row);
        }
      }
      Object.assign(row, fields);
      return [];
    },
    deleteTransaction: async (id: string) => {
      db.delete(id);
    },
    mergeTransactions: async ([first, second]: [string, string]) => {
      if (b.failMerge) throw new Error('merge boom');
      if (b.mergeDropsLinksThenFails) {
        for (const id of [first, second]) {
          const r = db.get(id);
          const other = r?.transfer_id ? db.get(r.transfer_id) : null;
          if (other) other.transfer_id = null;
          if (r) r.transfer_id = null;
        }
        throw new Error('merge boom');
      }
      const r1 = db.get(first);
      const r2 = db.get(second);
      const keep = r1.imported_id && !r2.imported_id ? r1 : r2;
      const drop = keep === r1 ? r2 : r1;
      if (drop.transfer_id && !keep.transfer_id && !b.mergeLosesLink) {
        keep.transfer_id = drop.transfer_id;
        keep.payee = drop.payee;
        const other = db.get(drop.transfer_id);
        if (other) other.transfer_id = keep.id;
      }
      db.delete(drop.id);
      return keep.id;
    },
  });
  return { api, db };
}
