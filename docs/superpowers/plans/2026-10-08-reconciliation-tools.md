# Reconciliation Tools Implementation Plan (Piece A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four tools — `reconcile_account`, `find_transfer_issues`, `apply_reconciliation_fixes`, `mark_reconciled` — that let the user reconcile an Actual account against a bank statement balance, plus a warning in `set_transaction_transfer`, released as 2.4.0.

**Architecture:** Stateless tools with explicit operations (spec, *Piece A*). Three new core modules: `reconcile-model.ts` (types and the `Operation` Zod schema), `reconcile-data.ts` (AQL reads, account resolution, date helpers), `reconcile-detect.ts` (pure detection rules), plus `reconcile-apply.ts` (revalidate-and-apply one operation, including the spike-proven *transfer + merge* `link`). Tools are thin wrappers over those modules, following the existing `src/tools/*.ts` pattern.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod 4, Vitest, `@actual-app/api` 26.10.0, `tsx` for the integration subprocess.

**Spec:** `docs/superpowers/specs/2026-10-08-actual-26-10-reconciliation-design.md` (sections *Piece A* and *Spike results*).

## Global Constraints

- Tool names in English `snake_case`; every user-facing string (errors, reasons, notes) goes through `src/core/messages.ts` with **both** `es` and `en` entries of the same type and arity (enforced by `tests/core/messages.test.ts`).
- Amounts cross the tool boundary in units (decimals) and are converted only via `src/core/money.ts` (`toCents`, `moneyFields`). Detection compares integer cents exactly.
- Confidence values are exactly `'alta'` and `'dudosa'`; operation types exactly `'link'`, `'create_transfer'`, `'merge'`; per-operation statuses exactly `'aplicada'`, `'omitida'`, `'fallida'`.
- Windows: `LINK_MAX_DAYS = 3`, `LINK_SURE_MAX_DAYS = 1`, `MERGE_MAX_DAYS = 2`, `DEFAULT_RANGE_DAYS = 90`, `MIN_ACCOUNT_NAME_LENGTH = 3`, `MAX_OPERATIONS = 50`, `COUNTERPART_POLL_ATTEMPTS = 20`, `COUNTERPART_POLL_DELAY_MS = 50`.
- No tool ever writes to a reconciled transaction (no `force`). No fix may lose a transaction's `imported_id`.
- `link` = set X's payee to B's transfer payee, **poll** until X′ exists, then `mergeTransactions([X′, Y])`; Y is the imported leg when exactly one leg is imported. Never write `transfer_id` directly (spike: it destroys the bank leg).
- "Balance at close of day D" = `api.getAccountBalance(id, new Date('D' + 'T12:00:00'))` (local noon; the cutoff day is included).
- Write tools are `readOnly: false` (registered only with `ENABLE_WRITE`) and call `syncAfterWrite(api)` once at the end.
- Every new tool is added to `src/tools/index.ts` (`allTools`), to `manifest.json` `tools[]` (the manifest test requires an exact match) and to the tool tables of `README.md` and `README.es.md`.
- Never run anything against a real Actual server; integration uses the ephemeral `test/integration/docker-compose.actual.yml` (26.10.0, localhost:5006, `test-pass`).
- Version after this plan: **2.4.0**. Work on branch `feat/reconciliation` from `main`.

## Review Focus

- **Account given by name with different case/accents, or two accounts with the same name** → resolved case/accent-insensitively; ambiguity is an error that lists the candidate ids, never a silent pick. Pinned in Task 1.
- **Bank balance typed with decimals (`1234.56`)** → converted to cents exactly (123456), no float drift in the comparison. Pinned in Task 4 and Task 7.
- **Two genuine identical imported card payments on the same day** → never proposed as a duplicate. Pinned in Task 2.
- **A bank sync lands between proposing and applying** (the row is now a transfer, reconciled, or gone) → that operation is `omitida` with the reason, the rest still run. Pinned in Task 5.
- **The counterpart X′ is not visible right after the payee change** (spike: up to 250 ms) → `link` polls instead of failing. Pinned in Task 5.

---

### Task 1: Reconciliation model and data layer

**Files:**
- Create: `src/core/reconcile-model.ts`
- Create: `src/core/reconcile-data.ts`
- Modify: `src/core/messages.ts` (add `accountRefNotFound`, `accountRefAmbiguous` in the "No encontrado" block of `es` and `en`)
- Modify: `tests/helpers/mock-api.ts` (defaults for `getAccountBalance`, `mergeTransactions`)
- Test: `tests/core/reconcile-data.test.ts`

**Interfaces:**
- Consumes: `ID` (`src/core/types.ts`), `moneyFields` (`src/core/money.ts`), `getPayeeIndex` (`src/core/payees.ts`), `Messages` (`src/core/messages.ts`).
- Produces:
  ```ts
  // reconcile-model.ts
  export type Confidence = 'alta' | 'dudosa';
  export const OperationSchema: z.ZodDiscriminatedUnion<...>;
  export type Operation =
    | { type: 'link'; a: string; b: string }
    | { type: 'create_transfer'; transaction: string; account: string }
    | { type: 'merge'; keep: string; drop: string };
  export interface TxRow { id: string; account: string; date: string; amount: number; imported_id: string | null; transfer_id: string | null; reconciled: boolean; cleared: boolean; payee: string | null; imported_payee: string | null; notes: string | null }
  export interface AccountInfo { id: string; name: string; offbudget: boolean; closed: boolean; bankSynced: boolean }
  export interface Proposal { operation: Operation; confidence: Confidence; reason: string; transactions: TxRow[] }
  export interface DetectInput { rows: TxRow[]; accounts: AccountInfo[]; history: Map<string, Set<string>>; payeeNames: Map<string, string> }
  export function summarizeTx(row: TxRow, payeeNames: Map<string, string>, locale: string, currency: string): { id; account_id; date; payee: string | null; imported: boolean; amount: number; amount_formatted: string };
  export function presentProposal(p: Proposal, payeeNames: Map<string, string>, locale: string, currency: string): { operation; confidence; reason; transactions: ReturnType<typeof summarizeTx>[] };
  // reconcile-data.ts
  export function normalizeText(s: string): string;
  export function addDays(date: string, n: number): string;
  export function daysApart(a: string, b: string): number;
  export function closeOfDay(date: string): Date;
  export function todayLocal(now?: Date): string;
  export function toTxRow(r: any): TxRow;
  export async function loadTxRows(api: any, range: { start: string; end: string }): Promise<TxRow[]>;
  export async function loadAccounts(api: any): Promise<AccountInfo[]>;
  export function syncedAccountIds(accounts: AccountInfo[], rows: TxRow[]): Set<string>;
  export function resolveAccount(accounts: AccountInfo[], ref: string, m: Messages): AccountInfo;
  export async function loadTransferHistory(api: any, transferAcctByPayee: Map<string, string>): Promise<Map<string, Set<string>>>;
  export async function loadDetectInput(api: any, range: { start: string; end: string }): Promise<DetectInput>;
  ```

- [ ] **Step 1: Create the branch**

```bash
cd ~/GITs/Actual-MCP && git switch -c feat/reconciliation
```

- [ ] **Step 2: Add mock defaults**

In `tests/helpers/mock-api.ts`, inside the object returned by `mockApi`, after `deleteRule: vi.fn(async () => true),` add:

```ts
    getAccountBalance: vi.fn(async () => 0),
    mergeTransactions: vi.fn(async () => 'merged-id'),
```

- [ ] **Step 3: Write the failing tests**

Create `tests/core/reconcile-data.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeText, addDays, daysApart, closeOfDay, todayLocal, toTxRow, loadTxRows, loadAccounts,
  syncedAccountIds, resolveAccount, loadTransferHistory, loadDetectInput,
} from '../../src/core/reconcile-data.js';
import { summarizeTx } from '../../src/core/reconcile-model.js';
import { messagesFor } from '../../src/core/messages.js';
import { mockApi } from '../helpers/mock-api.js';

const m = messagesFor('es');
const acc = (over: any) => ({ id: 'a', name: 'Cuenta', offbudget: false, closed: false, bankSynced: false, ...over });
const row = (over: any) => toTxRow({ id: 't', account: 'a', date: '2026-09-15', amount: -100, ...over });

describe('helpers de texto y fecha', () => {
  it('normalizeText quita acentos, mayúsculas y espacios de los bordes', () => {
    expect(normalizeText('  Ahorro Vivienda ÉLITE ')).toBe('ahorro vivienda elite');
  });
  it('addDays cruza meses y años', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('daysApart es simétrico y en días enteros', () => {
    expect(daysApart('2026-09-15', '2026-09-18')).toBe(3);
    expect(daysApart('2026-09-18', '2026-09-15')).toBe(3);
  });
  it('closeOfDay cae en el día local pedido (getAccountBalance incluye ese día)', () => {
    const d = closeOfDay('2026-09-15');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 9, 15]);
  });
  it('todayLocal formatea la fecha local', () => {
    expect(todayLocal(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('toTxRow y loadTxRows', () => {
  it('normaliza nulls y booleanos', () => {
    const r = toTxRow({ id: 'x', account: 'a', date: '2026-09-15', amount: 5, reconciled: 1, cleared: 0 });
    expect(r).toEqual({
      id: 'x', account: 'a', date: '2026-09-15', amount: 5, imported_id: null, transfer_id: null,
      reconciled: true, cleared: false, payee: null, imported_payee: null, notes: null,
    });
  });
  it('lee el rango con splits all y descarta padres e hijos de split', async () => {
    const api = mockApi({
      runQuery: async () => ({ data: [
        { id: 'p', account: 'a', date: '2026-09-15', amount: -100, is_parent: true },
        { id: 'c', account: 'a', date: '2026-09-15', amount: -100, is_child: true },
        { id: 's', account: 'a', date: '2026-09-15', amount: -100 },
      ] }),
    });
    const rows = await loadTxRows(api, { start: '2026-09-01', end: '2026-09-30' });
    expect(rows.map((r) => r.id)).toEqual(['s']);
    const q = (api.q as any).mock.results[0].value;
    expect(q.calls.filter[0]).toEqual({ date: { $gte: '2026-09-01', $lte: '2026-09-30' } });
    expect(q.calls.options[0]).toEqual({ splits: 'all' });
  });
});

describe('cuentas', () => {
  it('loadAccounts marca bankSynced cuando el banco rellena balance_current', async () => {
    const api = mockApi({ getAccounts: async () => [
      { id: 'a', name: 'BBVA', balance_current: 1000 },
      { id: 'b', name: 'Efectivo', balance_current: null },
      { id: 'c', name: 'Viejo', closed: true },
    ] });
    const accounts = await loadAccounts(api);
    expect(accounts.map((a) => [a.id, a.bankSynced, a.closed])).toEqual([['a', true, false], ['b', false, false], ['c', false, true]]);
  });
  it('syncedAccountIds añade las cuentas con movimientos importados', () => {
    const ids = syncedAccountIds([acc({ id: 'a', bankSynced: true }), acc({ id: 'b' }), acc({ id: 'c' })], [row({ account: 'c', imported_id: 'imp' })]);
    expect([...ids].sort()).toEqual(['a', 'c']);
  });
  it('resolveAccount acepta el id', () => {
    expect(resolveAccount([acc({ id: 'x1', name: 'BBVA' })], 'x1', m).id).toBe('x1');
  });
  it('resolveAccount acepta el nombre sin importar mayúsculas ni acentos', () => {
    expect(resolveAccount([acc({ id: 'x1', name: 'Ahorro Vivienda' })], 'ahorro vivienda', m).id).toBe('x1');
    expect(resolveAccount([acc({ id: 'x2', name: 'Pensión' })], 'PENSION', m).id).toBe('x2');
  });
  it('resolveAccount falla si el nombre es ambiguo y lista los ids', () => {
    const accounts = [acc({ id: 'x1', name: 'Tarjeta' }), acc({ id: 'x2', name: 'tarjeta' })];
    expect(() => resolveAccount(accounts, 'Tarjeta', m)).toThrow(/x1.*x2/);
  });
  it('resolveAccount falla si no existe y lista las cuentas abiertas', () => {
    const accounts = [acc({ id: 'x1', name: 'BBVA' }), acc({ id: 'x2', name: 'Cerrada', closed: true })];
    let message = '';
    try { resolveAccount(accounts, 'Revolut', m); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/Revolut/);
    expect(message).toMatch(/BBVA/);
    expect(message).not.toMatch(/Cerrada/);
  });
});

describe('historial de transferencias', () => {
  it('agrupa por imported_payee normalizado las cuentas destino', async () => {
    const api = mockApi({ runQuery: async () => ({ data: [
      { imported_payee: 'TRASPASO AHORRO', payee: 'tp-ahorro' },
      { imported_payee: 'traspaso ahorro', payee: 'tp-ahorro' },
      { imported_payee: 'Cajero', payee: 'tp-cash' },
      { imported_payee: 'Otro', payee: 'normal-payee' },
    ] }) });
    const history = await loadTransferHistory(api, new Map([['tp-ahorro', 'acc-ahorro'], ['tp-cash', 'acc-cash']]));
    expect([...history.get('traspaso ahorro')!]).toEqual(['acc-ahorro']);
    expect([...history.get('cajero')!]).toEqual(['acc-cash']);
    expect(history.has('otro')).toBe(false);
  });
});

describe('loadDetectInput', () => {
  it('reúne filas, cuentas, historial y nombres de beneficiario', async () => {
    const api = mockApi({
      getAccounts: async () => [{ id: 'a', name: 'BBVA', balance_current: 1 }],
      getPayees: async () => [{ id: 'p1', name: 'Mercadona' }, { id: 'tp', name: 'BBVA', transfer_acct: 'a' }],
      runQuery: vi.fn(async () => ({ data: [] })),
    });
    const input = await loadDetectInput(api, { start: '2026-09-01', end: '2026-09-30' });
    expect(input.accounts[0].bankSynced).toBe(true);
    expect(input.payeeNames.get('p1')).toBe('Mercadona');
    expect(input.rows).toEqual([]);
    expect(input.history.size).toBe(0);
  });
});

describe('summarizeTx', () => {
  it('usa el nombre del beneficiario, o el importado si no lo hay, y convierte el importe', () => {
    const s = summarizeTx(row({ id: 'x', payee: 'p1', imported_id: 'i', amount: -1234 }), new Map([['p1', 'Mercadona']]), 'es-ES', 'EUR');
    expect(s).toMatchObject({ id: 'x', account_id: 'a', payee: 'Mercadona', imported: true, amount: -12.34 });
    expect(summarizeTx(row({ imported_payee: 'BIZUM' }), new Map(), 'es-ES', 'EUR').payee).toBe('BIZUM');
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run tests/core/reconcile-data.test.ts`
Expected: FAIL — modules `reconcile-data.js` / `reconcile-model.js` do not exist.

- [ ] **Step 5: Add the two messages**

In `src/core/messages.ts`, in the `es` object, right after `accountNotFound: …,` add:

```ts
  accountRefNotFound: (ref: string, names: string[]) =>
    `Cuenta no encontrada: "${ref}". Cuentas abiertas: ${names.join(', ')}`,
  accountRefAmbiguous: (ref: string, ids: string[]) =>
    `Hay varias cuentas llamadas "${ref}"; indica su id: ${ids.join(', ')}`,
```

and in the `en` object, right after its `accountNotFound: …,`:

```ts
  accountRefNotFound: (ref: string, names: string[]) =>
    `Account not found: "${ref}". Open accounts: ${names.join(', ')}`,
  accountRefAmbiguous: (ref: string, ids: string[]) =>
    `Several accounts are named "${ref}"; pass its id: ${ids.join(', ')}`,
```

- [ ] **Step 6: Create `src/core/reconcile-model.ts`**

```ts
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
    imported: row.imported_id !== null,
    ...moneyFields(row.amount, locale, currency),
  };
}

export function presentProposal(p: Proposal, payeeNames: Map<string, string>, locale: string, currency: string) {
  return {
    operation: p.operation,
    confidence: p.confidence,
    reason: p.reason,
    transactions: p.transactions.map((t) => summarizeTx(t, payeeNames, locale, currency)),
  };
}
```

- [ ] **Step 7: Create `src/core/reconcile-data.ts`**

```ts
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
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npx vitest run tests/core/reconcile-data.test.ts tests/core/messages.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/core/reconcile-model.ts src/core/reconcile-data.ts src/core/messages.ts tests/helpers/mock-api.ts tests/core/reconcile-data.test.ts
git commit -m "feat(reconcile): model and data layer for reconciliation"
```

---

### Task 2: Detection rules

**Files:**
- Create: `src/core/reconcile-detect.ts`
- Modify: `src/core/messages.ts` (add `reasonLink`, `reasonMerge`, `reasonCreateFromHistory`, `reasonCreateFromName` in a new block `// --- Conciliación ---` placed just before `// --- Infraestructura del presupuesto ---`, in `es` and `en`)
- Test: `tests/core/reconcile-detect.test.ts`

**Interfaces:**
- Consumes: `TxRow`, `AccountInfo`, `Proposal`, `DetectInput` (Task 1); `daysApart`, `normalizeText`, `syncedAccountIds` (Task 1).
- Produces:
  ```ts
  export const LINK_MAX_DAYS = 3;
  export const LINK_SURE_MAX_DAYS = 1;
  export const MERGE_MAX_DAYS = 2;
  export const DEFAULT_RANGE_DAYS = 90;
  export const MIN_ACCOUNT_NAME_LENGTH = 3;
  export function detectLinks(rows: TxRow[], m: Messages): Proposal[];
  export function detectMerges(rows: TxRow[], m: Messages): Proposal[];
  export function detectCreateTransfers(input: DetectInput, m: Messages, linkable: Set<string>): Proposal[];
  export function detectAll(input: DetectInput, m: Messages): Proposal[]; // 'alta' first, stable
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/core/reconcile-detect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectLinks, detectMerges, detectCreateTransfers, detectAll } from '../../src/core/reconcile-detect.js';
import { toTxRow } from '../../src/core/reconcile-data.js';
import type { AccountInfo, DetectInput } from '../../src/core/reconcile-model.js';
import { messagesFor } from '../../src/core/messages.js';

const m = messagesFor('es');
const tx = (over: any) => toTxRow({ account: 'A', date: '2026-09-15', amount: -100, ...over });
const acc = (over: Partial<AccountInfo>): AccountInfo => ({ id: 'A', name: 'Cuenta', offbudget: false, closed: false, bankSynced: false, ...over });
const input = (over: Partial<DetectInput>): DetectInput => ({ rows: [], accounts: [], history: new Map(), payeeNames: new Map(), ...over });

describe('detectLinks', () => {
  it('propone alta para la única pareja con importe contrario el mismo día', () => {
    const p = detectLinks([tx({ id: 'x', imported_id: 'i1' }), tx({ id: 'y', account: 'B', amount: 100, imported_id: 'i2' })], m);
    expect(p).toHaveLength(1);
    expect(p[0].operation).toEqual({ type: 'link', a: 'x', b: 'y' });
    expect(p[0].confidence).toBe('alta');
  });
  it('baja a dudosa con 2 o 3 días de diferencia y no propone a 4 días', () => {
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100, date: '2026-09-17' })], m)[0].confidence).toBe('dudosa');
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100, date: '2026-09-18' })], m)[0].confidence).toBe('dudosa');
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100, date: '2026-09-19' })], m)).toEqual([]);
  });
  it('con varias candidatas propone una dudosa por candidata', () => {
    const p = detectLinks([tx({ id: 'x' }), tx({ id: 'y1', account: 'B', amount: 100 }), tx({ id: 'y2', account: 'C', amount: 100 })], m);
    expect(p.map((q) => q.confidence)).toEqual(['dudosa', 'dudosa']);
  });
  it('emite cada pareja una sola vez', () => {
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100 })], m)).toHaveLength(1);
  });
  it('ignora conciliados, transferencias ya hechas, la misma cuenta y el importe cero', () => {
    expect(detectLinks([tx({ id: 'x', reconciled: true }), tx({ id: 'y', account: 'B', amount: 100 })], m)).toEqual([]);
    expect(detectLinks([tx({ id: 'x', transfer_id: 'z' }), tx({ id: 'y', account: 'B', amount: 100 })], m)).toEqual([]);
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', amount: 100 })], m)).toEqual([]);
    expect(detectLinks([tx({ id: 'x', amount: 0 }), tx({ id: 'y', account: 'B', amount: 0 })], m)).toEqual([]);
  });
});

describe('detectMerges', () => {
  it('propone alta para importado + manual iguales el mismo día, conservando el importado', () => {
    const p = detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man' })], m);
    expect(p).toHaveLength(1);
    expect(p[0].operation).toEqual({ type: 'merge', keep: 'imp', drop: 'man' });
    expect(p[0].confidence).toBe('alta');
  });
  it('baja a dudosa con 1-2 días y no propone a 3', () => {
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man', date: '2026-09-17' })], m)[0].confidence).toBe('dudosa');
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man', date: '2026-09-18' })], m)).toEqual([]);
  });
  it('NO propone dos importados iguales el mismo día (dos pagos reales)', () => {
    expect(detectMerges([tx({ id: 'a', imported_id: 'i1' }), tx({ id: 'b', imported_id: 'i2' })], m)).toEqual([]);
  });
  it('NO propone dos manuales iguales', () => {
    expect(detectMerges([tx({ id: 'a' }), tx({ id: 'b' })], m)).toEqual([]);
  });
  it('propone fusionar una pata de transferencia manual con el importado que la duplica', () => {
    const p = detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'leg', transfer_id: 'other' })], m);
    expect(p[0].operation).toEqual({ type: 'merge', keep: 'imp', drop: 'leg' });
  });
  it('ignora pares con algo conciliado o con el importado ya como transferencia', () => {
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i', reconciled: true }), tx({ id: 'man' })], m)).toEqual([]);
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man', reconciled: true })], m)).toEqual([]);
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i', transfer_id: 'z' }), tx({ id: 'man' })], m)).toEqual([]);
  });
});

describe('detectCreateTransfers', () => {
  const accounts = [
    acc({ id: 'A', name: 'BBVA', bankSynced: true }),
    acc({ id: 'CASH', name: 'Efectivo' }),
    acc({ id: 'PEN', name: 'Pensión' }),
    acc({ id: 'X', name: 'Ab' }),
  ];
  it('alta cuando el historial apunta a una sola cuenta manual', () => {
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'CAJERO 123' })], accounts,
      history: new Map([['cajero 123', new Set(['CASH'])]]),
    }), m, new Set());
    expect(p).toEqual([expect.objectContaining({ operation: { type: 'create_transfer', transaction: 'x', account: 'CASH' }, confidence: 'alta' })]);
  });
  it('dudosa por cada cuenta si el historial apunta a varias', () => {
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'Traspaso' })], accounts,
      history: new Map([['traspaso', new Set(['CASH', 'PEN'])]]),
    }), m, new Set());
    expect(p.map((q) => [q.operation, q.confidence])).toEqual([
      [{ type: 'create_transfer', transaction: 'x', account: 'CASH' }, 'dudosa'],
      [{ type: 'create_transfer', transaction: 'x', account: 'PEN' }, 'dudosa'],
    ]);
  });
  it('dudosa si el nombre de la cuenta aparece (sin acentos) en beneficiario o notas', () => {
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'APORTACION PENSION' })], accounts,
    }), m, new Set());
    expect(p).toEqual([expect.objectContaining({ operation: { type: 'create_transfer', transaction: 'x', account: 'PEN' }, confidence: 'dudosa' })]);
  });
  it('ignora nombres de cuenta demasiado cortos', () => {
    const p = detectCreateTransfers(input({ rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'ab cd' })], accounts }), m, new Set());
    expect(p).toEqual([]);
  });
  it('no propone si el movimiento tiene candidata de enlace o su cuenta no es sincronizada', () => {
    const rows = [tx({ id: 'x', imported_id: 'i', imported_payee: 'Efectivo' })];
    expect(detectCreateTransfers(input({ rows, accounts }), m, new Set(['x']))).toEqual([]);
    const manualRow = [tx({ id: 'y', account: 'CASH', notes: 'pensión' })];
    expect(detectCreateTransfers(input({ rows: manualRow, accounts }), m, new Set())).toEqual([]);
  });
});

describe('detectAll', () => {
  it('pone primero las de confianza alta', () => {
    const p = detectAll(input({
      rows: [
        tx({ id: 'x' }), tx({ id: 'y1', account: 'B', amount: 100 }), tx({ id: 'y2', account: 'C', amount: 100 }),
        tx({ id: 'imp', account: 'D', amount: -7, imported_id: 'i' }), tx({ id: 'man', account: 'D', amount: -7 }),
      ],
    }), m);
    expect(p[0].confidence).toBe('alta');
    expect(p[0].operation.type).toBe('merge');
    expect(p.slice(1).every((q) => q.confidence === 'dudosa')).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/core/reconcile-detect.test.ts`
Expected: FAIL — `reconcile-detect.js` does not exist.

- [ ] **Step 3: Add the messages**

In `src/core/messages.ts`, in `es`, insert before `// --- Infraestructura del presupuesto ---`:

```ts
  // --- Conciliación ---
  reasonLink: (days: number, unique: boolean) =>
    `Importes contrarios en dos cuentas con ${days} día(s) de diferencia` +
    (unique ? '; es la única pareja posible' : '; hay más de una pareja posible'),
  reasonMerge: (days: number, unique: boolean) =>
    `Mismo importe en la misma cuenta con ${days} día(s) de diferencia: uno vino del banco y el otro no` +
    (unique ? '' : '; hay más de un candidato'),
  reasonCreateFromHistory: (account: string) =>
    `Movimientos anteriores de este beneficiario se convirtieron en transferencias a "${account}"`,
  reasonCreateFromName: (account: string) => `El beneficiario o las notas mencionan la cuenta "${account}"`,
```

and in `en`, at the same place:

```ts
  // --- Reconciliation ---
  reasonLink: (days: number, unique: boolean) =>
    `Opposite amounts in two accounts, ${days} day(s) apart` +
    (unique ? '; it is the only possible pair' : '; there is more than one possible pair'),
  reasonMerge: (days: number, unique: boolean) =>
    `Same amount in the same account, ${days} day(s) apart: one came from the bank and the other did not` +
    (unique ? '' : '; there is more than one candidate'),
  reasonCreateFromHistory: (account: string) =>
    `Earlier transactions from this payee were turned into transfers to "${account}"`,
  reasonCreateFromName: (account: string) => `The payee or notes mention the account "${account}"`,
```

- [ ] **Step 4: Create `src/core/reconcile-detect.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/core/reconcile-detect.test.ts tests/core/messages.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/core/reconcile-detect.ts src/core/messages.ts tests/core/reconcile-detect.test.ts
git commit -m "feat(reconcile): detection rules for link, merge and create_transfer"
```

---

### Task 3: `find_transfer_issues` tool

**Files:**
- Create: `src/tools/find_transfer_issues.ts`
- Modify: `src/tools/index.ts` (import + add to `allTools`)
- Modify: `manifest.json` (`tools[]`: add `{ "name": "find_transfer_issues", "description": "Find unlinked transfers, duplicates and missing transfer legs, with proposed fixes" }` after `get_rules`)
- Modify: `README.md` (row in the "Read tools" table), `README.es.md` (row in its read-tools table)
- Test: `tests/tools/find_transfer_issues.test.ts`

**Interfaces:**
- Consumes: `loadDetectInput`, `addDays`, `todayLocal` (Task 1); `detectAll`, `LINK_MAX_DAYS`, `DEFAULT_RANGE_DAYS` (Task 2); `presentProposal` (Task 1); `ID`, `ToolDef` (`src/core/types.ts`); `msg`, `activeMessages` (`src/core/messages.ts`).
- Produces: tool `find_transfer_issues` (readOnly). Output: `{ start_date, end_date, total_count, alta_count, proposals: { link: P[], merge: P[], create_transfer: P[] } }` where `P` is `presentProposal(...)`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/find_transfer_issues.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/find_transfer_issues.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function apiWith(rows: any[]) {
  return mockApi({
    getAccounts: async () => [{ id: A, name: 'BBVA', balance_current: 1 }, { id: B, name: 'ING', balance_current: 1 }],
    getPayees: async () => [],
    runQuery: vi.fn(async (q: any) => ({ data: q.calls.filter?.[0]?.transfer_id ? [] : rows })),
  });
}

const x = { id: 'x', account: A, date: '2026-09-15', amount: -10000, imported_id: 'i1' };
const y = { id: 'y', account: B, date: '2026-09-16', amount: 10000, imported_id: 'i2' };

describe('find_transfer_issues', () => {
  it('agrupa las propuestas por tipo y cuenta las de alta', async () => {
    const r: any = await tool.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, { api: apiWith([x, y]), config: testConfig });
    expect(r.start_date).toBe('2026-09-01');
    expect(r.proposals.link).toHaveLength(1);
    expect(r.proposals.link[0].operation).toEqual({ type: 'link', a: 'x', b: 'y' });
    expect(r.proposals.link[0].transactions[0]).toMatchObject({ id: 'x', amount: -100 });
    expect(r.proposals.merge).toEqual([]);
    expect(r.total_count).toBe(1);
    expect(r.alta_count).toBe(1);
  });

  it('lee con margen de LINK_MAX_DAYS a cada lado y descarta propuestas fuera del rango', async () => {
    const api = apiWith([{ ...x, date: '2026-08-30' }, { ...y, date: '2026-08-31' }]);
    const r: any = await tool.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, { api, config: testConfig });
    const firstQuery = (api.q as any).mock.results[0].value;
    expect(firstQuery.calls.filter[0]).toEqual({ date: { $gte: '2026-08-29', $lte: '2026-10-03' } });
    expect(r.total_count).toBe(0);
  });

  it('por defecto revisa los últimos 90 días hasta hoy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 8, 10, 0));
    try {
      const r: any = await tool.handler({}, { api: apiWith([]), config: testConfig });
      expect(r.end_date).toBe('2026-10-08');
      expect(r.start_date).toBe('2026-07-10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('filtra por cuentas y rechaza una cuenta inexistente', async () => {
    const r: any = await tool.handler({ start_date: '2026-09-01', end_date: '2026-09-30', account_ids: [B] }, { api: apiWith([x, y]), config: testConfig });
    expect(r.total_count).toBe(1); // la pareja toca B
    const unknown = '99999999-9999-4999-8999-999999999999';
    await expect(tool.handler({ account_ids: [unknown] }, { api: apiWith([]), config: testConfig })).rejects.toThrow(unknown);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/tools/find_transfer_issues.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/tools/find_transfer_issues.ts`**

```ts
import { z } from 'zod';
import { ID, type ToolDef } from '../core/types.js';
import { msg, activeMessages } from '../core/messages.js';
import { addDays, loadDetectInput, todayLocal } from '../core/reconcile-data.js';
import { DEFAULT_RANGE_DAYS, LINK_MAX_DAYS, detectAll } from '../core/reconcile-detect.js';
import { presentProposal } from '../core/reconcile-model.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  start_date: DATE.optional().describe('First day to review (YYYY-MM-DD). Default: 90 days before end_date'),
  end_date: DATE.optional().describe('Last day to review (YYYY-MM-DD). Default: today'),
  account_ids: z.array(ID).optional().describe('Only proposals touching these accounts (from get_accounts)'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'find_transfer_issues',
  title: 'Find transfer issues',
  description:
    'Review a date range for reconciliation problems and propose fixes, each with a confidence (alta = clear, dudosa = check first): ' +
    'link (two existing opposite transactions in two accounts that should be one transfer), ' +
    'merge (a bank-imported transaction duplicated by a non-imported one in the same account) and ' +
    'create_transfer (a bank transaction that should be a transfer to a manually kept account). ' +
    'Writes nothing: pass the accepted operations to apply_reconciliation_fixes.',
  readOnly: true,
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const end = a.end_date ?? todayLocal();
    const start = a.start_date ?? addDays(end, -DEFAULT_RANGE_DAYS);

    const detectInput = await loadDetectInput(api, { start: addDays(start, -LINK_MAX_DAYS), end: addDays(end, LINK_MAX_DAYS) });
    for (const id of a.account_ids ?? []) {
      if (!detectInput.accounts.some((acc) => acc.id === id)) throw new Error(m.accountNotFound(id));
    }

    const proposals = detectAll(detectInput, m).filter((p) =>
      p.transactions.some(
        (t) => t.date >= start && t.date <= end && (!a.account_ids || a.account_ids.includes(t.account)),
      ),
    );
    const present = (type: string) =>
      proposals
        .filter((p) => p.operation.type === type)
        .map((p) => presentProposal(p, detectInput.payeeNames, config.locale, config.currency));
    return {
      start_date: start,
      end_date: end,
      total_count: proposals.length,
      alta_count: proposals.filter((p) => p.confidence === 'alta').length,
      proposals: { link: present('link'), merge: present('merge'), create_transfer: present('create_transfer') },
    };
  },
};
```

- [ ] **Step 4: Register it**

In `src/tools/index.ts` add `import { tool as findTransferIssues } from './find_transfer_issues.js';` with the other imports and append `findTransferIssues` to the `allTools` array (after `getRules`). Add the manifest entry listed under **Files**. In `README.md`, in the "Read tools" table, after the `get_rules` row add:

```markdown
| `find_transfer_issues` | Review a date range for transfers that are not linked, bank-imported transactions duplicated by manual ones, and bank transactions that should be transfers to a manual account; proposes each fix with a confidence (`alta`/`dudosa`) and writes nothing |
```

In `README.es.md`, after the `get_rules` row of its read-tools table:

```markdown
| `find_transfer_issues` | Revisa un rango de fechas en busca de transferencias sin enlazar, movimientos del banco duplicados por otros manuales y movimientos del banco que deberían ser transferencias a una cuenta manual; propone cada arreglo con su confianza (`alta`/`dudosa`) y no escribe nada |
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/tools/find_transfer_issues.test.ts tests/bundle/manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/tools/find_transfer_issues.ts src/tools/index.ts manifest.json README.md README.es.md tests/tools/find_transfer_issues.test.ts
git commit -m "feat(reconcile): find_transfer_issues tool"
```

---

### Task 4: `reconcile_account` tool

**Files:**
- Create: `src/tools/reconcile_account.ts`
- Modify: `src/core/messages.ts` (add `reconcileMatchesNext`, `reconcileHintExtra` to the Conciliación block, `es` and `en`)
- Modify: `src/tools/index.ts`, `manifest.json` (`{ "name": "reconcile_account", "description": "Compare an account with the bank balance at a date and explain the difference" }` after `find_transfer_issues`), `README.md`, `README.es.md`
- Test: `tests/tools/reconcile_account.test.ts`

**Interfaces:**
- Consumes: `loadAccounts`, `resolveAccount`, `loadDetectInput`, `closeOfDay`, `addDays` (Task 1); `detectAll`, `LINK_MAX_DAYS`, `DEFAULT_RANGE_DAYS` (Task 2); `presentProposal`, `summarizeTx` (Task 1); `toCents`, `moneyFields`.
- Produces: tool `reconcile_account` (readOnly). Output: `{ account: { id, name }, date, bank_balance, actual_balance, difference, reconciled_balance, matches: boolean, next_step?: string, proposals: P[], hints: (summary & { note: string })[] }`; money fields are `moneyFields(...)` objects. `difference = bank − actual`. A hint is an unreconciled transaction in the account dated ≤ date with `amount === −difference` (removing it would close the gap).

- [ ] **Step 1: Write the failing test**

Create `tests/tools/reconcile_account.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { tool } from '../../src/tools/reconcile_account.js';
import { mockApi, testConfig } from '../helpers/mock-api.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function apiWith(opts: { balance: number; reconciledSum?: number; rows?: any[] }) {
  return mockApi({
    getAccounts: async () => [{ id: A, name: 'BBVA Nómina', balance_current: 1 }, { id: B, name: 'ING', balance_current: 1 }],
    getPayees: async () => [],
    getAccountBalance: vi.fn(async () => opts.balance),
    runQuery: vi.fn(async (q: any) => {
      if (q.calls.calculate) return { data: opts.reconciledSum ?? 0 };
      if (q.calls.filter?.[0]?.transfer_id) return { data: [] };
      return { data: opts.rows ?? [] };
    }),
  });
}

describe('reconcile_account', () => {
  it('cuadra: diferencia cero, sugiere mark_reconciled y no propone nada', async () => {
    const api = apiWith({ balance: 123456, reconciledSum: 100000 });
    const r: any = await tool.handler({ account: 'bbva nomina', bank_balance: 1234.56, date: '2026-09-30' }, { api, config: testConfig });
    expect(r.account).toEqual({ id: A, name: 'BBVA Nómina' });
    expect(r.matches).toBe(true);
    expect(r.difference.amount).toBe(0);
    expect(r.reconciled_balance.amount).toBe(1000);
    expect(r.next_step).toMatch(/mark_reconciled/);
    expect(r.proposals).toEqual([]);
  });

  it('pide el saldo al cierre del día (mediodía local de la fecha)', async () => {
    const api = apiWith({ balance: 0 });
    await tool.handler({ account: A, bank_balance: 0, date: '2026-09-30' }, { api, config: testConfig });
    const [id, cutoff] = (api.getAccountBalance as any).mock.calls[0];
    expect(id).toBe(A);
    expect([cutoff.getFullYear(), cutoff.getMonth() + 1, cutoff.getDate()]).toEqual([2026, 9, 30]);
  });

  it('no cuadra: devuelve la diferencia, las propuestas de esa cuenta y las pistas por importe', async () => {
    const rows = [
      { id: 'x', account: A, date: '2026-09-15', amount: -10000, imported_id: 'i1' },
      { id: 'y', account: B, date: '2026-09-15', amount: 10000, imported_id: 'i2' },
      { id: 'dup', account: A, date: '2026-09-20', amount: -2500 },
      { id: 'later', account: A, date: '2026-10-05', amount: -2500 },
    ];
    // banco 1000,00 y Actual 975,00 → diferencia +25,00 → sobra en Actual un movimiento de -25,00
    const api = apiWith({ balance: 97500, rows });
    const r: any = await tool.handler({ account: 'BBVA Nómina', bank_balance: 1000, date: '2026-09-30' }, { api, config: testConfig });
    expect(r.matches).toBe(false);
    expect(r.difference.amount).toBe(25);
    expect(r.proposals.map((p: any) => p.operation.type)).toEqual(['link']);
    expect(r.hints.map((h: any) => h.id)).toEqual(['dup']);
    expect(r.hints[0].note).toBeTruthy();
  });

  it('falla con un mensaje útil si la cuenta no existe', async () => {
    await expect(tool.handler({ account: 'Revolut', bank_balance: 1, date: '2026-09-30' }, { api: apiWith({ balance: 0 }), config: testConfig }))
      .rejects.toThrow(/Revolut.*BBVA Nómina/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/tools/reconcile_account.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the messages**

In the Conciliación block of `es`:

```ts
  reconcileMatchesNext: 'El saldo cuadra. Si quieres fijarlo, usa mark_reconciled con la misma fecha y saldo',
  reconcileHintExtra: 'Su importe es exactamente la diferencia: puede que sobre en Actual (duplicado o mal fechado)',
```

In the Reconciliation block of `en`:

```ts
  reconcileMatchesNext: 'The balance matches. To lock it in, call mark_reconciled with the same date and balance',
  reconcileHintExtra: 'Its amount is exactly the difference: it may be extra in Actual (duplicate or wrong date)',
```

- [ ] **Step 4: Create `src/tools/reconcile_account.ts`**

```ts
import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { msg, activeMessages } from '../core/messages.js';
import { moneyFields, toCents } from '../core/money.js';
import { addDays, closeOfDay, loadAccounts, loadDetectInput, resolveAccount } from '../core/reconcile-data.js';
import { DEFAULT_RANGE_DAYS, LINK_MAX_DAYS, detectAll } from '../core/reconcile-detect.js';
import { presentProposal, summarizeTx } from '../core/reconcile-model.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  account: z.string().min(1).describe('Account id or exact name (case and accents are ignored)'),
  bank_balance: z.number().describe('Balance the bank shows at the close of date, in account currency units (e.g. 1234.56)'),
  date: DATE.describe('Statement date (YYYY-MM-DD); transactions dated that day are included'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'reconcile_account',
  title: 'Reconcile account against bank',
  description:
    'Compare an account with the balance the bank shows at the close of a date. Returns the Actual balance at that ' +
    'date, the difference (bank − Actual), the already reconciled balance, and when they differ the proposed fixes ' +
    'touching this account (see find_transfer_issues) plus transactions whose amount alone explains the gap. Writes nothing.',
  readOnly: true,
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const money = (cents: number) => moneyFields(cents, config.locale, config.currency);

    const account = resolveAccount(await loadAccounts(api), a.account, m);
    const bank = toCents(a.bank_balance);
    const actual: number = await api.getAccountBalance(account.id, closeOfDay(a.date));
    const { data: reconciledSum } = await api.runQuery(
      api.q('transactions')
        .filter({ account: account.id, reconciled: true, date: { $lte: a.date } })
        .options({ splits: 'inline' })
        .calculate({ $sum: '$amount' }),
    );
    const difference = bank - actual;
    const base = {
      account: { id: account.id, name: account.name },
      date: a.date,
      bank_balance: money(bank),
      actual_balance: money(actual),
      difference: money(difference),
      reconciled_balance: money(reconciledSum ?? 0),
      matches: difference === 0,
    };
    if (difference === 0) return { ...base, next_step: m.reconcileMatchesNext, proposals: [], hints: [] };

    const detectInput = await loadDetectInput(api, {
      start: addDays(a.date, -(DEFAULT_RANGE_DAYS + LINK_MAX_DAYS)),
      end: addDays(a.date, LINK_MAX_DAYS),
    });
    const proposals = detectAll(detectInput, m).filter((p) =>
      p.transactions.some((t) => t.account === account.id && t.date <= a.date),
    );
    const hints = detectInput.rows
      .filter((r) => r.account === account.id && r.date <= a.date && !r.reconciled && r.amount === -difference)
      .map((r) => ({ ...summarizeTx(r, detectInput.payeeNames, config.locale, config.currency), note: m.reconcileHintExtra }));
    return {
      ...base,
      proposals: proposals.map((p) => presentProposal(p, detectInput.payeeNames, config.locale, config.currency)),
      hints,
    };
  },
};
```

- [ ] **Step 5: Register it**

`src/tools/index.ts`: import `{ tool as reconcileAccount } from './reconcile_account.js'` and append `reconcileAccount` after `findTransferIssues`. Add the manifest entry. `README.md` read-tools table, after `find_transfer_issues`:

```markdown
| `reconcile_account` | Compare an account (id or name) with the balance the bank shows at the close of a date: Actual balance, difference, reconciled balance and, if they differ, the proposed fixes for that account and the transactions whose amount alone explains the gap. Writes nothing |
```

`README.es.md`, after `find_transfer_issues`:

```markdown
| `reconcile_account` | Compara una cuenta (id o nombre) con el saldo que da el banco al cierre de una fecha: saldo en Actual, diferencia, saldo conciliado y, si no cuadra, los arreglos propuestos para esa cuenta y los movimientos cuyo importe explica por sí solo la diferencia. No escribe nada |
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/tools/reconcile_account.test.ts tests/bundle/manifest.test.ts tests/core/messages.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/tools/reconcile_account.ts src/core/messages.ts src/tools/index.ts manifest.json README.md README.es.md tests/tools/reconcile_account.test.ts
git commit -m "feat(reconcile): reconcile_account tool"
```

---

### Task 5: Apply one operation (revalidate, link via transfer + merge, merge, create_transfer)

**Files:**
- Create: `src/core/reconcile-apply.ts`
- Create: `tests/helpers/fake-ledger.ts`
- Modify: `src/core/messages.ts` (operation messages in the Conciliación block, `es` and `en`)
- Test: `tests/core/reconcile-apply.test.ts`

**Interfaces:**
- Consumes: `Operation` (Task 1); `getTransactionById`, `readBack` (`src/core/tx-read.ts`); `getPayeeIndex` (`src/core/payees.ts`); `Messages`.
- Produces:
  ```ts
  export const COUNTERPART_POLL_ATTEMPTS = 20;
  export const COUNTERPART_POLL_DELAY_MS = 50;
  export type OpStatus = 'aplicada' | 'omitida' | 'fallida';
  export interface OpResult { operation: Operation; status: OpStatus; detail?: string; transfer_id?: string | null; survivor_id?: string }
  export interface ApplyOpts { sleep?: (ms: number) => Promise<void>; attempts?: number; delayMs?: number }
  export async function applyOperation(api: any, op: Operation, m: Messages, opts?: ApplyOpts): Promise<OpResult>;
  // tests/helpers/fake-ledger.ts
  export function fakeLedger(setup: { accounts: any[]; rows: any[]; behaviour?: { counterpartAfterReads?: number; noCounterpart?: boolean; failMerge?: boolean; mergeLosesLink?: boolean } }): { api: any; db: Map<string, any> };
  ```

- [ ] **Step 1: Create the fake ledger test helper**

Create `tests/helpers/fake-ledger.ts`. It simulates the Actual behaviour the spike measured: pointing a transaction at an account's transfer payee creates a linked counterpart there (optionally only after N reads, like the real async creation); clearing the transfer payee deletes it; `mergeTransactions` keeps the row with `imported_id` (else the second argument), carries the transfer link over to the survivor and deletes the other.

```ts
import { vi } from 'vitest';
import { mockApi } from './mock-api.js';

/** Payee de transferencia simulado de una cuenta. */
export const transferPayeeOf = (accountId: string) => `tp-${accountId}`;

function matches(row: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object') {
      if ('$lte' in v && !(row[k] <= v.$lte)) return false;
      if ('$gte' in v && !(row[k] >= v.$gte)) return false;
      if ('$ne' in v && row[k] === v.$ne) return false;
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
  behaviour?: { counterpartAfterReads?: number; noCounterpart?: boolean; failMerge?: boolean; mergeLosesLink?: boolean };
}) {
  const b = setup.behaviour ?? {};
  const db = new Map<string, any>(
    setup.rows.map((r) => [r.id, { imported_id: null, transfer_id: null, reconciled: false, cleared: false, payee: null, is_parent: false, ...r }]),
  );
  let created = 0;
  let pendingCounterpart: (() => void) | null = null;
  let readsUntilCounterpart = 0;

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
      const filter = Object.assign({}, ...(q.calls.filter ?? []));
      const data = [...db.values()].filter((r) => matches(r, filter));
      if (q.calls.calculate) return { data: data.reduce((s, r) => s + r.amount, 0) };
      return { data: data.map((r) => ({ ...r })) };
    },
    updateTransaction: async (id: string, fields: any) => {
      const row = db.get(id);
      if (!row) throw new Error(`no row ${id}`);
      if ('payee' in fields) {
        const target = setup.accounts.find((a) => transferPayeeOf(a.id) === fields.payee);
        if (target && !row.transfer_id && !b.noCounterpart) {
          const make = () => {
            const cp = { id: `cp-${++created}`, account: target.id, date: row.date, amount: -row.amount, imported_id: null, transfer_id: id, reconciled: false, cleared: false, payee: transferPayeeOf(row.account), is_parent: false };
            db.set(cp.id, cp);
            row.transfer_id = cp.id;
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
    mergeTransactions: async ([first, second]: [string, string]) => {
      if (b.failMerge) throw new Error('merge boom');
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
```

- [ ] **Step 2: Write the failing tests**

Create `tests/core/reconcile-apply.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyOperation } from '../../src/core/reconcile-apply.js';
import { messagesFor } from '../../src/core/messages.js';
import { fakeLedger, transferPayeeOf } from '../helpers/fake-ledger.js';

const m = messagesFor('es');
const noSleep = { sleep: async () => {} };
const accounts = [{ id: 'A', name: 'BBVA' }, { id: 'B', name: 'ING' }, { id: 'CASH', name: 'Efectivo' }, { id: 'OLD', name: 'Vieja', closed: true }];
const x = { id: 'x', account: 'A', date: '2026-09-15', amount: -10000, imported_id: 'ix', payee: 'p-orig' };
const y = { id: 'y', account: 'B', date: '2026-09-16', amount: 10000, imported_id: 'iy' };

describe('link', () => {
  it('enlaza dos patas importadas conservando ambos imported_id y sin restos', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y] });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(db.get('x').transfer_id).toBe('y');
    expect(db.get('y').transfer_id).toBe('x');
    expect(db.get('x').imported_id).toBe('ix');
    expect(db.get('y').imported_id).toBe('iy');
    expect(db.size).toBe(2);
    expect(r.survivor_id).toBe('y');
  });

  it('cambia el beneficiario de la pata NO importada para que sobreviva la importada', async () => {
    const manualX = { ...x, imported_id: null };
    const { api, db } = fakeLedger({ accounts, rows: [y, manualX] });
    const r = await applyOperation(api, { type: 'link', a: 'y', b: 'x' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(api.updateTransaction).toHaveBeenCalledWith('x', { payee: transferPayeeOf('B') });
    expect(db.get('y').imported_id).toBe('iy');
    expect(db.get('y').transfer_id).toBe('x');
  });

  it('espera a que aparezca la contrapartida (creación asíncrona)', async () => {
    const { api } = fakeLedger({ accounts, rows: [x, y], behaviour: { counterpartAfterReads: 4 } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('aplicada');
  });

  it('si la contrapartida no aparece, revierte el beneficiario y falla', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { noCounterpart: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, { ...noSleep, attempts: 3 });
    expect(r.status).toBe('fallida');
    expect(db.get('x').payee).toBe('p-orig');
    expect(db.get('x').transfer_id).toBeNull();
  });

  it('si la fusión falla, revierte (borra la contrapartida) y falla', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { failMerge: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/merge boom/);
    expect(db.size).toBe(2);
    expect(db.get('x').transfer_id).toBeNull();
    expect(db.get('x').payee).toBe('p-orig');
  });

  it('falla sin revertir si tras fusionar el enlace no cuadra, con los ids', async () => {
    const { api } = fakeLedger({ accounts, rows: [x, y], behaviour: { mergeLosesLink: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/x/);
    expect(r.detail).toMatch(/y/);
  });

  it('omite si algo cambió entre proponer y aplicar', async () => {
    const cases: [any[], string][] = [
      [[{ ...x, reconciled: true }, y], 'conciliad'],
      [[{ ...x, transfer_id: 'zz' }, y], 'transferencia'],
      [[x, { ...y, amount: 9999 }], 'importe'],
      [[x, { ...y, account: 'A' }], 'misma cuenta'],
      [[x], 'y'],
    ];
    for (const [rows, why] of cases) {
      const { api } = fakeLedger({ accounts, rows });
      const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
      expect(r.status, why).toBe('omitida');
      expect(r.detail).toMatch(new RegExp(why, 'i'));
      expect(api.updateTransaction).not.toHaveBeenCalled();
    }
  });
});

describe('merge', () => {
  const imp = { id: 'imp', account: 'B', date: '2026-09-15', amount: 2500, imported_id: 'ib' };
  const man = { id: 'man', account: 'B', date: '2026-09-15', amount: 2500 };

  it('conserva el importado y borra el duplicado', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [imp, man] });
    const r = await applyOperation(api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(db.has('man')).toBe(false);
    expect(db.get('imp').imported_id).toBe('ib');
  });

  it('si el duplicado era una pata de transferencia, el enlace pasa al importado', async () => {
    const other = { id: 'o', account: 'A', date: '2026-09-15', amount: -2500, transfer_id: 'man' };
    const { api, db } = fakeLedger({ accounts, rows: [imp, { ...man, transfer_id: 'o' }, other] });
    const r = await applyOperation(api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(db.get('imp').transfer_id).toBe('o');
    expect(db.get('o').transfer_id).toBe('imp');
  });

  it('omite si keep no es el importado o drop sí lo es', async () => {
    const { api } = fakeLedger({ accounts, rows: [imp, man] });
    expect((await applyOperation(api, { type: 'merge', keep: 'man', drop: 'imp' }, m, noSleep)).status).toBe('omitida');
    const both = fakeLedger({ accounts, rows: [imp, { ...man, imported_id: 'other' }] });
    expect((await applyOperation(both.api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep)).status).toBe('omitida');
  });

  it('falla con los ids si el enlace de la transferencia no pasó al superviviente', async () => {
    const other = { id: 'o', account: 'A', date: '2026-09-15', amount: -2500, transfer_id: 'man' };
    const { api } = fakeLedger({ accounts, rows: [imp, { ...man, transfer_id: 'o' }, other], behaviour: { mergeLosesLink: true } });
    const r = await applyOperation(api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/imp/);
  });
});

describe('create_transfer', () => {
  const bank = { id: 'w', account: 'A', date: '2026-09-15', amount: -5000, imported_id: 'iw' };

  it('apunta el movimiento al beneficiario de transferencia y devuelve la contrapartida', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [bank] });
    const r = await applyOperation(api, { type: 'create_transfer', transaction: 'w', account: 'CASH' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(r.transfer_id).toBe(db.get('w').transfer_id);
    expect(db.get(r.transfer_id!).account).toBe('CASH');
  });

  it('omite si la cuenta destino está cerrada, no existe o es la misma', async () => {
    for (const account of ['OLD', 'NOPE', 'A']) {
      const { api } = fakeLedger({ accounts, rows: [bank] });
      expect((await applyOperation(api, { type: 'create_transfer', transaction: 'w', account }, m, noSleep)).status).toBe('omitida');
    }
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/core/reconcile-apply.test.ts`
Expected: FAIL — `reconcile-apply.js` does not exist.

- [ ] **Step 4: Add the operation messages**

In the Conciliación block of `es`:

```ts
  opTxNotFound: (id: string) => `El movimiento ${id} ya no existe`,
  opSplitRow: (id: string) => `El movimiento ${id} forma parte de un split`,
  opReconciled: (id: string) => `El movimiento ${id} está conciliado y no se toca`,
  opAlreadyTransfer: (id: string) => `El movimiento ${id} ya es una transferencia`,
  opSameAccount: 'Los dos movimientos están en la misma cuenta',
  opAmountsMismatch: 'Los importes ya no se corresponden',
  opMergeShape: 'Para fusionar, keep debe ser el movimiento importado del banco y drop el no importado, en la misma cuenta y con el mismo importe',
  opAccountUnavailable: (id: string) => `La cuenta ${id} no existe, está cerrada o es la del propio movimiento`,
  opNoTransferPayee: (id: string) => `La cuenta ${id} no tiene beneficiario de transferencia`,
  linkNoCounterpart: (id: string) => `Actual no creó la contrapartida de ${id}; se ha revertido el cambio`,
  linkReverted: (cause: string) => `Falló al fusionar (${cause}); se ha revertido el cambio`,
  linkRevertFailed: (x: string, counterpart: string, cause: string) =>
    `Falló y no se pudo revertir (${cause}): revisa a mano ${x} y la contrapartida ${counterpart}`,
  linkUnverified: (x: string, y: string) => `Tras fusionar, ${x} y ${y} no quedaron enlazados: revísalos a mano`,
  mergeUnverified: (keep: string, drop: string) =>
    `Tras fusionar ${drop} en ${keep} el resultado no es el esperado: revisa ${keep} a mano`,
```

In the Reconciliation block of `en`:

```ts
  opTxNotFound: (id: string) => `Transaction ${id} no longer exists`,
  opSplitRow: (id: string) => `Transaction ${id} is part of a split`,
  opReconciled: (id: string) => `Transaction ${id} is reconciled and is left untouched`,
  opAlreadyTransfer: (id: string) => `Transaction ${id} is already a transfer`,
  opSameAccount: 'Both transactions are in the same account',
  opAmountsMismatch: 'The amounts no longer match',
  opMergeShape: 'To merge, keep must be the bank-imported transaction and drop the non-imported one, in the same account with the same amount',
  opAccountUnavailable: (id: string) => `Account ${id} does not exist, is closed or is the transaction's own account`,
  opNoTransferPayee: (id: string) => `Account ${id} has no transfer payee`,
  linkNoCounterpart: (id: string) => `Actual did not create the counterpart of ${id}; the change was reverted`,
  linkReverted: (cause: string) => `Merging failed (${cause}); the change was reverted`,
  linkRevertFailed: (x: string, counterpart: string, cause: string) =>
    `Failed and could not be reverted (${cause}): check ${x} and the counterpart ${counterpart} by hand`,
  linkUnverified: (x: string, y: string) => `After merging, ${x} and ${y} are not linked: check them by hand`,
  mergeUnverified: (keep: string, drop: string) =>
    `After merging ${drop} into ${keep} the result is not as expected: check ${keep} by hand`,
```

- [ ] **Step 5: Create `src/core/reconcile-apply.ts`**

```ts
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
  if (row.id !== id || row.is_parent) return { why: m.opSplitRow(id) };
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
  const { byTransferAccount } = await getPayeeIndex(api);
  const transferPayee = byTransferAccount.get(y.account);
  if (!transferPayee) return skip(m.opNoTransferPayee(y.account));

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? COUNTERPART_POLL_ATTEMPTS;
  const delayMs = opts.delayMs ?? COUNTERPART_POLL_DELAY_MS;
  const originalPayee = x.payee ?? null;
  let counterpartId = '';

  const revert = async (detail: string): Promise<OpResult> => {
    try {
      await api.updateTransaction(x.id, { payee: originalPayee });
      return { operation: op, status: 'fallida', detail };
    } catch (err) {
      return { operation: op, status: 'fallida', detail: m.linkRevertFailed(x.id, counterpartId || '?', errMessage(err)) };
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
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/core/reconcile-apply.test.ts tests/core/messages.test.ts`
Expected: PASS. If the "omite si algo cambió" case for `[x]` fails on the regex, check that `opTxNotFound('y')` contains `y` — it does by construction.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/core/reconcile-apply.ts src/core/messages.ts tests/helpers/fake-ledger.ts tests/core/reconcile-apply.test.ts
git commit -m "feat(reconcile): apply link (transfer + merge), merge and create_transfer with revalidation"
```

---

### Task 6: `apply_reconciliation_fixes` tool

**Files:**
- Create: `src/tools/apply_reconciliation_fixes.ts`
- Modify: `src/tools/index.ts`, `manifest.json` (`{ "name": "apply_reconciliation_fixes", "description": "Apply accepted reconciliation fixes (link, merge, create transfer), revalidating each" }` after `set_transaction_transfer`), `README.md` and `README.es.md` (write-tools tables, after `set_transaction_transfer`)
- Test: `tests/tools/apply_reconciliation_fixes.test.ts`

**Interfaces:**
- Consumes: `OperationSchema` (Task 1); `applyOperation`, `OpResult` (Task 5); `syncAfterWrite` (`src/core/write-sync.ts`); `msg`.
- Produces: tool `apply_reconciliation_fixes` (write). Output: `{ results: OpResult[], applied: number, skipped: number, failed: number, sync_pending?: true, note?: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/apply_reconciliation_fixes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { tool } from '../../src/tools/apply_reconciliation_fixes.js';
import { testConfig } from '../helpers/mock-api.js';
import { fakeLedger } from '../helpers/fake-ledger.js';

const X = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const IMP = '33333333-3333-4333-8333-333333333333';
const MAN = '44444444-4444-4444-8444-444444444444';
const accounts = [{ id: 'A', name: 'BBVA' }, { id: 'B', name: 'ING' }];
const rows = [
  { id: X, account: 'A', date: '2026-09-15', amount: -10000, imported_id: 'ix' },
  { id: Y, account: 'B', date: '2026-09-15', amount: 10000, imported_id: 'iy' },
  { id: IMP, account: 'B', date: '2026-09-15', amount: 2500, imported_id: 'ib' },
  { id: MAN, account: 'B', date: '2026-09-15', amount: 2500 },
];

describe('apply_reconciliation_fixes', () => {
  it('aplica cada operación, informa de cada una y sincroniza una vez', async () => {
    const { api, db } = fakeLedger({ accounts, rows });
    const r: any = await tool.handler({ operations: [
      { type: 'link', a: X, b: Y },
      { type: 'merge', keep: IMP, drop: MAN },
    ] }, { api, config: testConfig });
    expect(r.results.map((x: any) => x.status)).toEqual(['aplicada', 'aplicada']);
    expect(r).toMatchObject({ applied: 2, skipped: 0, failed: 0 });
    expect(db.get(X).transfer_id).toBe(Y);
    expect(db.has(MAN)).toBe(false);
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('una operación omitida no detiene las demás', async () => {
    const { api } = fakeLedger({ accounts, rows: rows.map((r) => (r.id === X ? { ...r, reconciled: true } : r)) });
    const r: any = await tool.handler({ operations: [
      { type: 'link', a: X, b: Y },
      { type: 'merge', keep: IMP, drop: MAN },
    ] }, { api, config: testConfig });
    expect(r.results.map((x: any) => x.status)).toEqual(['omitida', 'aplicada']);
    expect(r).toMatchObject({ applied: 1, skipped: 1, failed: 0 });
  });

  it('avisa si la sincronización final falla, sin dar la escritura por perdida', async () => {
    const { api } = fakeLedger({ accounts, rows });
    api.sync.mockRejectedValueOnce(new Error('offline'));
    const r: any = await tool.handler({ operations: [{ type: 'merge', keep: IMP, drop: MAN }] }, { api, config: testConfig });
    expect(r.applied).toBe(1);
    expect(r.sync_pending).toBe(true);
    expect(r.note).toMatch(/offline/);
  });

  it('rechaza una lista vacía, de más de 50 o con operaciones mal formadas', async () => {
    const { api } = fakeLedger({ accounts, rows });
    await expect(tool.handler({ operations: [] }, { api, config: testConfig })).rejects.toBeInstanceOf(ZodError);
    const many = Array.from({ length: 51 }, () => ({ type: 'merge', keep: IMP, drop: MAN }));
    await expect(tool.handler({ operations: many }, { api, config: testConfig })).rejects.toBeInstanceOf(ZodError);
    await expect(tool.handler({ operations: [{ type: 'link', a: 'x', b: Y }] }, { api, config: testConfig })).rejects.toBeInstanceOf(ZodError);
  });

  it('es una tool de escritura', () => {
    expect(tool.readOnly).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/tools/apply_reconciliation_fixes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/tools/apply_reconciliation_fixes.ts`**

```ts
import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { msg } from '../core/messages.js';
import { OperationSchema } from '../core/reconcile-model.js';
import { applyOperation, type OpResult } from '../core/reconcile-apply.js';
import { syncAfterWrite } from '../core/write-sync.js';

const MAX_OPERATIONS = 50;

const input = {
  operations: z
    .array(OperationSchema)
    .min(1)
    .max(MAX_OPERATIONS)
    .describe('Operations accepted by the user, exactly as returned in the proposals of find_transfer_issues / reconcile_account'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'apply_reconciliation_fixes',
  title: 'Apply reconciliation fixes',
  description:
    'Apply reconciliation operations the user accepted (link two existing transactions into one transfer, merge a ' +
    'duplicate into the bank-imported transaction, or turn a bank transaction into a transfer to another account). ' +
    'Each operation is revalidated against current data first; one that no longer fits is skipped (omitida) with the ' +
    'reason and the rest still run. Never touches reconciled transactions and never loses a bank import id. ' +
    `At most ${MAX_OPERATIONS} operations per call.`,
  readOnly: false,
  annotations: { destructiveHint: true, idempotentHint: false },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const results: OpResult[] = [];
    for (const op of a.operations) results.push(await applyOperation(api, op, m));
    const sync = await syncAfterWrite(api);
    const count = (status: OpResult['status']) => results.filter((r) => r.status === status).length;
    return {
      results,
      applied: count('aplicada'),
      skipped: count('omitida'),
      failed: count('fallida'),
      ...(sync.synced ? {} : { sync_pending: true, note: m.syncPending(sync.error!) }),
    };
  },
};
```

- [ ] **Step 4: Register it**

`src/tools/index.ts`: import `{ tool as applyReconciliationFixes } from './apply_reconciliation_fixes.js'` and append it after `setTransactionTransfer` in `allTools`. Manifest entry as listed. `README.md`, write-tools table after `set_transaction_transfer`:

```markdown
| `apply_reconciliation_fixes` | Apply the reconciliation operations you accepted (link, merge, create transfer), up to 50 per call; each is revalidated first and reported as applied, skipped (with the reason) or failed. Never touches reconciled transactions and keeps every bank import id |
```

`README.es.md`, after `set_transaction_transfer`:

```markdown
| `apply_reconciliation_fixes` | Aplica las operaciones de conciliación que aceptes (enlazar, fusionar, crear transferencia), hasta 50 por llamada; cada una se revalida antes y se informa como aplicada, omitida (con el motivo) o fallida. Nunca toca movimientos conciliados y conserva el identificador de importación del banco |
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/tools/apply_reconciliation_fixes.test.ts tests/bundle/manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/tools/apply_reconciliation_fixes.ts src/tools/index.ts manifest.json README.md README.es.md tests/tools/apply_reconciliation_fixes.test.ts
git commit -m "feat(reconcile): apply_reconciliation_fixes tool"
```

---

### Task 7: `mark_reconciled` tool

**Files:**
- Create: `src/tools/mark_reconciled.ts`
- Modify: `src/core/messages.ts` (`reconcileMismatch` in the Conciliación block, `es` and `en`)
- Modify: `src/tools/index.ts`, `manifest.json` (`{ "name": "mark_reconciled", "description": "Mark an account reconciled up to a date once it matches the bank" }` after `apply_reconciliation_fixes`), `README.md`, `README.es.md`
- Test: `tests/tools/mark_reconciled.test.ts`

**Interfaces:**
- Consumes: `loadAccounts`, `resolveAccount`, `closeOfDay` (Task 1); `toCents`, `moneyFields`; `syncAfterWrite`; `fakeLedger` (Task 5, tests only).
- Produces: tool `mark_reconciled` (write). Output when it does not match: `{ reconciled: false, account, date, bank_balance, actual_balance, difference, note }` (no writes). When it matches: `{ reconciled: true, account, date, balance, marked_count, sync_pending?, note? }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/mark_reconciled.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tool } from '../../src/tools/mark_reconciled.js';
import { testConfig } from '../helpers/mock-api.js';
import { fakeLedger } from '../helpers/fake-ledger.js';

const accounts = [{ id: 'A', name: 'BBVA Nómina' }, { id: 'B', name: 'ING' }];
const rows = [
  { id: 't1', account: 'A', date: '2026-09-10', amount: 100000 },
  { id: 't2', account: 'A', date: '2026-09-30', amount: 23456, cleared: true },
  { id: 't3', account: 'A', date: '2026-08-01', amount: 0, reconciled: true },
  { id: 'later', account: 'A', date: '2026-10-01', amount: -500 },
  { id: 'other', account: 'B', date: '2026-09-10', amount: 7 },
];

describe('mark_reconciled', () => {
  it('se niega si no cuadra y no escribe nada', async () => {
    const { api } = fakeLedger({ accounts, rows });
    const r: any = await tool.handler({ account: 'bbva nomina', date: '2026-09-30', bank_balance: 1234 }, { api, config: testConfig });
    expect(r.reconciled).toBe(false);
    expect(r.difference.amount).toBe(-0.56);
    expect(r.note).toBeTruthy();
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('si cuadra marca liquidados y conciliados solo los no conciliados de esa cuenta hasta la fecha', async () => {
    const { api, db } = fakeLedger({ accounts, rows });
    const r: any = await tool.handler({ account: 'BBVA Nómina', date: '2026-09-30', bank_balance: 1234.56 }, { api, config: testConfig });
    expect(r.reconciled).toBe(true);
    expect(r.marked_count).toBe(2);
    expect(db.get('t1')).toMatchObject({ cleared: true, reconciled: true });
    expect(db.get('t2')).toMatchObject({ cleared: true, reconciled: true });
    expect(db.get('later').reconciled).toBe(false);
    expect(db.get('other').reconciled).toBe(false);
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('pide el saldo al cierre del día de la fecha', async () => {
    const { api } = fakeLedger({ accounts, rows });
    await tool.handler({ account: 'A', date: '2026-09-30', bank_balance: 0 }, { api, config: testConfig });
    const cutoff = (api.getAccountBalance as any).mock.calls[0][1] as Date;
    expect([cutoff.getFullYear(), cutoff.getMonth() + 1, cutoff.getDate()]).toEqual([2026, 9, 30]);
  });

  it('es una tool de escritura', () => {
    expect(tool.readOnly).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/tools/mark_reconciled.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the message**

Conciliación block of `es`:

```ts
  reconcileMismatch: (difference: string) =>
    `No cuadra (diferencia banco − Actual: ${difference}); no se ha marcado nada. Usa reconcile_account para ver la causa`,
```

Reconciliation block of `en`:

```ts
  reconcileMismatch: (difference: string) =>
    `It does not match (bank − Actual difference: ${difference}); nothing was marked. Use reconcile_account to find the cause`,
```

- [ ] **Step 4: Create `src/tools/mark_reconciled.ts`**

```ts
import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { msg, activeMessages } from '../core/messages.js';
import { formatAmount, moneyFields, toCents } from '../core/money.js';
import { closeOfDay, loadAccounts, resolveAccount } from '../core/reconcile-data.js';
import { syncAfterWrite } from '../core/write-sync.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => activeMessages().dateFormat });

const input = {
  account: z.string().min(1).describe('Account id or exact name (case and accents are ignored)'),
  date: DATE.describe('Statement date (YYYY-MM-DD); transactions dated that day are included'),
  bank_balance: z.number().describe('Balance the bank shows at the close of date, in account currency units'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'mark_reconciled',
  title: 'Mark account reconciled',
  description:
    'Once an account matches the bank, mark every unreconciled transaction in it dated on or before date as cleared ' +
    'and reconciled, like the reconcile button in Actual. Recomputes the balance first and refuses (writing nothing) ' +
    'if it does not match bank_balance. Never adds a balance-adjustment transaction.',
  readOnly: false,
  annotations: { destructiveHint: false, idempotentHint: true },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    const money = (cents: number) => moneyFields(cents, config.locale, config.currency);

    const account = resolveAccount(await loadAccounts(api), a.account, m);
    const bank = toCents(a.bank_balance);
    const actual: number = await api.getAccountBalance(account.id, closeOfDay(a.date));
    const who = { id: account.id, name: account.name };
    if (actual !== bank) {
      const difference = bank - actual;
      return {
        reconciled: false,
        account: who,
        date: a.date,
        bank_balance: money(bank),
        actual_balance: money(actual),
        difference: money(difference),
        note: m.reconcileMismatch(formatAmount(difference, config.locale, config.currency)),
      };
    }

    const { data } = await api.runQuery(
      api.q('transactions')
        .filter({ account: account.id, reconciled: false, date: { $lte: a.date } })
        .options({ splits: 'all' })
        .select(['id']),
    );
    const ids = ((data ?? []) as any[]).map((r) => r.id);
    for (const id of ids) await api.updateTransaction(id, { cleared: true, reconciled: true });
    const sync = await syncAfterWrite(api);
    return {
      reconciled: true,
      account: who,
      date: a.date,
      balance: money(actual),
      marked_count: ids.length,
      ...(sync.synced ? {} : { sync_pending: true, note: m.syncPending(sync.error!) }),
    };
  },
};
```

- [ ] **Step 5: Register it**

`src/tools/index.ts`: import `{ tool as markReconciled } from './mark_reconciled.js'`, append after `applyReconciliationFixes`. Manifest entry as listed. `README.md` write-tools table, after `apply_reconciliation_fixes`:

```markdown
| `mark_reconciled` | When an account matches the bank at a date, mark its unreconciled transactions up to that date as cleared and reconciled (like Actual's reconcile button). Refuses and writes nothing if the balance does not match; never adds an adjustment transaction |
```

`README.es.md`, after `apply_reconciliation_fixes`:

```markdown
| `mark_reconciled` | Cuando una cuenta cuadra con el banco a una fecha, marca sus movimientos sin conciliar hasta esa fecha como liquidados y conciliados (como el botón de conciliar de Actual). Si el saldo no cuadra, se niega y no escribe nada; nunca crea un apunte de ajuste |
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/tools/mark_reconciled.test.ts tests/bundle/manifest.test.ts tests/core/messages.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/tools/mark_reconciled.ts src/core/messages.ts src/tools/index.ts manifest.json README.md README.es.md tests/tools/mark_reconciled.test.ts
git commit -m "feat(reconcile): mark_reconciled tool"
```

---

### Task 8: Warning in `set_transaction_transfer` for bank-synced targets

**Files:**
- Modify: `src/tools/set_transaction_transfer.ts`
- Modify: `src/core/messages.ts` (`transferTargetSynced`, next to `transferSameAccount` in both languages)
- Test: `tests/tools/set_transaction_transfer.test.ts` (add two cases)

**Interfaces:**
- Consumes: existing tool; `msg`.
- Produces: the tool's result gains `warning?: string` when the target account is bank-synced (`balance_current` not null/undefined). Behaviour otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('set_transaction_transfer', …)` block of `tests/tools/set_transaction_transfer.test.ts`:

```ts
  it('avisa de duplicado probable si la cuenta destino se sincroniza con el banco', async () => {
    const syncedAccounts = accounts.map((a) => (a.id === A_DST ? { ...a, balance_current: 1000 } : a));
    const api = apiWithRows([[plain], [linked]], { getAccounts: async () => syncedAccounts });
    const r: any = await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(r.warning).toMatch(/find_transfer_issues/);
  });

  it('no avisa si la cuenta destino se lleva a mano', async () => {
    const api = apiWithRows([[plain], [linked]]);
    const r: any = await tool.handler({ transaction_id: T1, target_account_id: A_DST }, { api, config: testConfig });
    expect(r.warning).toBeUndefined();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/tools/set_transaction_transfer.test.ts`
Expected: the first new test FAILS (`warning` undefined).

- [ ] **Step 3: Add the message**

`es`, after `transferSameAccount`:

```ts
  transferTargetSynced: (name: string) =>
    `"${name}" se sincroniza con el banco: cuando el banco importe este movimiento quedará duplicado. ` +
    'Para unir dos movimientos que ya existen usa find_transfer_issues y la operación link',
```

`en`, after `transferSameAccount`:

```ts
  transferTargetSynced: (name: string) =>
    `"${name}" syncs with the bank: once the bank imports this transaction it will be duplicated. ` +
    'To join two transactions that already exist use find_transfer_issues and the link operation',
```

- [ ] **Step 4: Implement**

In `src/tools/set_transaction_transfer.ts`, replace

```ts
    const accounts = (await api.getAccounts()) ?? [];
    if (!(accounts as any[]).some((acc) => acc.id === a.target_account_id)) {
      throw new Error(m.accountNotFound(a.target_account_id));
    }
```

with

```ts
    const accounts = ((await api.getAccounts()) ?? []) as any[];
    const target = accounts.find((acc) => acc.id === a.target_account_id);
    if (!target) throw new Error(m.accountNotFound(a.target_account_id));
    // balance_current solo lo rellena el bank-sync: el banco traerá su propia pata.
    const syncedTarget = target.balance_current !== null && target.balance_current !== undefined;
```

and in the returned object, right after `updated: true,`, add:

```ts
      ...(syncedTarget ? { warning: m.transferTargetSynced(target.name) } : {}),
```

Also append to the tool's `description` string: `' If the target account syncs with the bank, the result carries a warning: the bank will import its own leg, so joining two existing transactions is better done with find_transfer_issues (link).'`

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/tools/set_transaction_transfer.test.ts tests/core/messages.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm run build && npm test
git add src/tools/set_transaction_transfer.ts src/core/messages.ts tests/tools/set_transaction_transfer.test.ts
git commit -m "feat(reconcile): warn when set_transaction_transfer targets a bank-synced account"
```

---

### Task 9: End-to-end check against the ephemeral 26.10.0 server

**Files:**
- Create: `scripts/verify/reconcile-check.ts`
- Create: `scripts/verify/reconcile.integration.test.ts`

**Interfaces:**
- Consumes: the four tools (Tasks 3, 4, 6, 7) via `tool.handler(input, { api, config })`; `ensureServerReady` (`test/integration/setup.ts`).
- Produces: `RESULT=` JSON from the script; the integration test asserts on it.

- [ ] **Step 1: Create the check script**

Create `scripts/verify/reconcile-check.ts`:

```ts
// End-to-end check of the reconciliation tools against the EPHEMERAL actual-server (26.10.0).
// Run as a subprocess (not in-process under vitest): mergeTransactions deletes rows, and
// @actual-app/api's delete paths deadlock under vitest (see scripts/demo/reset-check.ts).
//
//   docker compose -f test/integration/docker-compose.actual.yml up -d
//   npx tsx scripts/verify/reconcile-check.ts
//
// Fixture (mirrors the spec's motivating case):
//   Banco A (bank-synced): -100,00 "Traspaso a Banco B" and -50,00 "Retirada efectivo cajero"
//   Banco B (bank-synced): +100,00 the next day (the other leg, imported) and +25,00 "Bizum"
//                          imported plus the same +25,00 typed by hand (duplicate)
//   Efectivo (manual): empty
// Expected: link (alta), merge (alta), create_transfer to Efectivo (dudosa, by name); after
// applying all of them: A = -150,00, B = 125,00, Efectivo = 50,00; every imported_id survives.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as api from '@actual-app/api';
import type { Config } from '../../src/core/config.js';
import { tool as findTransferIssues } from '../../src/tools/find_transfer_issues.js';
import { tool as applyFixes } from '../../src/tools/apply_reconciliation_fixes.js';
import { tool as reconcileAccount } from '../../src/tools/reconcile_account.js';
import { tool as markReconciled } from '../../src/tools/mark_reconciled.js';

const URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
const PASSWORD = process.env.ACTUAL_SERVER_PASSWORD ?? 'test-pass';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(URL)) {
  throw new Error(`Solo contra el servidor efímero local, no ${URL}`);
}

async function run(): Promise<number> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-reconcile-check-'));
  const config: Config = {
    serverUrl: URL, password: PASSWORD, syncId: '', dataDir, locale: 'es-ES', currency: 'EUR',
    syncTtlSeconds: 60, enableWrite: true, messagesLang: 'es',
  };
  const ctx = { api, config };
  try {
    await api.init({ dataDir, serverURL: URL, password: PASSWORD });
    await api.runImport('ReconcileCheck', async () => {});
    const A = await api.createAccount({ name: 'Banco A', offbudget: false }, 0);
    const B = await api.createAccount({ name: 'Banco B', offbudget: false }, 0);
    const C = await api.createAccount({ name: 'Efectivo', offbudget: false }, 0);
    await api.importTransactions(A, [
      { date: '2026-09-15', amount: -10000, payee_name: 'Traspaso a Banco B', imported_id: 'rc-a1' },
      { date: '2026-09-15', amount: -5000, payee_name: 'Retirada efectivo cajero', imported_id: 'rc-a2' },
    ]);
    await api.importTransactions(B, [
      { date: '2026-09-16', amount: 10000, payee_name: 'Traspaso desde Banco A', imported_id: 'rc-b1' },
      { date: '2026-09-15', amount: 2500, payee_name: 'Bizum', imported_id: 'rc-b2' },
    ]);
    // addTransactions does not reconcile against existing rows: this is the duplicate.
    await api.addTransactions(B, [{ date: '2026-09-15', amount: 2500, payee_name: 'Bizum' }]);
    await api.sync();

    const found: any = await findTransferIssues.handler({ start_date: '2026-09-01', end_date: '2026-09-30' }, ctx);
    const proposals = [...found.proposals.link, ...found.proposals.merge, ...found.proposals.create_transfer];
    const applied: any = await applyFixes.handler({ operations: proposals.map((p: any) => p.operation) }, ctx);

    const balances = {
      A: await api.getAccountBalance(A),
      B: await api.getAccountBalance(B),
      C: await api.getAccountBalance(C),
    };
    const rec: any = await reconcileAccount.handler({ account: 'Banco B', bank_balance: 125, date: '2026-09-30' }, ctx);
    const marked: any = await markReconciled.handler({ account: 'banco b', bank_balance: 125, date: '2026-09-30' }, ctx);
    const { data } = await api.runQuery(
      api.q('transactions').filter({ imported_id: { $ne: null } }).select(['imported_id', 'transfer_id']),
    );
    const imported = (data as any[]).map((r) => r.imported_id).sort();
    const linkedImported = (data as any[]).filter((r) => r.transfer_id).map((r) => r.imported_id).sort();

    const result = {
      proposals: proposals.map((p: any) => `${p.operation.type}:${p.confidence}`),
      statuses: applied.results.map((r: any) => r.status),
      balances,
      reconcileMatches: rec.matches,
      marked: marked.marked_count,
      imported,
      linkedImported,
    };
    console.log('RESULT=' + JSON.stringify(result));
    const ok =
      result.proposals.includes('link:alta') &&
      result.proposals.includes('merge:alta') &&
      result.proposals.includes('create_transfer:dudosa') &&
      result.statuses.every((s: string) => s === 'aplicada') &&
      balances.A === -15000 && balances.B === 12500 && balances.C === 5000 &&
      rec.matches === true && marked.reconciled === true && marked.marked_count > 0 &&
      JSON.stringify(imported) === JSON.stringify(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b2']) &&
      ['rc-a1', 'rc-a2', 'rc-b1'].every((id) => linkedImported.includes(id));
    return ok ? 0 : 1;
  } finally {
    try {
      await api.shutdown();
    } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

- [ ] **Step 2: Create the integration test**

Create `scripts/verify/reconcile.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureServerReady } from '../../test/integration/setup.js';

const execFileAsync = promisify(execFile);

describe('reconciliation tools end to end', () => {
  beforeAll(async () => {
    await ensureServerReady();
  });

  it('link + merge + create_transfer, then reconcile and mark', async () => {
    const script = fileURLToPath(new URL('./reconcile-check.ts', import.meta.url));
    // Same reason as reset.integration.test.ts: never inherit vitest's NODE_ENV=test.
    const env = { ...process.env, ACTUAL_SERVER_URL: 'http://localhost:5006', ACTUAL_SERVER_PASSWORD: 'test-pass' };
    delete env.NODE_ENV;
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('npx', ['tsx', script], { env, timeout: 100_000 }));
    } catch (err: any) {
      stdout = err.stdout ?? '';
      throw new Error(`reconcile-check failed:\n${stdout}\n${err.stderr ?? ''}`);
    }
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT='));
    expect(line, stdout).toBeTruthy();
    const result = JSON.parse(line!.slice('RESULT='.length));
    expect(result.statuses.every((s: string) => s === 'aplicada')).toBe(true);
    expect(result.balances).toEqual({ A: -15000, B: 12500, C: 5000 });
    expect(result.reconcileMatches).toBe(true);
    expect(result.imported).toEqual(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b2']);
  });
});
```

- [ ] **Step 3: Typecheck the script**

Run: `npx tsc --noEmit --skipLibCheck --ignoreConfig --module nodenext --moduleResolution nodenext --target es2022 --types node scripts/verify/reconcile-check.ts`
Expected: no errors. If an `@actual-app/api` call does not match `node_modules/@actual-app/api/@types/methods.d.ts`, fix the call to the typed signature.

- [ ] **Step 4: Run it against the ephemeral server**

```bash
docker compose -f test/integration/docker-compose.actual.yml up -d
npm run test:integration
docker compose -f test/integration/docker-compose.actual.yml down
```

Expected: all integration files pass, including the new one. If the new one fails, read the printed `RESULT=`:
- a missing `link:alta` or `merge:alta` means detection differs from the fixture's intent on the real server (e.g. `importTransactions` merged the manual duplicate, or set `imported_payee` differently) — adjust the **fixture**, not the rules, and say so in the report;
- a status other than `aplicada` is a real defect in Task 5's code — report it with the `detail`, do not paper over it.
Always bring the container down.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify/reconcile-check.ts scripts/verify/reconcile.integration.test.ts
git commit -m "test(reconcile): end-to-end reconciliation cycle against actual-server 26.10.0"
```

---

### Task 10: Release 2.4.0

**Files:**
- Modify: `package.json`, `manifest.json` (`version`; `user_config.enable_write.description` counts), `package-lock.json` (root version, via npm)
- Modify: `README.md`, `README.es.md` (tool counts)
- Modify: `CLAUDE.md` ("Estado y próximos pasos")

**Interfaces:**
- Consumes: everything above.
- Produces: `build/actual-budget-mcp-es.mcpb` 2.4.0.

- [ ] **Step 1: Version and counts**

- `"version": "2.4.0"` in `package.json` and `manifest.json`; then `npm install --package-lock-only`.
- Count the tools: `node -e "import('./dist/tools/index.js').then(m=>{const t=m.allTools;console.log(t.filter(x=>x.readOnly).length, t.filter(x=>!x.readOnly).length)})"` after `npm run build`. Expected `13 20`.
- In `manifest.json`, `user_config.enable_write.description`: `"Off: 13 read-only tools. On: 20 more that can edit transactions, splits, budgets, categories, category groups, payees/transfers, reconciliation, rules and notes. Your MCP client asks for approval before each call unless you grant it standing permission."`
- In `README.md` and `README.es.md`, replace every count of the read/write tools (`11` → `13`, `18` → `20`) in the "Turning on write access" / "Activar el acceso de escritura" paragraph, the `ENABLE_WRITE` row of the environment-variables table (add "reconciliation" / "conciliación" to its list), and the "Read tools (11)" / "Write tools (18)" headings or their Spanish sentences. Find them with `grep -n "\b11\b\|\b18\b" README.md README.es.md`.

- [ ] **Step 2: CLAUDE.md**

Under "Estado y próximos pasos" add:

```markdown
- **2.4.0 (2026-10-__)**: conciliación (pieza A de la spec 2026-10-08): `find_transfer_issues`, `reconcile_account`,
  `apply_reconciliation_fixes`, `mark_reconciled` y el aviso de `set_transaction_transfer` hacia cuentas sincronizadas.
  `link` = transferencia + `mergeTransactions` (spike). Pendiente: prueba con datos reales del mantenedor.
```

(write the real date when you run this step).

- [ ] **Step 3: Run everything**

```bash
npm run build && npm test
docker compose -f test/integration/docker-compose.actual.yml up -d && npm run test:integration; docker compose -f test/integration/docker-compose.actual.yml down
npm run bundle
```

Expected: unit and integration green; bundle verified (`Verificado: 2 binario(s) nativo(s) N-API`) and version 2.4.0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json manifest.json README.md README.es.md CLAUDE.md
git commit -m "chore: release 2.4.0"
```

- [ ] **Step 5: Hand over to the maintainer (manual — do not do it for them)**

1. Install `build/actual-budget-mcp-es.mcpb` in Claude Desktop and restart it.
2. Before any write on real data: a cold copy of the Actual data on R5 (infrastructure session, as done on 2026-10-08).
3. In a new conversation: `reconcile_account` on the account that motivated this work with the bank balance at a date → review the proposals → `apply_reconciliation_fixes` with the accepted ones → `mark_reconciled` when it matches.

Do not push or tag: publishing is the maintainer's call.
