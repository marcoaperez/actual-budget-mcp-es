// reconcile-detect.ts — reglas de detección de la conciliación (spec 2026-10-08, § Detection
// rules). Puras: reciben filas ya leídas y devuelven propuestas; nunca escriben.
import type { Messages } from './messages.js';
import { clearsCategory, type AccountInfo, type DetectInput, type Proposal, type TxRow } from './reconcile-model.js';
import { COMPENSATION_WINDOW_DAYS, daysApart, normalizeText, syncedAccountIds } from './reconcile-data.js';
import { toUnits } from './money.js';

export const LINK_MAX_DAYS = 3;
export const LINK_SURE_MAX_DAYS = 1;
export const MERGE_MAX_DAYS = 2;
export const DEFAULT_RANGE_DAYS = 90;
export const MIN_ACCOUNT_NAME_LENGTH = 3;
/** Margen (± días) en que la cuenta destino debe compensar el importe para que un create_transfer sea `alta`. */
export const COMPENSATION_DAYS = COMPENSATION_WINDOW_DAYS;
/** Términos de nómina, factura o impuesto: bajan a `dudosa` (sin acentos, en minúsculas). */
export const NON_TRANSFER_KEYWORDS = [
  'nomina', 'salario', 'factura', 'recibo', 'impuesto', 'iva', 'irpf', 'aeat', 'hacienda',
  'seguridad social', 'payroll', 'salary', 'invoice', 'tax',
];
/** Forma con acento para mostrarla en la razón. */
const KEYWORD_DISPLAY: Record<string, string> = { nomina: 'nómina' };

// Palabra completa: letras y dígitos cuentan como parte de la palabra (iva no casa con «privada»).
const KEYWORD_PATTERNS = NON_TRANSFER_KEYWORDS.map((k) => ({
  keyword: k,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${k.replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'u'),
}));

/** Primera palabra clave de nómina/factura/impuesto que aparece como palabra completa, o null. */
export function findKeyword(text: string): string | null {
  const t = normalizeText(text);
  return KEYWORD_PATTERNS.find((p) => p.re.test(t))?.keyword ?? null;
}

/** Fila de la cuenta destino con el MISMO importe con signo que x (lo contrario de la pata que crearía
 *  la transferencia) a ±COMPENSATION_DAYS. Admite transferencias y cualquier estado de conciliación. */
export function findCompensation(x: TxRow, targetAccount: string, targetRows: TxRow[]): TxRow | null {
  return (
    targetRows.find(
      (y) => y.id !== x.id && y.account === targetAccount && y.amount === x.amount && daysApart(x.date, y.date) <= COMPENSATION_DAYS,
    ) ?? null
  );
}

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

export function detectLinks(rows: TxRow[], m: Messages, accounts: AccountInfo[] = []): Proposal[] {
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
        clears_category: clearsCategory([x, y], [x.account, y.account], accounts),
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
      clears_category: false,
    };
  });
}

/** Razón legible si beneficiario, beneficiario importado o notas llevan una palabra clave; null si no. */
function keywordHit(x: TxRow, payeeName: string, m: Messages): string | null {
  const fields: [string, string][] = [
    [payeeName, m.fieldPayee],
    [x.imported_payee ?? '', m.fieldImportedPayee],
    [x.notes ?? '', m.fieldNotes],
  ];
  for (const [text, label] of fields) {
    const k = findKeyword(text);
    if (k) return m.reasonKeyword(KEYWORD_DISPLAY[k] ?? k, label);
  }
  return null;
}

export function detectCreateTransfers(input: DetectInput, m: Messages, linkable: Set<string>): Proposal[] {
  const synced = syncedAccountIds(input.accounts, input.rows);
  const manual = input.accounts.filter((a) => !a.closed && !synced.has(a.id));
  const out: Proposal[] = [];
  for (const x of input.rows) {
    if (!isOpen(x) || !synced.has(x.account) || linkable.has(x.id)) continue;
    const payeeName = (x.payee ? input.payeeNames.get(x.payee) : undefined) ?? '';
    const key = normalizeText(x.imported_payee ?? payeeName);
    const rawHistory = key ? [...(input.history.get(key) ?? [])] : [];
    const fromHistory = key
      ? rawHistory
          .map((id) => manual.find((a) => a.id === id))
          .filter((a): a is AccountInfo => !!a && a.id !== x.account)
      : [];
    if (fromHistory.length > 0) {
      const hit = keywordHit(x, payeeName, m);
      for (const target of fromHistory) {
        const comp = findCompensation(x, target.id, input.targetRows);
        const uniqueHistory = rawHistory.length === 1 && fromHistory.length === 1;
        const parts = [m.reasonCreateFromHistory(target.name)];
        if (hit) parts.push(hit);
        parts.push(
          comp
            ? m.reasonCompensated(comp.date, toUnits(comp.amount).toFixed(2))
            : m.reasonNotCompensated(COMPENSATION_DAYS),
        );
        out.push({
          operation: { type: 'create_transfer', transaction: x.id, account: target.id },
          confidence: uniqueHistory && !hit && comp ? 'alta' : 'dudosa',
          reason: parts.join('; '),
          transactions: [x],
          clears_category: clearsCategory([x], [x.account, target.id], input.accounts),
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
        clears_category: clearsCategory([x], [x.account, target.id], input.accounts),
      });
    }
  }
  return out;
}

const CONFIDENCE_ORDER = { alta: 0, dudosa: 1 } as const;

export function detectAll(input: DetectInput, m: Messages): Proposal[] {
  // Las fusiones van primero: un movimiento fusionado no se empareja ni se convierte en transferencia.
  const merges = detectMerges(input.rows, m);
  const inMerge = new Set(
    merges.flatMap((p) => (p.operation.type === 'merge' ? [p.operation.keep, p.operation.drop] : [])),
  );
  const links = detectLinks(input.rows.filter((r) => !inMerge.has(r.id)), m, input.accounts);
  const excluded = new Set([...links.flatMap((p) => p.transactions.map((t) => t.id)), ...inMerge]);
  return [...links, ...merges, ...detectCreateTransfers(input, m, excluded)].sort(
    (p, q) => CONFIDENCE_ORDER[p.confidence] - CONFIDENCE_ORDER[q.confidence],
  );
}
