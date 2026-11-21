# Household cleanup tools (2.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude clean up and maintain the household budget through the MCP: edit and transfer split parts, split transfers, undo transfers, correct date ranges, safer transfer proposals, idempotent imports and budget templates.

**Architecture:** Extend the existing tools in `src/tools/` (B1) and add four new ones (`remove_transaction_transfer`, `import_transactions`, `get_category_note`, `apply_budget_templates`). Shared logic goes to `src/core/` (child-aware reads in `tx-read.ts`, transfer helpers in a new `transfers.ts`). Every behavior is unit-tested with the mocked API, then verified end to end against a throwaway local Actual 26.11.0 server.

**Tech Stack:** TypeScript, Zod 4, MCP SDK, `@actual-app/api` 26.11.0, vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-household-cleanup-tools-design.md` (read it first; this plan argues from it).

## Global Constraints

- `@actual-app/api` **26.11.0**; local verification server `actualbudget/actual-server:26.11.0`.
- Version **2.5.0** in `package.json` and `manifest.json` (enforced by `tests/bundle/manifest.test.ts`, which also checks the tool catalog).
- Every new runtime message in **both** `es` and `en` in `src/core/messages.ts` (wording is the implementer's; key names are given per task).
- Amounts in units in and out (`toCents` / `moneyFields` / `formatAmount`), never cents to the LLM.
- Input ids validated with `ID` (UUID) from `src/core/types.ts`.
- Write tools `readOnly: false` (registered only with `ENABLE_WRITE`), with `annotations`.
- Echo after writes is what was **read back**, with `echo_pending` + `m.echoPending` when not settled.
- Tests first (TDD). Unit tests use `tests/helpers/mock-api.ts` (`mockApi`, `testConfig`, `chainableQ`).
- Never run verification writes against the real budget or the dev sandbox (`localhost:5007`); only the ephemeral server on `localhost:5006`.
- Do not push, publish or tag.
- After merging a worktree branch into main, `npm install` in the main checkout (CLAUDE.md lesson).

## Review Focus

1. **A child id passed to tools that still refuse children** (`split_transaction` on a child, `remove_transaction_transfer` on a parent): clear error naming the parent, no write. → tests in Tasks 6, 7.
2. **Transfer part whose target is the transaction's own account, or a closed/unknown account**: refused before any write. → tests in Tasks 5, 7.
3. **`import_transactions` with duplicate `imported_id` inside the same batch**: refused by validation (Actual would add both). → test in Task 9.
4. **`apply_budget_templates` when Actual returns template parse errors** (`{ sticky: true, message: 'template-errors', pre }` or `{ type: 'error' }`): returned as a readable error with the `pre` text, budgets unchanged in the echo. → test in Task 10.
5. **Keyword matching false positives** (`iva` inside `privada`, `tax` inside `taxi`): no downgrade. → test in Task 8.

---

### Task 1: Bump to Actual 26.11.0 and re-check the API facts

**Files:**
- Modify: `package.json` (`@actual-app/api` → `^26.11.0`), `package-lock.json`
- Modify: `test/integration/docker-compose.actual.yml` (image `actualbudget/actual-server:26.11.0`, comment updated)
- Create: `docs/superpowers/notes/2026-11-21-api-26-11-facts.md`

**Interfaces:** Produces: the confirmed facts table later tasks rely on.

- [ ] **Step 1:** `npm install @actual-app/api@26.11.0` in the worktree.
- [ ] **Step 2:** Re-check in `node_modules/@actual-app/api/dist/index.js` every row of the spec's "Verified facts" table: `compileOp` first-key behavior; `api/transaction-update` (grouped read + ungroup + shared `updateTransaction`); `transfer.ts` `onUpdate`/`addTransfer`/`removeTransfer`/`clearCategory`; `matchTransactions` (`reimportDeleted`, fuzzy query); `importTransactions(accountId, txs, opts)` mapping `opts.dryRun` → `isPreview` and the `updatedPreview` entry shapes; `budget/apply-goal-template` / `budget/overwrite-goal-template` and their return messages; `template_settings.source`; the exported `internal` binding (`api.internal.send`). Write each as "confirmed" or "changed: …" in the notes file. If something changed, stop and report before Task 2.
- [ ] **Step 3:** Run `npm test` and `npm run build`. Expected: all green (no code changes yet).
- [ ] **Step 4:** Commit: `chore: @actual-app/api 26.11.0 and local server 26.11.0`.

### Task 2: Date ranges honor `end_date`

**Files:**
- Modify: `src/tools/get_transactions.ts:31`, `src/tools/get_spending_summary.ts:37`, `src/tools/get_budget_averages.ts:33`, `src/core/reconcile-data.ts:59`
- Create: `src/core/aql.ts`
- Test: `tests/core/aql.test.ts`, existing `tests/tools/get_transactions.test.ts`, `get_spending_summary.test.ts`, `get_budget_averages.test.ts`, `tests/core/reconcile-data.test.ts`

**Interfaces:**
- Produces: `dateRange(start: string, end: string): { $and: [{ date: { $gte: string } }, { date: { $lte: string } }] }` in `src/core/aql.ts`.

- [ ] **Step 1: Failing tests.** `tests/core/aql.test.ts`:
  - `dateRange('2026-11-01','2026-11-30')` equals `{ $and: [{ date: { $gte: '2026-11-01' } }, { date: { $lte: '2026-11-30' } }] }`.
  - Guard: read every `.ts` under `src/` and assert none matches `/\{\s*\$gte:[^{}]*\$lte:/` nor `/\{\s*\$lte:[^{}]*\$gte:/` (an operator object with two range ops; Actual compiles only the first).
  - In each of the four tools' tests: capture the `filter` calls on the `chainableQ` and assert one of them is exactly `dateRange(start, end)` with the inputs given (for `get_transactions` start=end=`2026-11-15`).
- [ ] **Step 2:** `npx vitest run tests/core/aql.test.ts tests/tools/get_transactions.test.ts tests/tools/get_spending_summary.test.ts tests/tools/get_budget_averages.test.ts tests/core/reconcile-data.test.ts` → FAIL.
- [ ] **Step 3:** Implement `dateRange` and use it in the four places.
- [ ] **Step 4:** Same command → PASS; `npm test` green.
- [ ] **Step 5:** Commit: `fix: date ranges ignored end_date (AQL compiles only the first operator)`.

### Task 3: `update_transaction` edits split parts

**Files:**
- Create: `src/core/transfers.ts`
- Modify: `src/core/tx-read.ts`, `src/tools/update_transaction.ts`, `src/core/messages.ts`
- Test: `tests/core/transfers.test.ts`, `tests/core/tx-read.test.ts`, `tests/tools/update_transaction.test.ts`

**Interfaces:**
- Produces (tx-read): `getTransactionRow(api, id): Promise<any|null>` — `filter({id}).options({splits:'all'}).select(['*'])`, returns the raw row (children included, with `is_child`, `parent_id`, `account`, `payee`, `transfer_id`, `category`). `readBack(api, id, fields, opts)` gains `opts.read?: (api, id) => Promise<any|null>` (default `getTransactionById`).
- Produces (transfers.ts):
  - `transferAccountOfPayee(api, payeeId: string | null): Promise<string | null>` (via `getPayeeIndex(api).all`'s `transfer_acct`).
  - `sameBudgetSide(accounts: Array<{id:string; offbudget?: boolean|number}>, a: string, b: string): boolean | null` (null when an account is unknown).
- Messages: `splitChildFieldNotAllowed(field)`, `transferPartCategorySameSide`, `transferPartPayeeUseRemove`.

- [ ] **Step 1: Failing tests** (`update_transaction.test.ts`; replace the old "rejects editing a split child" test). Pre-read mock returns the parent (grouped) for the grouped query and the child row for the `splits:'all'` query (branch on the recorded `options` call):
  - `category_id` on a child → `updateTransaction(T_CHILD, { category: C9 })`; echo has `id: T_CHILD`, `parent_id: T_PARENT`, `category_id: C9`.
  - `notes` and `payee_name` on a child → written to the child id.
  - `amount`, `date` or `cleared` on a child → rejects `/split/i`, no write.
  - Child that is a transfer (child row has `transfer_id` and payee with `transfer_acct`) + `payee_name` → rejects (points to `remove_transaction_transfer`).
  - Transfer child between two on-budget accounts + `category_id` → rejects; between on-budget and off-budget → allowed.
  - Parent rules unchanged (existing tests stay green).
  - `tests/core/transfers.test.ts`: `sameBudgetSide` true/false/null; `transferAccountOfPayee` returns the account or null.
- [ ] **Step 2:** Run the three test files → FAIL.
- [ ] **Step 3:** Implement. Child detection stays `existing.id !== transaction_id`; then `getTransactionRow` for the child; read-back with `read: getTransactionRow`; echo `mapTxEcho(row)` plus `parent_id`.
- [ ] **Step 4:** Tests PASS; `npm test` green.
- [ ] **Step 5:** Commit: `feat(update_transaction): edit category, notes and payee of split parts`.

### Task 4: `categorize_transactions` accepts split parts

**Files:** Modify `src/tools/categorize_transactions.ts`, `src/core/messages.ts`; Test `tests/tools/categorize_transactions.test.ts`

**Interfaces:** Consumes `getTransactionRow`, `transferAccountOfPayee`, `sameBudgetSide` (Task 3). Message: `transferPartCategorySameSideItem` (item form).

- [ ] **Step 1: Failing tests:** a child id is categorized (written to the child id, reported ok); a transfer child across budget sides is categorized; a transfer child on the same side fails per item with the item message while the rest of the batch succeeds; read-back via `readBackCategories` (already `splits:'all'`) confirms children.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit: `feat(categorize_transactions): categorize split parts`.

### Task 5: `set_transaction_transfer` on split parts, with optional category

**Files:** Modify `src/tools/set_transaction_transfer.ts`, `src/core/messages.ts`; Test `tests/tools/set_transaction_transfer.test.ts`

**Interfaces:** Consumes Task 3 helpers. New input `category_id: ID.optional()`. Output adds `clears_category: boolean` and, for children, `parent_id`. Messages: `transferCategorySameSide(accountName)`, `accountClosed(name)`.

- [ ] **Step 1: Failing tests:**
  - Child id (parent account = checking, on-budget) + target off-budget «Hipoteca» + `category_id` «Cuotas» → one `updateTransaction(T_CHILD, { payee: <hipoteca transfer payee>, category: CUOTAS })`; echo carries `transfer_id` read back from the child row, `clears_category: false`.
  - Same-side target + `category_id` → rejects, no write. Same-side target without category → allowed, `clears_category: true` when the row had a category.
  - Parent → still rejected. Target = child's account → `transferSameAccount`. Target closed or unknown → rejected.
  - Category id not in the index → `categoryNotFound`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (read child with `getTransactionRow`; account for checks is `row.account`). **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit: `feat(set_transaction_transfer): split parts and category for cross-budget transfers`.

### Task 6: New tool `remove_transaction_transfer`

**Files:** Create `src/tools/remove_transaction_transfer.ts`; Modify `src/tools/index.ts`, `manifest.json` (tool list), `src/core/messages.ts`; Test `tests/tools/remove_transaction_transfer.test.ts`

**Interfaces:**
- Input: `transaction_id: ID`, `payee_id?: ID`, `payee_name?: string(max 200)` (exactly one required), `category_id?: ID.nullable()`, `notes?: string(max 1000)`, `force: boolean = false`.
- Output: `{ updated: true, transaction (echo), removed_twin_id, twin_action: 'deleted' | 'detached', warning? }`.
- Payee resolution: reuse the `payee_name` resolve-or-create logic of `update_transaction` — extract it to `resolvePayeeName(api, name): Promise<string>` in `src/core/payees.ts` and use it from both.
- Messages: `notATransfer(id)`, `twinProtected(id, reason: 'reconciled'|'imported')`, `twinMayReturn(accountName)`, `payeeRequired`.
- Annotations: `{ destructiveHint: true, idempotentHint: false }`. Description: it is the explicit form of changing the payee to a non-transfer payee; deletes the twin on the other account, or detaches it if the twin is a split part; refuses reconciled or bank-imported twins unless `force`.

- [ ] **Step 1: Failing tests:**
  - Normal transfer leg → `updateTransaction(T1, { payee: P, category: C9 })`; echo `transfer_id` null; `twin_action: 'deleted'`.
  - Transfer split part → written to the child id; when the twin row has `is_child` → `twin_action: 'detached'`.
  - Twin reconciled or with `imported_id` and no `force` → rejects, no write; with `force` → writes, and an imported twin adds `warning`.
  - Not a transfer → `notATransfer`; parent id → rejected; neither/both payee fields → rejected; unknown category → `categoryNotFound`.
  - `update_transaction` tests still green after the `resolvePayeeName` extraction.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; register in `index.ts` and `manifest.json`. **Step 4:** PASS + `npm test` (manifest test included).
- [ ] **Step 5:** Commit: `feat: remove_transaction_transfer`.

### Task 7: `split_transaction` with transfer parts and transfer originals

**Files:** Modify `src/tools/split_transaction.ts`, `src/core/tx-read.ts` (echo), `src/core/messages.ts`; Test `tests/tools/split_transaction.test.ts`

**Interfaces:**
- Part input: `{ amount, category_id?: ID, notes?, transfer_account_id?: ID }`.
- Written part: `{ amount, category?, notes?, payee? }` where `payee` = transfer payee of `transfer_account_id`.
- `mapTxEcho` split parts add `transfer_id` (and `payee` id) when present.
- Output adds `replaced_twin_id` when the original was a transfer, and `parent_payee_id` (the payee set on the parent).
- Messages: `partNeedsCategoryOrTransfer(index)`, `partTransferSameAccount(index)`, `splitTransferTwinProtected(id, reason)`; drop the use of `cannotSplitTransfer` (keep the key only if still referenced).

- [ ] **Step 1: Failing tests:**
  - Mortgage case: original −800 on checking (on-budget); parts `[{amount:-600, transfer_account_id: HIPOTECA(off-budget), category_id: CUOTAS}, {amount:-200, category_id: BANCO}]` → one `updateTransaction(id, { subtransactions: [{amount:-60000, category:CUOTAS, payee:P_HIP}, {amount:-20000, category:BANCO}] })`.
  - Part with neither category nor transfer → rejected (index in message). Same-side transfer part with category → rejected. Transfer part to own account / unknown / closed account → rejected. All before any write.
  - Original is a transfer whose twin is manual (no `imported_id`, not reconciled, not a child) → allowed; result has `replaced_twin_id`; parent payee set to the payee derived from `imported_payee` (existing payee by name) or `null` — passed in the same `updateTransaction` call as `payee`.
  - Original transfer with twin reconciled / imported / child → rejected even with `force: true`, no write.
  - Existing checks unchanged: sums, `adjust_last`, reconciled original needs `force`, already split rejected, child id rejected.
  - Read-back: settled only when part count matches and every transfer part has `transfer_id`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (extend `readBackSplit` with an optional predicate rather than a new function). **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit: `feat(split_transaction): transfer parts and splitting existing transfers`.

### Task 8: `find_transfer_issues` confidence for `create_transfer`

**Files:** Modify `src/core/reconcile-detect.ts`, `src/core/reconcile-data.ts`, `src/core/reconcile-model.ts` (if `DetectInput` grows), `src/tools/find_transfer_issues.ts`, `src/core/messages.ts`; Test `tests/core/reconcile-detect.test.ts`, `tests/tools/find_transfer_issues.test.ts`

**Interfaces:**
- Constants in `reconcile-detect.ts`: `COMPENSATION_DAYS = 60`; `NON_TRANSFER_KEYWORDS = ['nomina','salario','factura','recibo','impuesto','iva','irpf','aeat','hacienda','seguridad social','payroll','salary','invoice','tax']`.
- `findKeyword(text: string): string | null` — normalized (`normalizeText`), whole-word match.
- `findCompensation(x: TxRow, targetRows: TxRow[]): TxRow | null` — same account as target, `amount === x.amount`, `daysApart <= 60`, transfers allowed, not `x` itself.
- `DetectInput` gains `targetRows: TxRow[]` (rows of manual accounts for the range ±60 days, transfers included); `loadDetectInput` loads them with a second query using `dateRange`.
- Messages (both languages): `reasonCreateFromHistory(target)` stays; add `reasonKeyword(keyword, field)`, `reasonCompensated(date, amount)`, `reasonNotCompensated(days)`; the final reason joins history + keyword/compensation parts.

- [ ] **Step 1: Failing tests** (`reconcile-detect.test.ts`):
  - History match, unique, no keyword, compensated (−500 in target 20 days later) → `alta`; reason mentions the compensating date and amount.
  - Same but notes «NÓMINA NOVIEMBRE» → `dudosa`, reason names «nómina» and the field.
  - Payee «APPLE.COM/BILL» with notes «Factura» → `dudosa`.
  - History match, no compensation in ±60 days (compensation at day 61) → `dudosa` with `reasonNotCompensated(60)`.
  - Compensating row that is itself a transfer → counts.
  - `findKeyword('Clínica privada')` → null; `findKeyword('Taxi aeropuerto')` → null; `findKeyword('Pago IVA 3T')` → `'iva'`.
  - Links and merges unchanged (existing tests green).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit: `fix(find_transfer_issues): downgrade payroll/invoice/tax and uncompensated transfers`.

### Task 9: New tool `import_transactions`

**Files:** Create `src/tools/import_transactions.ts`; Modify `src/tools/index.ts`, `manifest.json`, `src/core/messages.ts`, `tests/helpers/mock-api.ts` (add `importTransactions`); Test `tests/tools/import_transactions.test.ts`

**Interfaces:**
- Input: `account_id: ID`; `transactions: array(1..100)` of `{ date, amount (units), imported_id: string(1..100), payee_name?: string(max 200), category_id?: ID, notes?: string(max 1000), cleared?: boolean }`; `dry_run: boolean = true`; `allow_fuzzy: boolean = false`.
- Calls: preview `api.importTransactions(account_id, txs, { dryRun: true, reimportDeleted: false, defaultCleared: true })`; real run `api.importTransactions(account_id, safeTxs, { dryRun: false, reimportDeleted: false, defaultCleared: true })`.
- Classification of preview `updatedPreview` entries by `transaction.imported_id`: `existing` with the same `imported_id` → `update`; `existing` with null `imported_id` → `fuzzy` (carry `existing.id/date/payee_name/amount`); `ignored: true` → `unchanged`; ids not present in `updatedPreview` → `add`. Confirm these shapes in Task 1's notes; adjust here if they changed.
- Output: `{ dry_run, results: [{ imported_id, outcome: 'add'|'update'|'unchanged'|'fuzzy'|'skipped_fuzzy'|'error', matched?: {...}, error? }], totals: {...}, errors }`. On a real run without `allow_fuzzy`, fuzzy rows are excluded from the second call and reported `skipped_fuzzy`.
- Messages: `duplicateImportedId(id)`, `accountClosed(name)` (new; also used by Tasks 5 and 7 for closed targets — create it in Task 5), `importErrors(text)`.
- Description: dry run by default — show the preview, then call again with `dry_run: false`; deleted rows are never re-imported; example `imported_id` `fcf-<name>-2026-11` for a monthly fund return.

- [ ] **Step 1: Failing tests:**
  - Default call → only the preview call, `dry_run: true`, nothing else written; amounts converted to cents in the call.
  - Real run, preview says one add + one fuzzy → second call receives only the add row; results `add` + `skipped_fuzzy` with `matched`.
  - Real run with `allow_fuzzy: true` → second call receives both.
  - Every call passes `reimportDeleted: false`.
  - Duplicate `imported_id` within the batch → rejected before any call (Review Focus 3).
  - Unknown/closed account, unknown category → rejected before any call.
  - Preview returning `errors: [{message}]` → rejected with the text.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; register. **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit: `feat: import_transactions with stable imported_id`.

### Task 10: Category notes and budget templates

**Files:** Create `src/core/templates.ts`, `src/tools/get_category_note.ts`, `src/tools/apply_budget_templates.ts`; Modify `src/tools/update_category_note.ts`, `src/tools/index.ts`, `manifest.json`, `src/core/messages.ts`, `tests/helpers/mock-api.ts` (add `internal: { send }`); Test `tests/core/templates.test.ts`, `tests/tools/get_category_note.test.ts`, `tests/tools/apply_budget_templates.test.ts`, `tests/tools/update_category_note.test.ts`

**Interfaces:**
- `templates.ts`:
  - `templateLines(note: string | null): string[]` — lines whose text from the first `#` starts with `#template` or `#goal` (Actual's rule).
  - `templateSources(api): Promise<Map<string, 'notes'|'ui'>>` — `q('categories').select(['id','template_settings'])`; source = `template_settings?.source === 'ui' ? 'ui' : 'notes'` (parse JSON if it comes as a string).
  - `sendInternal(api, name: string, args: object): Promise<any>` — `api.internal?.send`; throws `m.internalUnavailable` if absent.
- `get_category_note` (read-only): input `category_id: ID`; output `{ category_id, category_name, note, template_source, template_lines, warning? }`; `warning` = `m.uiTemplateIgnoresNote(name)` when source `ui` and `template_lines.length > 0`.
- `update_category_note`: same `warning` added to its existing output.
- `apply_budget_templates` (write, `destructiveHint: true`, `idempotentHint: false`): input `month: 'YYYY-MM'`, `overwrite: boolean = false`. Steps: read `getBudgetMonth(month)` → `sendInternal(api, overwrite ? 'budget/overwrite-goal-template' : 'budget/apply-goal-template', { month })` → read `getBudgetMonth(month)` again. Output `{ month, overwrite, count, changed: [{ category_id, category, before, after }] (units), ui_template_categories: [names], warning? }`. A result with `type === 'error'` or `sticky === true` → throw `m.templateErrors(pre ?? message)`. Description notes templates are experimental in Actual 26.11 and that UI-defined categories ignore note templates.
- Messages: `uiTemplateIgnoresNote(name)`, `templateErrors(text)`, `internalUnavailable`.

- [ ] **Step 1: Failing tests:**
  - `templateLines('Comida\n#template 350\n  #goal 1000\nnota')` → `['#template 350', '#goal 1000']`.
  - `templateSources` maps `{source:'ui'}`, `'{"source":"ui"}'` and null correctly.
  - `get_category_note` with a `ui` category and a `#template` line → `warning`; with `notes` source → no warning.
  - `update_category_note` on a `ui` category → result carries `warning`.
  - `apply_budget_templates` default → `internal.send('budget/apply-goal-template', { month: '2026-12' })`; `overwrite: true` → `'budget/overwrite-goal-template'`; `changed` lists only categories whose budgeted amount changed, in units.
  - Sticky `template-errors` result → rejects with the `pre` text (Review Focus 4).
  - Bad month format → `monthFormat`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; register both new tools. **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit: `feat: get_category_note, apply_budget_templates and UI-template warnings`.

### Task 11: End-to-end verification on local Actual 26.11.0

**Files:** Create `scripts/verify/household-check.ts`, `scripts/verify/household.integration.test.ts`, `docs/superpowers/notes/2026-11-21-household-verification.md`

**Interfaces:** Follows `scripts/verify/reconcile-check.ts` exactly (subprocess under `tsx`, localhost-only URL guard, `api.runImport` fresh budget, prints `RESULT=<json>`), and `reconcile.integration.test.ts` for the vitest wrapper.

- [ ] **Step 1:** `docker compose -f test/integration/docker-compose.actual.yml up -d`.
- [ ] **Step 2:** Write `household-check.ts`. Fixture: «Cuenta» (on-budget), «Hipoteca Ampliación» (off-budget), «Adelantos» (on-budget, manual), «Fondos» (off-budget); categories «Cuotas», «Banco», «Comida» (with note `#template 100`), «Ocio» (with `template_settings = {source:'ui'}` set through `api.internal.send('category-update', ...)` or `api.internal.db` as test setup). Checks, each recorded as `{name, ok, detail}`:
  1. Split −800 into −600 transfer to Hipoteca + «Cuotas» and −200 «Banco» → exactly one counterpart +600 in Hipoteca, part keeps «Cuotas».
  2. `update_transaction` category/notes on the «Banco» part → parent and sum intact.
  3. `set_transaction_transfer` on a part of a second split.
  4. A manual transfer Cuenta→Adelantos −300, then split it into −100 «Comida» + −200 transfer to Adelantos → the old +300 twin is gone, exactly one +200 twin. If this fails, apply the spec fallback (remove then split), re-run, and record it.
  5. Split of a transfer whose twin has `imported_id` → refused, nothing changed.
  6. `remove_transaction_transfer` on a manual transfer → twin deleted, payee/category set.
  7. `get_transactions` with start=end returns only that day.
  8. `import_transactions` dry run → nothing written; real run → added; re-run → no duplicate; delete the row, re-run → stays deleted; a row with no id same amount ±3 days → `skipped_fuzzy`.
  9. `apply_budget_templates` for next month → «Comida» budgeted 100; «Ocio» in `ui_template_categories`; `get_category_note(«Ocio»)` has a warning.
  10. `find_transfer_issues` on a synced-looking fixture (imported rows) with a payee history to Adelantos: compensated → `alta`; notes «Nómina» → `dudosa`.
- [ ] **Step 3:** `npm run test:integration` → all checks ok. Record results (no secrets) in the notes file.
- [ ] **Step 4:** `docker compose -f test/integration/docker-compose.actual.yml down`.
- [ ] **Step 5:** Commit: `test: end-to-end verification of household cleanup tools on Actual 26.11.0`.

### Task 12: Version 2.5.0, docs and bundle

**Files:** Modify `package.json`, `package-lock.json`, `manifest.json` (version 2.5.0, descriptions of new/changed tools), `README.md`, `README.es.md`, `CLAUDE.md` (Estado: 2.5.0 entry), `SECURITY.md` if it lists write tools.

- [ ] **Step 1:** Bump to 2.5.0 (`npm version 2.5.0 --no-git-tag-version`) and `manifest.json`.
- [ ] **Step 2:** README EN/ES: one entry per new tool (`remove_transaction_transfer`, `import_transactions`, `get_category_note`, `apply_budget_templates`) and per changed behavior (split parts in `update_transaction`/`categorize_transactions`/`set_transaction_transfer`, transfer parts in `split_transaction`, `find_transfer_issues` confidence), plus a "Fixed in 2.5.0" note: before 2.5.0, `get_transactions`, `get_spending_summary`, `get_budget_averages` and the reconciliation tools could include data after `end_date`. Mention: after installing the `.mcpb`, quit Claude Desktop completely (Cmd+Q) and reopen.
- [ ] **Step 3:** `npm test`, `npm run build`, then `npm run bundle`. Expected: tests green, N-API check passes for `darwin-arm64`, `.mcpb` produced.
- [ ] **Step 4:** Commit: `release: 2.5.0`.
