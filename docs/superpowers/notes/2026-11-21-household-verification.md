# Household cleanup tools: end-to-end verification on Actual 26.11.0 (2026-11-21)

Script: `scripts/verify/household-check.ts` (tsx subprocess, localhost-only guard), wrapped by
`scripts/verify/household.integration.test.ts` (`npm run test:integration`). Server: throwaway
`actualbudget/actual-server:26.11.0` in Docker on `localhost:5006`, fresh budget via `api.runImport`.
Fixture: Cuenta (on-budget), Hipoteca Ampliación (off-budget), Adelantos (on-budget, manual),
Fondos (off-budget); categories Cuotas, Banco, Comida (`#template 100`), Ocio (`template_settings.source = ui`).
Synthetic data only. Result: **10/10 checks ok** after the two source fixes below.

| # | Check | Result | What real Actual did |
|---|---|---|---|
| 1 | Split -800 into -600 transfer to Hipoteca (+ Cuotas) and -200 Banco | ok | Exactly one +600 counterpart in Hipoteca; the transfer part kept «Cuotas» (cross-side transfer payee does not clear it); both child rows from `splits:'all'` carry `account`. |
| 2 | `update_transaction` category/notes on the Banco part | ok | Part updated; parent amount -800 and children sum unchanged. |
| 3 | `set_transaction_transfer` on a part of a second split (with `category_id`, to off-budget Fondos) | ok | Part linked, category kept, one +200 twin in Fondos, `parent_id` unchanged. |
| 4 | Split a manual transfer Cuenta→Adelantos -300 into -100 Comida + -200 transfer | ok | Actual **does** delete the old +300 twin in the same update and creates exactly one +200 twin; `replaced_twin_id` reported; the parent payee is no longer a transfer payee. **The spec fallback (remove the transfer first, then split) was NOT needed.** |
| 5 | Split of a transfer whose twin has `imported_id` | ok | Refused before writing: no children, still linked, twin intact. |
| 6 | `remove_transaction_transfer` on a manual transfer | ok | Twin really deleted (not found by AQL), link cleared, payee and category set, `twin_action: deleted`. |
| 7 | `get_transactions` with start = end | ok | `dateRange` `$and` compiles correctly in real AQL: only that day (1 row, `total_count` 1). |
| 8 | `import_transactions` preview / add / re-run / delete / fuzzy | ok (after fix 2) | Dry run writes nothing (`add: 2`); real run adds 2; re-run reports `unchanged` and adds nothing; a deleted row stays deleted and is reported `kept_deleted` (see fix 2); a row without id with the same amount 2 days apart is `fuzzy` in preview and `skipped_fuzzy` in the real run, nothing written. |
| 9 | `apply_budget_templates` for next month + `get_category_note` | ok (after fix 1) | `budget/apply-goal-template` runs through `api.default.internal.send`; `getBudgetMonth` re-read shows Comida budgeted 100 (`changed` before 0 → after 100, `count` 1); Ocio listed in `ui_template_categories` with a warning; `get_category_note(Ocio)` reports `template_source: ui` plus the warning. |
| 10 | `find_transfer_issues` on imported rows with history to Adelantos | ok | The `account: { $oneof: [...] }` query in `loadDetectInput` works. Compensated row (same signed amount in Adelantos within ±60 days) → `alta`; same shape with «Nómina» in the notes → `dudosa` (keyword reason plus compensation reason). |

## Source fixes (separate commits)

1. `fix(apply_budget_templates): read api.default.internal, the ESM named export is a null snapshot`.
   Under Node ESM (and tsx) `import * as api from '@actual-app/api'` copies the CJS exports when the
   module is imported, so `api.internal` stays `null` even after `init`; the live object is
   `api.default.internal`. `sendInternal` read `api.internal`, so `apply_budget_templates` always raised
   "internal API not available" in production; the mocked unit tests hid it. Now
   `api.internal ?? api.default?.internal`.
2. `fix(import_transactions): an ignored preview row with no live row is a deleted one`.
   With `reimportDeleted: false` Actual matches the tombstone by `imported_id` and, when nothing would
   change, returns it as `{ ignored: true }` with no tombstone mark (the `tombstone: true` entry only
   appears for rows that did not match), so a deleted row was reported `unchanged`. Nothing was
   re-imported, but the outcome was wrong. Now `unchanged` rows with no live AQL row become `kept_deleted`.

## Answers to the "only verifiable on a real server" questions

- Child rows from `splits:'all'` carry `account`: yes (checks 1, 3).
- Category kept when a child is repointed to a cross-side transfer payee: yes (checks 1, 3).
- Splitting a manual transfer deletes the old twin and makes one per transfer part: yes, in one update (check 4).
- `remove_transaction_transfer` deletes the twin: yes (check 6).
- `dateRange` `$and` filter: compiles correctly (check 7).
- Import preview shapes and no duplicates on re-run: as described in check 8; added rows do not appear in `updatedPreview`.
- `api.internal.send('budget/apply-goal-template', ...)`: works through `api.default.internal`; `api.internal` is a stale `null` under ESM (check 9).
