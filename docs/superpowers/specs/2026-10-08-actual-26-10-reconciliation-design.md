# Actual 26.10 runtime + reconciliation tools — Design Spec

**Date:** 2026-10-08
**Status:** Approved by the maintainer (design review); pending written-spec review
**Language note:** Spec in English (publication-ready), like the other design specs.

## Overview

Two pieces of work, shipped in order, each with its own release:

- **Piece 0 — runtime base (v2.3.0).** Move to `@actual-app/api` 26.10.0 and rebuild the bundle
  pipeline around the N-API `better-sqlite3` 13 it brings. Today the extension is dead on the
  current Claude Desktop: Desktop moved to Electron 44.4.3 (`NODE_MODULE_VERSION` 149), the
  installed bundle carries a `better-sqlite3` 12 binary built for Electron 42 (ABI 146), and
  `npm run bundle` can no longer produce a fix because `better-sqlite3` publishes no
  `electron-v149` prebuild for any version. Piece 0 also includes a spike that decides how the
  reconciliation tools link two existing transactions into a transfer.
- **Piece A — reconciliation (v2.4.0).** Four new tools that let the user reconcile an account
  against a bank statement balance: find why balances differ, propose fixes, apply the accepted
  fixes in bulk, and mark the account reconciled.

Pieces B (day-to-day gaps: `runBankSync`, tags, account groups) and C (analysis: balance over
time, net-worth trend) are out of scope here and get their own specs.

### Motivating case

A personal budget with four bank-synced accounts (GoCardless) and several manually maintained
accounts (cash, pension, loans). After a bank sync, account balances do not match the bank
because of transfers:

- between two synced accounts, each leg arrives through its own bank sync as an ordinary
  transaction, so the two legs exist but are not linked as a transfer;
- between a synced account and a manual one, only the bank leg exists;
- a transfer created earlier by hand (or by `set_transaction_transfer`) whose bank-imported leg
  later arrived as well, leaving a duplicate.

Today the MCP has no tool that compares an account with a bank balance, finds unlinked transfer
pairs, merges duplicates, or marks transactions reconciled. `set_transaction_transfer` always
**creates** the opposite leg, which is exactly wrong for the first case.

### Goals

- The extension loads again on the current Claude Desktop, and keeps loading across future
  Electron upgrades without re-bundling for each ABI.
- The user gives a bank balance at a date; the MCP explains the difference and proposes
  concrete fixes, each with a confidence level.
- Accepted fixes are applied in one call; every fix is revalidated against current data before
  writing.
- Once the balance matches, the account can be marked reconciled up to that date.
- No tool ever touches an already-reconciled transaction, and no fix loses a transaction's
  `imported_id` (losing it makes the next bank sync re-import the transaction as a duplicate).

### Non-goals

- Automatic fixing without an explicit apply call. Even high-confidence proposals are applied
  only when the caller passes them to `apply_reconciliation_fixes`.
- A balance-adjustment transaction on reconcile (the app's "reconciliation adjustment"). A
  mismatch is never papered over.
- Comparing against the bank-reported `balance_current` of synced accounts. The user's
  reference is the balance they read in their bank app or statement.
- Bulk undo of applied fixes.
- Pieces B and C.

## Piece 0 — runtime base

### 0.1 Dependency upgrade

- `@actual-app/api` `^26.8.0` → `^26.10.0`. It depends on `better-sqlite3 ^13.0.3`, the first
  N-API major: one binary loads in any Node or Electron runtime, and `prebuild-install` is gone.
- `engines.node` (`package.json`) and `runtimes.node` (`manifest.json`) are already `>=22`,
  which is what 26.10.0 requires. No change.
- 26.8.0 made `getCategories` return a flat list. The MCP reads categories through
  `getCategoryGroups`, so it is not affected; the existing tests confirm it.
- The integration test server (`test/integration/docker-compose.actual.yml`) moves from
  `actualbudget/actual-server:26.7.0` to `26.10.0`, matching the production servers.

### 0.2 Bundle pipeline (`scripts/bundle.ts`, steps 5–6)

With N-API the current verification is inverted: it aborts when the binary **loads** under the
build machine's Node, assuming that means "Node ABI, not Electron ABI". An N-API binary loads
under both, so the script would reject a good bundle.

- **Step 5 (new):** install nothing runtime-specific. The binary left by `npm ci --omit=dev` is
  the one that ships.
- **Step 6 (new):** verify the shipped `better_sqlite3.node`:
  1. **Static check (mandatory):** it exports `napi_register_module_v1` (`nm -gU`). If not, it
     is not an N-API build — abort.
  2. **Runtime check: manual, not in the script.** Running Claude Desktop's binary with
     `ELECTRON_RUN_AS_NODE=1` was dropped during planning: if Claude Desktop ships with the
     `RunAsNode` fuse disabled, that command starts a second GUI instance of Claude Desktop
     instead of a Node process. The real runtime check is the maintainer installing the
     bundle and calling `get_accounts` (0.4).
- Electron version detection (`parseElectronVersion`) stays, only to log the version
  (`resolveElectronTarget` was removed). `parsePrebuildAbi` and `describeAbiCheck` and
  their tests are removed.
- The `CLAUDE.md` note "a major Claude Desktop upgrade forces a re-bundle" is replaced by the
  N-API rationale.

### 0.3 Spike — linking two existing legs into a transfer

The API has no "make transfer from these two transactions" (the app's *Make transfer* action).
Before Piece A's `link` operation is designed in detail, a throwaway script against the ephemeral
26.10.0 server tests the candidate mechanisms on a fixture of two on-budget accounts, each with
one imported transaction (`imported_id` set, opposite amounts, same date):

1. **Transfer + merge:** set leg X's payee to account B's transfer payee (Actual creates a new
   leg X′ in B), then `mergeTransactions([X′, Y])`.
2. **Direct link:** write `transfer_id` (and transfer payees) on both X and Y.

For each mechanism record: are X and Y (or the survivor) linked both ways (`transfer_id`
pointing at each other); which row survives a merge and which fields it keeps — **`imported_id`
in particular**; account balances afterwards; and whether a subsequent `sync()` from a second
client sees a consistent state.

The spike also settles two facts Piece A depends on:

- whether `getAccountBalance(id, cutoff)` includes or excludes transactions dated on `cutoff`;
- how `mergeTransactions` chooses the surviving row.

**Exit rule:** if neither mechanism yields linked legs that keep the bank leg's `imported_id`,
work stops and the maintainer is consulted before Piece A's `link` operation is built. (Deleting
the bank leg and letting Actual recreate it is rejected up front: it loses `imported_id`.)

The spike's findings are written into this spec (section *Spike results*) before Piece A starts.

### 0.4 Done criteria for Piece 0

- Unit and integration suites pass against 26.10.0.
- `npm run bundle` produces the `.mcpb` with the static check passing (and the runtime check
  passing or explicitly skipped).
- The maintainer installs it in Claude Desktop and `get_accounts` answers against the real
  server (read-only).
- Version bumped to **2.3.0**. No tool contract changes.

## Piece A — reconciliation tools

Approach: **stateless tools with explicit operations.** Read tools return proposals that already
contain the exact operation to perform; the write tool takes a list of those operations, not
opaque proposal ids. Nothing is kept in server memory between calls, so extension restarts or a
bank sync between proposing and applying cannot leave stale state — every operation is
revalidated when applied.

Tool names follow the existing English `snake_case`; all messages are Spanish, through the
existing localized-messages layer.

### Operation model

Every proposal carries one operation and a confidence:

```ts
type Confidence = 'alta' | 'dudosa';

type Operation =
  | { type: 'link'; a: string; b: string }                 // two existing legs → one transfer
  | { type: 'create_transfer'; transaction: string; account: string } // create missing leg
  | { type: 'merge'; keep: string; drop: string };          // duplicate pair

interface Proposal {
  operation: Operation;
  confidence: Confidence;
  reason: string;          // Spanish, human-readable: why this was proposed
  transactions: TxSummary[]; // id, account, date, amount, payee, imported (bool)
}
```

For `merge`, `keep` is always the bank-imported row (it carries `imported_id`); `drop` is the
non-imported one.

### Detection rules

All rules skip reconciled transactions, split children and parents, and transactions that are
already transfers (`transfer_id` set). Amounts are compared exactly (integer cents).

**`link`** — X in account A and Y in account B (A ≠ B), `X.amount = −Y.amount`, dates at most
3 days apart.
- `alta`: X and Y are each other's *only* candidate, and the dates are at most 1 day apart.
- `dudosa`: otherwise (several candidates, or 2–3 days apart). When X has several candidates,
  one `dudosa` proposal is emitted per candidate.

**`create_transfer`** — X in a bank-synced account with no `link` candidate, whose target is a
manually maintained account (no bank sync).
- Target from **history**: an earlier transaction with the same imported payee was turned into a
  transfer to account M → `alta` if that history points to one single account M, `dudosa` if it
  points to several.
- Target from **name**: the payee name or notes contain an account's name (case- and
  accent-insensitive) → `dudosa`.
- No target found → no proposal.

**`merge`** — two transactions in the same account with the same amount, dates at most 2 days
apart, exactly one of them imported (`imported_id` set).
- `alta`: same date. `dudosa`: 1–2 days apart.
- This covers the transfer leg created by hand or by `set_transaction_transfer` that the bank
  later imported again. When the non-imported row is a transfer leg, the merge must keep the
  link (see *Applying `merge` on a transfer leg*).

Two imported rows with the same amount and date are **not** proposed: they are normally two
genuine transactions (two identical card payments on the same day).

### Read tools

#### `reconcile_account`

Input: `account` (name or id), `bank_balance` (decimal, account currency), `date`
(`YYYY-MM-DD`).

Output:
- `actual_balance`: balance at **close of `date`** (the tool corrects for the cutoff convention
  the spike establishes).
- `difference` = `bank_balance − actual_balance`.
- `reconciled_balance`: sum of transactions already reconciled.
- `proposals`: the detection rules above restricted to this account and to transactions dated on
  or before `date`, plus any single unreconciled transaction in the account whose amount equals
  `difference` exactly (reported as a hint, no operation attached).
- When `difference` is 0: says the account matches and suggests `mark_reconciled`.

#### `find_transfer_issues`

Input: `start_date`, `end_date` (default: last 90 days), optional `accounts` filter.

Output: all `link`, `create_transfer` and `merge` proposals in the range, grouped by operation
type, `alta` first.

### Write tools (require `ENABLE_WRITE`)

#### `apply_reconciliation_fixes`

Input: `operations: Operation[]` (the caller passes the ones the user accepted; filtering by
confidence is the caller's job).

Behaviour:
1. `sync()`.
2. For each operation, in order, **revalidate** against current data: the rows exist; none is
   reconciled; none is already a transfer (for `link` / `create_transfer`); amounts still match
   the rule; for `merge`, `keep` is still the imported row. A failed check marks the operation
   `omitida` with the reason, and processing continues.
3. Apply:
   - `link` → the mechanism chosen by the spike (0.3).
   - `create_transfer` → the same path as `set_transaction_transfer`.
   - `merge` → `mergeTransactions([keep, drop])`, then verify that the survivor is `keep` and
     still has its `imported_id`.
4. `sync()`.
5. Return one result per operation: `aplicada` (with the resulting ids), `omitida` (reason) or
   `fallida` (error).

**Compound operations.** If `link` takes two writes (transfer + merge) and the second fails, the
tool reverts the first (clears the transfer payee on X, which removes X′) and reports `fallida`
with "revertida". If the revert also fails, the result lists the exact ids left half-done so they
can be fixed by hand.

**Applying `merge` on a transfer leg.** If `drop` is a transfer leg, merging must leave the link
pointing at the survivor. The spike checks whether `mergeTransactions` does this itself; if not,
`merge` on a transfer leg runs as: merge, then re-point the transfer on the survivor. Same revert
rule as above.

#### `mark_reconciled`

Input: `account`, `date`, `bank_balance`.

Behaviour: `sync()`; recompute the balance at close of `date`; if it differs from
`bank_balance`, refuse and return the difference (no writes). Otherwise set `cleared = true` and
`reconciled = true` on every unreconciled transaction in the account dated on or before `date`;
`sync()`; return how many were marked.

### Change to an existing tool

`set_transaction_transfer`: when the target account is bank-synced, the response adds a warning
that creating the opposite leg there usually ends in a duplicate once the bank imports it, and
points to `find_transfer_issues` / the `link` operation. Behaviour is otherwise unchanged.

## Error handling

- Spanish, actionable messages through the localized-messages layer (e.g. unknown account →
  list the available ones).
- No tool writes to a reconciled transaction; unlike `split_transaction` there is no `force`
  override.
- Every write tool syncs before and after, as today.
- Revalidation failures are per-operation results, not exceptions; one bad operation never
  aborts the batch.

## Testing

**Unit** (mock API, `tests/helpers/mock-api.ts`): one test file per new tool, plus the detection
rules — unique vs ambiguous `link` pairs, the 1-day / 3-day windows, history-based and name-based
`create_transfer` targets, `merge` only with exactly one imported row, `mark_reconciled` refusing
on mismatch, revalidation when data changed between propose and apply, compound-operation
revert. The manifest test keeps checking the manifest against the real tool catalogue.

**Integration** (ephemeral 26.10.0 server): a fixture mirroring the motivating case — two "synced"
accounts with imported transactions, one manual account, a transfer with both legs imported, one
with only the bank leg, and one duplicate. Run the full cycle `reconcile_account` →
`find_transfer_issues` → `apply_reconciliation_fixes` → `mark_reconciled` and assert: balances
match, transfers are linked both ways, every `imported_id` survives.

**Real-data check (manual, maintainer-approved):** after a cold copy of the server's data, run the
read tools on the account that motivated this work, review the proposals, then apply the accepted
ones.

## Releases

- **2.3.0** — Piece 0 (runtime, bundle pipeline). No tool contract changes.
- **2.4.0** — Piece A (four new tools, `set_transaction_transfer` warning).

## Spike results

Run on 2026-10-08 against `actualbudget/actual-server:26.10.0` with `@actual-app/api` 26.10.0
(`scripts/verify/spike-link-transfer.ts`, three runs: the first hit an unbootstrapped server and
`invalid-password`; the second showed X′ is not yet visible right after the update; the third,
with polling, is the one quoted).

- **Mechanism A (transfer + merge):** works — survivor is **Y** (the bank leg of account B,
  not X′), keeps `imported_id` (`SpikeA-y`): yes, linked both ways: yes (X `transfer_id` = Y and
  Y `transfer_id` = X, X keeps `SpikeA-x`), balances: ok (`balanceA = -10000`, `balanceB =
  10000`, one live row per account, no leftovers). Merge order does not matter: `[Y, X′]` gave
  the same result (survivor Y, both `imported_id` kept, balances ok). Timing caveat: right after
  `updateTransaction(X, { payee: transferPayeeOf(B) })` X′ is **not yet visible** (first run read
  account B immediately and found no X′, so the merge was skipped); polling found it after
  ≤ 250 ms (`waitedMs: 250`). `link` must poll for X′ before merging. A second client that
  downloads the budget sees the same linked pair.
- **Mechanism B (direct `transfer_id`):** does not work — it throws nothing (`error: null`) but
  **destroys the bank leg Y**: account B ends with no live row carrying `SpikeB-y`; Actual
  generates a fresh counterpart in B with `imported_id: null`, linked to X. The next bank sync
  would re-import `SpikeB-y` as a duplicate. Rejected.
- **Chosen for `link`:** A, because it is the only one that leaves both bank legs alive, linked
  both ways, each with its own `imported_id`.
- **`mergeTransactions` survivor rule** (source: `core/src/server/transactions/merge.ts`,
  `determineKeepDrop`): keep the one with `imported_id` if only one has it; else the one with
  `imported_payee` if only one has it; else the earlier date (ties: the second argument).
  The survivor keeps its own id and `imported_id`; `payee`, `category`, `notes`, `cleared`,
  `reconciled`, `schedule` fall back to the dropped row's value when the survivor's is empty.
  With a transfer involved, the survivor gets `transfer_id` = the other leg and the transfer
  payee of the transfer leg; for on-budget accounts its category is cleared. **Caveat:** if both
  rows carry `imported_id`, the date rule decides, so `link` must only merge X′ (no
  `imported_id`) with Y.
- **`getAccountBalance` cutoff:** inclusive of the cutoff day and blind to the time of day.
  The server runs `date <= dayFromDate(cutoff)`. Transaction dated 2026-09-15: cutoff
  `2026-09-15T00:00:00` -> 500, `2026-09-15T23:59:59` -> 500, `2026-09-14T23:59:59` -> 0,
  `2026-09-14T12:00:00` -> 0, no cutoff -> 500. "Close of day D" = `new Date('D')` of that day
  (local date); to exclude D use D-1. (`new Date('D' + 'T00:00:00Z')` also gave 500; the day is
  taken in local time, so avoid UTC strings near midnight.)
- **Second client after sync:** consistent. A fresh client downloading the budget after
  `sync()` sees the same rows for mechanism A (both legs, linked both ways, `imported_id`s
  intact) and the same state for B (bank leg Y missing, generated counterpart present).
