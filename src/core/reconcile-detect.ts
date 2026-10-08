// reconcile-detect.ts — reglas de detección de la conciliación (spec 2026-10-08, § Detection
// rules). Puras: reciben filas ya leídas y devuelven propuestas; nunca escriben.
import type { Messages } from './messages.js';
import type { AccountInfo, DetectInput, Proposal, TxRow } from './reconcile-model.js';
import { daysApart, normalizeText, syncedAccountIds } from './reconcile-data.js';

export const LINK_MAX_DAYS = 3;
export const LINK_SURE_MAX_DAYS = 1;
export const MERGE_MAX_DAYS = 2;
export const DEFAULT_RANGE_DAYS = 90;
export const MIN_ACCOUNT_NAME_LENGTH = 3;

/** Movimiento que aún puede enlazarse o convertirse en transferencia. */
const isOpen = (r: TxRow) => !r.reconciled && r.transfer_id === null && r.amount !== 0;

function linkCandidates(rows: TxRow[]): Map<string, TxRow[]> {
  const eligible = rows.filter(isOpen);
  const out = new Map<string, TxRow[]>();
  for (const x of eligible) {
    out.set(
      x.id,
      eligible.filter((y) => y.account !== x.account && y.amount === -x.amount && daysApart(x.date, y.date) <= LINK_MAX_DAYS),
    );
  }
  return out;
}

export function detectLinks(rows: TxRow[], m: Messages): Proposal[] {
  const candidates = linkCandidates(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: Proposal[] = [];
  for (const [xId, ys] of candidates) {
    const x = byId.get(xId)!;
    for (const y of ys) {
      const pairKey = [x.id, y.id].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const days = daysApart(x.date, y.date);
      const unique = ys.length === 1 && (candidates.get(y.id)?.length ?? 0) === 1;
      out.push({
        operation: { type: 'link', a: x.id, b: y.id },
        confidence: unique && days <= LINK_SURE_MAX_DAYS ? 'alta' : 'dudosa',
        reason: m.reasonLink(days, unique),
        transactions: [x, y],
      });
    }
  }
  return out;
}

export function detectMerges(rows: TxRow[], m: Messages): Proposal[] {
  // keep: el importado (lleva imported_id) y aún no es transferencia.
  // drop: el no importado; PUEDE ser una pata de transferencia creada a mano.
  const keeps = rows.filter((r) => r.imported_id !== null && !r.reconciled && r.transfer_id === null && r.amount !== 0);
  const drops = rows.filter((r) => r.imported_id === null && !r.reconciled && r.amount !== 0);
  const pairs: [TxRow, TxRow][] = [];
  for (const k of keeps) {
    for (const d of drops) {
      if (d.account === k.account && d.amount === k.amount && daysApart(d.date, k.date) <= MERGE_MAX_DAYS) pairs.push([k, d]);
    }
  }
  const pairsWith = (id: string) => pairs.filter(([k, d]) => k.id === id || d.id === id).length;
  return pairs.map(([k, d]): Proposal => {
    const days = daysApart(k.date, d.date);
    const unique = pairsWith(k.id) === 1 && pairsWith(d.id) === 1;
    return {
      operation: { type: 'merge', keep: k.id, drop: d.id },
      confidence: unique && days === 0 ? 'alta' : 'dudosa',
      reason: m.reasonMerge(days, unique),
      transactions: [k, d],
    };
  });
}

export function detectCreateTransfers(input: DetectInput, m: Messages, linkable: Set<string>): Proposal[] {
  const synced = syncedAccountIds(input.accounts, input.rows);
  const manual = input.accounts.filter((a) => !a.closed && !synced.has(a.id));
  const out: Proposal[] = [];
  for (const x of input.rows) {
    if (!isOpen(x) || !synced.has(x.account) || linkable.has(x.id)) continue;
    const payeeName = (x.payee ? input.payeeNames.get(x.payee) : undefined) ?? '';
    const key = normalizeText(x.imported_payee ?? payeeName);
    const fromHistory = key
      ? [...(input.history.get(key) ?? [])]
          .map((id) => manual.find((a) => a.id === id))
          .filter((a): a is AccountInfo => !!a && a.id !== x.account)
      : [];
    if (fromHistory.length > 0) {
      for (const target of fromHistory) {
        out.push({
          operation: { type: 'create_transfer', transaction: x.id, account: target.id },
          confidence: fromHistory.length === 1 ? 'alta' : 'dudosa',
          reason: m.reasonCreateFromHistory(target.name),
          transactions: [x],
        });
      }
      continue;
    }
    const haystack = normalizeText([payeeName, x.imported_payee ?? '', x.notes ?? ''].join(' '));
    for (const target of manual) {
      const name = normalizeText(target.name);
      if (target.id === x.account || name.length < MIN_ACCOUNT_NAME_LENGTH || !haystack.includes(name)) continue;
      out.push({
        operation: { type: 'create_transfer', transaction: x.id, account: target.id },
        confidence: 'dudosa',
        reason: m.reasonCreateFromName(target.name),
        transactions: [x],
      });
    }
  }
  return out;
}

const CONFIDENCE_ORDER = { alta: 0, dudosa: 1 } as const;

export function detectAll(input: DetectInput, m: Messages): Proposal[] {
  const links = detectLinks(input.rows, m);
  const linkable = new Set(links.flatMap((p) => p.transactions.map((t) => t.id)));
  return [...links, ...detectMerges(input.rows, m), ...detectCreateTransfers(input, m, linkable)].sort(
    (p, q) => CONFIDENCE_ORDER[p.confidence] - CONFIDENCE_ORDER[q.confidence],
  );
}
