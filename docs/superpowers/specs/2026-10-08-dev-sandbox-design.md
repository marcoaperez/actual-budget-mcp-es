# Dev sandbox with a copy of the real budget — Design Spec

**Date:** 2026-10-08
**Status:** Approved by the maintainer (design review); pending written-spec review
**Language note:** Spec in English (publication-ready), like the other design specs. This repo is
public: nothing here names the maintainer's hosts, paths or budgets; those live in a git-ignored
`dev/.env`.

## Overview

A local, disposable Actual server holding a **copy of the maintainer's real budget**, plus an
`actual-dev` MCP server registered only for Claude Code sessions in this repo. It lets the
maintainer try the MCP — first of all the 2.4.0 reconciliation tools on real, messy transfers —
without any chance of writing to the production server, and throw the copy away and take a fresh
one at will.

### Goals

- Test against the maintainer's own data (real accounts, real transfer mistakes), not synthetic data.
- Make it impossible, not just unlikely, for the dev MCP to write to production: it refuses to start
  unless pointed at the local sandbox.
- One command to rebuild the sandbox from a backup, without stopping production by default.
- The copy can never talk to the bank (no bank-sync credentials) and never needs the real password.
- The Claude Desktop extension keeps pointing at production, untouched.

### Non-goals

- Synthetic/demo datasets (the existing `scripts/demo/` covers the public demo instance).
- Deploying the sandbox anywhere but the maintainer's Mac (no Arcane/GitOps: it is a dev tool, not a
  service).
- Syncing results back to production. Anything that works in the sandbox is repeated by hand on
  production from Claude Desktop.
- Using the sandbox from Claude Desktop.

## Components

All under `dev/` in the repo, plus `.mcp.json` at the root.

### 1. `dev/docker-compose.yml`

`actualbudget/actual-server:26.10.0` (same version as production), published on
**`127.0.0.1:5007:5006`** only, with `/data` bound to `dev/data/` (git-ignored). Port 5007 keeps it
apart from the integration-test server on 5006.

### 2. `dev/.env` (git-ignored) and `dev/.env.example` (committed)

```
# Where the copy comes from (maintainer-specific; never committed)
DEV_SOURCE_SSH=<ssh alias of the production host>
DEV_SOURCE_BACKUP_GLOB=<remote glob of the nightly tarballs of the Actual data dir>
DEV_SOURCE_TAR_MEMBER_PREFIX=<path prefix inside the tarball up to and including data/>
DEV_SOURCE_DATA_DIR=<remote Actual data dir, for --cold>
DEV_SOURCE_CONTAINER=<remote container name, for --cold>
DEV_BUDGET_NAME=<budget name to open, e.g. Personal>
# Written by dev:refresh
ACTUAL_SYNC_ID=<filled in>
```

### 3. `npm run dev:refresh` (`scripts/dev/refresh.ts`, run with `tsx`)

1. Read `dev/.env`; fail with a clear message if a required source variable is missing.
2. Refuse if port 5007 is held by anything other than this compose project's container.
3. `docker compose -f dev/docker-compose.yml down`, then empty `dev/data/`.
4. Fetch the copy:
   - **default:** the newest file matching `DEV_SOURCE_BACKUP_GLOB` on `DEV_SOURCE_SSH`, streamed
     over SSH and extracted into `dev/data/` (production is not stopped);
   - **`--cold`:** after an explicit typed confirmation (`detener`), stop `DEV_SOURCE_CONTAINER`,
     tar `DEV_SOURCE_DATA_DIR`, start it again, then extract. The confirmation text says production
     will be unavailable for a few seconds.
5. Neutralise `dev/data/server-files/account.sqlite` (section *Neutralisation*).
6. `docker compose up -d`, wait for `/info`, bootstrap the dev password.
7. Look up `DEV_BUDGET_NAME` in the copy's `files` table; write its `group_id` as `ACTUAL_SYNC_ID`
   into `dev/.env`. Fail listing the available names if it is not there.
8. Print a summary: source file and date, budgets found, budget selected, and how to start a
   Claude Code session.

Steps with logic worth testing (source selection, `.env` parsing/writing, budget lookup,
neutralisation SQL) live in small pure modules under `scripts/dev/` with Vitest tests; the script
only orchestrates.

### 4. `.mcp.json` (committed)

Registers one MCP server for Claude Code in this repo:

```json
{ "mcpServers": { "actual-dev": { "command": "npx", "args": ["tsx", "scripts/dev/mcp-dev.ts"] } } }
```

### 5. `scripts/dev/mcp-dev.ts` — the guard

Written in TypeScript instead of shell so the guard logic (`buildDevEnv`, `checkGuard`) is unit-tested; `.mcp.json` runs `npx tsx scripts/dev/mcp-dev.ts`.

Starts the MCP from source (`npx tsx src/index.ts`) with:
`ACTUAL_SERVER_URL=http://localhost:5007`, `ACTUAL_SERVER_PASSWORD=actual-dev`,
`ACTUAL_SYNC_ID` from `dev/.env`, `ACTUAL_DATA_DIR=dev/.cache`, `ENABLE_WRITE=true`,
`MESSAGES_LANG=es`.

Before launching it checks, and exits non-zero with a message on stderr if any fails:
- the effective URL is exactly `http://localhost:5007` (even if the environment tried to override it);
- `GET http://localhost:5007/info` answers;
- `ACTUAL_SYNC_ID` is set and is a UUID.

The packaged `.mcpb` does not include `dev/` or this script.

## Neutralisation

Measured on a real copy (2026-10-08): `account.sqlite` has tables `auth`, `secrets`, `files`,
`sessions`, `users`, `user_access`, `server_prefs`, `pending_openid_requests`; `secrets` holds
`gocardless_secretId` and `gocardless_secretKey`; `auth` has one row; `files` lists the budgets by
`name` with their `group_id`.

- `DELETE FROM secrets;` — the copy can never reach the bank; bank sync fails instead of calling out.
- `DELETE FROM auth; DELETE FROM sessions;` then `POST /account/bootstrap {"password":"actual-dev"}`
  — the real password is never needed or handled. `actual-dev` only protects a copy listening on
  127.0.0.1, so it is committed.
- `files` is left intact (it is the server's registry of budgets).

**Open question, settled by the first plan task:** does clearing `auth` (and `sessions`) leave the
server bootstrappable with the `files` registry intact and the budgets downloadable? (Deleting the
whole `account.sqlite` broke the registry on the demo instance.) If not, the fallback is to keep
`auth` and change the password through the server's change-password endpoint after logging in with
a one-off token — to be designed only if needed.

## Neutralisation results

Run on 2026-10-08 against `actualbudget/actual-server:26.10.0` on the sandbox port with synthetic
data (`scripts/dev/spike-neutralise.ts`):
- after `DELETE FROM secrets/auth/sessions`, `needs-bootstrap` -> `bootstrapped: false`; bootstrap `actual-dev` -> `status: ok` (token returned);
- budget listed: yes; downloadable with the new password: yes; account and balance intact: yes (`Cuenta spike`, 12345).
- Conclusion: the neutralisation in the spec works as designed.

## Isolation guarantees

- The sandbox is a different server holding its own copy; no client points at both, so nothing
  written in the sandbox reaches production.
- The dev MCP has its own cache dir (`dev/.cache/`), separate from the extension's.
- The guard makes a misconfigured `actual-dev` fail to start rather than connect elsewhere.
- No bank credentials in the copy.
- `dev/data/`, `dev/.cache/` and `dev/.env` are git-ignored; a test asserts it.

## Testing

**Unit (Vitest):**
- guard: accepts only `http://localhost:5007`; rejects `http://localhost:5006`, `http://127.0.0.1:5007`,
  `https://localhost:5007`, any remote URL; rejects a missing/invalid Sync ID (the shell guard is
  exercised by running it with a fake environment and a stubbed `/info`);
- source selection picks the newest backup from a listing;
- `.env` read/write keeps unrelated lines and comments;
- budget lookup by name, and the failure listing available names;
- neutralisation on a toy `account.sqlite`: `secrets`/`auth`/`sessions` emptied, `files` untouched;
- `.gitignore` covers `dev/data/`, `dev/.cache/`, `dev/.env`.

**Acceptance (manual, once, by the maintainer):**
1. `npm run dev:refresh` from last night's backup.
2. Claude Code in this repo: `actual-dev` appears; `get_accounts` returns last night's balances.
3. Create a test transaction in the sandbox; check it does **not** appear in production (Claude
   Desktop / web).
4. Bank sync in the sandbox fails.
5. Point `.mcp.json` at another URL by hand: the guard refuses to start.

## Out of scope / later

- A `--budget` switch per refresh (the `.env` value is enough for now).
- Snapshots inside the sandbox (refresh is the reset).
