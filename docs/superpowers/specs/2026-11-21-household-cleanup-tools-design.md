# Household cleanup tools (2.5.0) — Design Spec

**Date:** 2026-11-21
**Status:** Approaches approved by the maintainer (A1 + B1, generic import, Docker 26.11 verification); builder check done
**Language note:** Spec in English like the other design specs. No URLs, Sync IDs, amounts or
names from the real budget beyond the generic examples the maintainer gave.

## Intent

The maintainer is cleaning up the household budget (Actual Budget 26.11.0, self-hosted) to
start an envelope budget fed by Wallos. During 20–21 Nov several operations had to be done by
hand in the Actual app because the MCP refused them, and some MCP outputs were wrong. The goal
of 2.5.0 is that **Claude can do the whole cleanup and the monthly upkeep through the MCP**,
safely, without the maintainer opening the app.

The canonical real case: the monthly mortgage receipt on the checking account is one bank
transaction that must become a split of (a) the capital part, a **transfer** to the off-budget
account «Hipoteca Ampliación», categorized «Cuotas», and (b) the interest part, categorized
«Banco». (From November the external `wallos-conciliador` will do this automatically; this
spec only covers the MCP.)

## Goals

1. Edit a **split part** (category, notes, payee) without breaking the split.
2. Turn a split part into a **transfer** to another account.
3. `split_transaction` accepts parts that are transfers, and can split a transaction that is
   **already a transfer** without leaving a duplicate leg in the other account.
4. **Undo a transfer** explicitly, leaving an ordinary transaction with a given payee and category.
5. Fix the **date-range bug** (`end_date` ignored) everywhere it occurs.
6. Make `find_transfer_issues` stop proposing high-confidence (`alta`) transfers for payroll,
   invoices and taxes, and require the amount to be compensated in the target account.
7. **Import** transactions with a stable `imported_id` (monthly fund/pension returns) without
   duplicates.
8. Read category notes, **apply budget templates** for a month, and warn when a category uses
   the new template UI (which ignores `#template` lines in the note).

## Non-goals

- Automatic mortgage splitting (that is `wallos-conciliador`).
- Changing amounts or dates of individual split parts (re-split instead).
- Editing templates through the new UI model (`goal_def` written directly). Only notes.
- Bank-sync configuration, account creation.
- Publishing / pushing to origin (needs an explicit order from the maintainer).

## Anti-goals (failure even if it "works")

- Any write that leaves a split whose parts no longer sum to the parent.
- Splitting a transfer and leaving the old counterpart leg in the other account (duplicate
  money), or deleting a counterpart the bank will re-import.
- `import_transactions` silently merging a return into an unrelated existing transaction, or
  resurrecting a transaction the maintainer deleted.
- Verification writes against the real household budget (or the dev sandbox, which is a copy
  of it). All write verification runs against a **throwaway local Actual 26.11.0 server in
  Docker** (the repo's `test/integration` compose, image bumped to 26.11.0) — chosen by the
  maintainer over the public `actual-demo`, whose pinned image predates 26.11.
- Reading the extension's encrypted password from Claude Desktop config.

## Constraints

- Stack as today: TypeScript, Zod 4, MCP SDK, `@actual-app/api` — **bumped to 26.11.0** to match
  the server (template code is experimental and changes between releases). The bundle build
  must still pass the N-API check of `scripts/bundle.ts`.
- TDD for every point (project rule, Tipo D). Mocked unit tests in `tests/tools`/`tests/core`
  using the existing helpers (`tests/helpers/mock-api.ts`, `fake-ledger.ts`), plus an empirical
  verification script in `scripts/verify/` run against the local Docker Actual 26.11.0 server.
- Bilingual runtime messages: every new message goes into both `es` and `en` in
  `src/core/messages.ts` (the `en: Messages` type enforces it).
- Write tools only registered with `ENABLE_WRITE` (`readOnly: false`).
- `manifest.json` must list the real tool catalog and match `package.json` version
  (`tests/bundle/manifest.test.ts` enforces it). Version → **2.5.0**.
- Amounts always in units in and out (÷100 / `toCents`), never cents to the LLM.
- Read-back after writes (`readBack*` in `src/core/tx-read.ts`): the echo is what was read,
  with `echo_pending` when the write has not landed yet; `syncAfterWrite` where tools already use it.
- README (EN) and README.es.md get a note for every new tool and changed behavior.

## Verified facts about Actual (from reading `@actual-app/api` 26.10.0 dist)

| Fact | Consequence |
|---|---|
| AQL `compileOp` takes only the **first** key of an operator object: `{date: {$gte: a, $lte: b}}` compiles to `date >= a` only. | Root cause of goal 5. Use `{ $and: [{date: {$gte}}, {date: {$lte}}] }` or two `.filter()` calls. |
| `api/transaction-update` loads the row with `splits: 'grouped'`, ungroups, and calls the shared `updateTransaction(transactions, {id, ...fields})`, which handles a **child id** natively. | Goals 1–2 need no new API path; the MCP guard (`existing.id !== transaction_id`) is what blocks it today. |
| `transfer.onUpdate`: parent → `removeTransfer`; payee is a transfer payee and no `transfer_id` → `addTransfer`; no transfer payee but `transfer_id` → `removeTransfer`; both → `updateTransfer`. `addTransfer` only refuses parents, so **children can be transfers**. | Goal 2 works by setting the child's payee to the target account's transfer payee. |
| `removeTransfer`: if the counterpart is a **child**, it clears its payee and `transfer_id`; otherwise it **deletes** the counterpart. | Goal 4 deletes the twin (or detaches it when the twin is a split part). Goal 3: turning a transfer into a parent deletes the old counterpart; a transfer child then creates a fresh one. |
| `clearCategory` clears both legs' category only when both accounts are on the same side of the budget. | Mortgage case (on-budget → off-budget) keeps «Cuotas». Same-side transfer parts lose their category; report it. |
| `matchTransactions` (import): matches by `imported_id` against `v_transactions` when `reimportDeleted` is true (so a **deleted** row is not found and is re-imported) or `v_transactions_internal` when false. Without an id match it fuzzy-matches rows with **no** `imported_id`, same amount, same account, ±7 days. `reimportDeleted` defaults to the account preference, `"true"` when unset. | Goal 7 forces `reimportDeleted: false` and reports fuzzy matches. `isPreview` gives a dry run. |
| Templates: `budget/apply-goal-template` (`{month}`) and `budget/overwrite-goal-template` first parse notes into `goal_def` (`storeNoteTemplates`) — but only for categories whose `template_settings.source` is not `'ui'` — then budget from `goal_def`. Categories with `source: 'ui'` keep their UI-defined `goal_def` and ignore note lines. Return value `{type:'message', message:'templates-applied', count}` or an error/sticky message. | Goal 8: detect `source === 'ui'` and warn. Read budgets before/after to report the effect. |
| `api.internal` is deprecated; `init()` returns `{ send, ... }`. | Call template handlers through the `send` returned by init (to confirm against 26.11.0 and against how `src/core/actual-client.ts` initializes). |

These must be re-checked against 26.11.0 after the bump (first plan task).

## Approaches considered

**Undo a transfer (goal 4).**
- **A1 — new tool `remove_transaction_transfer` (chosen).** One verb per tool; the description
  can explain the twin deletion.
- A2 — `set_transaction_transfer` with `target_account_id: null`. One tool fewer, but one tool
  doing opposite things confuses the model.

**Split parts (goals 1–3).**
- **B1 — extend existing tools (chosen).** `update_transaction`, `categorize_transactions`,
  `set_transaction_transfer` accept child ids; `split_transaction` accepts transfer parts and
  transfer originals.
- B2 — new `update_split_part`. Clear separation but five near-duplicate tools to choose from.

**Fund returns import (goal 7).**
- **Generic `import_transactions` (chosen by the maintainer).** Reusable; made safe by
  required ids, `reimportDeleted: false`, dry run and fuzzy-match reporting.
- Specific `record_investment_return`. Rejected: narrower.

## Design

### 1. `update_transaction` on split parts

- If the id is a child (pre-read returns the parent, `existing.id !== transaction_id`), locate
  the child in `existing.subtransactions`.
- Allowed fields on a child: `category_id` (incl. null), `notes`, `payee_id`, `payee_name`.
  `amount`, `date`, `cleared` on a child → error explaining to re-split / edit the parent.
- Category validated against the index as today. Setting a category on a child that is a
  transfer between same-side accounts: Actual would accept it but it is meaningless — return an
  error (message: the part is a transfer; use `remove_transaction_transfer` first).
- Setting `payee_*` on a child that is currently a transfer: this is a transfer removal; refuse
  and point to `remove_transaction_transfer` (keeps the twin-deletion behavior explicit and in
  one place).
- Parent rules unchanged (no amount/category on a parent).
- Read-back must read the child: add a child-aware read (e.g. query with `splits: 'all'`
  filtered by id) so `readBack` compares the child row, not the parent. Echo: the child plus
  `parent_id`.

`categorize_transactions` gets the same relaxation: children accepted for category; a transfer
child is rejected per item **only when its two accounts are on the same budget side** (a
cross-side transfer part such as the mortgage capital can be recategorized, e.g. «Cuotas»). *Builder's call extended from goal 1: the maintainer categorized
split parts by hand, and this is the batch tool Claude uses for that.*

### 2. `set_transaction_transfer` on split parts

- Accept a child id. Parent still refused (Actual removes rather than adds).
- `transferSameAccount` check uses the child's account (= parent's account).
- Write: `updateTransaction(childId, { payee: transferPayee.id })`; Actual creates the twin.
- Optional `category_id` input (new, applies to children and normal transactions): set in the
  same write when the two accounts are on **different** sides (mortgage: «Cuotas»); if they are
  on the same side, refuse the category with a clear message (Actual would clear it).
- Echo: `transfer_id` read back, `clears_category` flag, and the existing synced-target warning.

### 3. `split_transaction` with transfer parts and transfer originals

Input part: `{ amount, category_id?, notes?, transfer_account_id? }`.
- Each part needs a `category_id` or a `transfer_account_id` (or both when the transfer crosses
  budget sides, e.g. «Cuotas»). Same-side transfer part with a category → error (Actual would
  clear it). Neither → error (today every part requires `category_id`; there is no
  off-budget exception, and none is added).
- Transfer part: `payee` = transfer payee of `transfer_account_id`; must differ from the
  transaction's account; account must exist and be open.
- **Splitting an existing transfer** (`orig.transfer_id` set):
  - Read the counterpart. If it is reconciled, or has an `imported_id` (bank leg), or is itself
    a split child → refuse with an explanation (re-import risk / data loss); the user fixes it in
    Actual or with `remove_transaction_transfer` first. `force` does **not** bypass this.
  - Otherwise write the split in one `updateTransaction(id, { subtransactions })`: Actual's
    parent rule removes (deletes) the old counterpart and each transfer part creates its own.
    *To verify empirically on the local 26.11.0 server (plan task): that exactly one counterpart exists per
    transfer part afterwards and the old one is gone. If Actual does not remove it in the same
    batch, fall back to: `remove` transfer first, then split — documented in the plan.*
  - The parent loses its transfer payee: Actual keeps the payee field; the builder sets the
    parent payee to the original non-transfer payee if one can be derived (imported_payee →
    existing payee by name), otherwise leaves it null. Report it in the result.
- Sum validation, `adjust_last`, `force` for reconciled originals: unchanged.
- Read-back: `readBackSplit` plus, for each transfer part, check its `transfer_id` is set; echo
  each part with `transfer_account_id` and `transfer_id`.

### 4. New tool `remove_transaction_transfer`

Input: `transaction_id` (normal transfer leg or transfer split part), one of
`payee_id`/`payee_name` (required: the payee the transaction becomes), `category_id` (optional,
nullable), `notes` (optional).
- Not a transfer → error. Parent → error.
- If the twin is reconciled **or has an `imported_id`** (a real bank movement, typically joined
  earlier with `link`) → refuse unless `force: true`: deleting it loses a bank movement or a
  reconciled balance. *Builder's call, consistent with §3.* With `force`, the result says
  whether bank sync may bring it back (account reimport preference).
- One write `{ payee, category?, notes? }`; Actual's `removeTransfer` deletes the twin (or
  detaches it if the twin is a split part — report which).
- Category validated; read-back confirms `transfer_id` is null and the twin is gone.
- Description documents that this is the same as changing the payee to a non-transfer payee,
  made explicit.

### 5. Date-range bug

Fix in `get_transactions`, `get_spending_summary`, `get_budget_averages`, `reconcile-data.ts`
`loadTxRows` (and any other occurrence found). Add a unit test per tool that the built query
carries both bounds as separate conditions (mock captures filters), and a guard test that
greps `src/` for an operator object holding two range operators so the pattern cannot return.
Changelog/README note: spending summaries and averages before 2.5.0 could include data after
`end_date`.

### 6. `find_transfer_issues` confidence

For `create_transfer` proposals from payee history (the only ones that reach `alta`):
- **Keyword downgrade:** if payee name, imported payee or notes (normalized, accent-insensitive)
  contain payroll / invoice / tax terms → `dudosa`. Initial list (Spanish + English, in a
  constant in `reconcile-detect.ts`): `nomina`, `salario`, `factura`, `recibo`, `impuesto`,
  `iva`, `irpf`, `aeat`, `hacienda`, `seguridad social`, `payroll`, `salary`, `invoice`,
  `tax`. Word-boundary matching so `iva` does not hit `privada`. *Builder may refine the list;
  `recibo` is borderline (many legit transfers are not receipts) — keep it, it only downgrades.*
- **Compensation check:** `alta` only if the target account has, within ±60 days of the
  transaction, a transaction with **exactly the same signed amount as the source transaction**
  (i.e. the opposite of the leg the transfer would create there). Worked example (agreed with
  the maintainer): an advance of −500 leaves checking; the transfer would create +500 in
  «Adelantos Taiko»; the advance is *compensated* when «Adelantos Taiko» also has a −500 within
  ±60 days — the repayment going back out. The compensating movement **may already be a
  transfer** (repayments usually are), so transfers are not excluded. A +500 in the target is a
  `link` candidate and is handled by link detection, which runs first. A payroll of +2,400 that
  never goes back out stays `dudosa`. Otherwise `dudosa`. Requires loading target-account rows for ±60 days
  (widen `loadDetectInput`'s range for manual accounts or do a second targeted query).
- **Readable reason:** the reason string states why: history match, keyword found (`«nómina» en
  las notas`), compensated (date + amount of the compensating movement) or not compensated.
  New `Messages` entries in both languages.
- Name-based proposals stay `dudosa` as today; links and merges unchanged.

### 7. New tool `import_transactions`

Input: `account_id`, `transactions[]` (1–100) each with `date`, `amount` (units),
`imported_id` (required, 1–100 chars), `payee_name?`, `category_id?`, `notes?`, `cleared?`;
`dry_run` (default **true**).
- Validates account (exists, open) and categories before anything.
- **Fuzzy matches are prevented, not only reported** (anti-goal): a real run first runs
  Actual's preview internally; rows the preview would merge into an existing row without
  `imported_id` are **not written** unless `allow_fuzzy: true`, and come back as
  `skipped_fuzzy` with the row they would have merged into. The remaining rows are imported.
  *Builder's call: the import is done in a second call with only the safe rows.*
- Calls `api.importTransactions(account_id, txs, { reimportDeleted: false, dryRun/isPreview })`
  (exact option name for the preview to confirm against 26.11.0 types — the handler takes
  `isPreview`).
- Result: per input row, its outcome — `added`, `updated` (matched by `imported_id`),
  `matched_fuzzy` (matched an existing row without id: flagged with the matched row's id, date,
  payee, amount so Claude can show it), or `error`. Plus totals.
- `dry_run: true` writes nothing; Claude is expected to show the preview, then call again with
  `dry_run: false`. Description says so.
- Rows deleted earlier stay deleted (`reimportDeleted: false`); description says so.
- Example in the description: monthly return with `imported_id` like `fcf-<name>-2026-11`.

### 8. Category notes and templates

- **New tool `get_category_note`** (read-only): `category_id` → `{ category_name, note,
  template_source: 'notes' | 'ui', template_lines: [...lines starting with #template/#goal],
  warning? }`. `warning` when `source === 'ui'` and the note has template lines: they are ignored.
- **`update_category_note`**: same warning added to its result when the category's source is `'ui'`.
- **New tool `apply_budget_templates`** (write): `month` (YYYY-MM), `overwrite` (default false →
  `apply-goal-template`, only fills categories without a budget; true →
  `overwrite-goal-template`).
  - Before: read the month's budgets (`getBudgetMonth`) and list categories with
    `template_source: 'ui'`.
  - Call the handler; if it returns an error/sticky message (template parse errors), return it
    as an error with the text.
  - After: read budgets again; return per-category `{ category, before, after }` for those that
    changed, `count` from Actual, and `ui_template_categories` with the warning that they used
    their UI definition, not the note.
  - Description flags templates as experimental in Actual 26.11.

## Testing and verification

- Unit tests (mocked API) for every rule above, written first.
- `scripts/verify/household-cleanup.ts` against the local Docker Actual 26.11.0 server
  (credentials via env, as the existing `scripts/verify/*` scripts; never committed), covering: child update, child →
  transfer with category across budget sides, split of a manual transfer (exactly one
  counterpart per transfer part, old one gone), refusal on imported counterpart,
  `remove_transaction_transfer`, `end_date` boundaries, import dry run / real / re-run (no
  duplicates) / delete + re-run (stays deleted), template apply with a note template and with a
  UI-source category. Results recorded in `docs/superpowers/notes/`.
- Full suite green, `npm run build`, `.mcpb` built.

**UI-source category for tests:** the verification script may set `template_settings` on a
test category directly (internal update) to build the fixture. That is test setup on a
throwaway server, not a tool feature, so it does not contradict the non-goal.

## Left to the builder

- Exact message wording (both languages).
- Whether the child-aware read-back is a new helper or a parameter of `readBack`.
- How `find_transfer_issues` loads the ±60-day rows for the compensation check.
- Keyword list refinement.
- Order of tasks in the plan (suggested: API bump + re-verify facts → date fix → children →
  transfers → split → remove → find_transfer_issues → import → templates → docs/version/bundle).

## Delivery

Version 2.5.0, README/README.es notes per tool, `.mcpb` built, nothing pushed. Reminder for the
maintainer: after installing the `.mcpb`, quit Claude Desktop completely (Cmd+Q) and reopen.
