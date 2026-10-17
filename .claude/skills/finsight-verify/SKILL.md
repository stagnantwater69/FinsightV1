---
name: finsight-verify
description: Use before claiming any FinSight change is done, verified, or passing, and whenever running typecheck/lint/test/build or backend integration tests. Encodes the Node version, the throwaway-database rules, the env-file rules, and what counts as evidence.
---

# FinSight verification

## Overview

The gate itself is in `CLAUDE.md`. This skill exists for everything around it
that has repeatedly cost real time: the wrong Node version, a shared test
database that fails tests you did not break, an env-file mistake that has
destroyed live credentials four times, and reports that claim a pass without
the output to back it.

Run the gate **proportionally**: the projects you actually touched, not all
three out of habit. A mobile-only change does not need the backend suite.

## Node version

The project requires **Node 22**; the shell default here is v24. Every
`npm`/`npx`/`prisma`/`vitest` command that must match CI needs:

```bash
source ~/.nvm/nvm.sh && nvm use 22
```

Results produced on Node 24 are not comparable to CI and must not be reported
as a gate pass.

## The shared test database will fail tests you did not break

`npm run test:db:up --prefix backend` creates the shared container
`finsight-test-db` on port 55432. That container drifts: its recorded
migration checksums go stale, and the Phase 2 migration-guard tests then fail
(19 failures at last encounter) with `status: 'drift'` and a
`checksumMismatches` list. **That is not your regression.**

Two correct responses:

- `npm run test:db:reset --prefix backend` to rebuild the shared container, or
- create a **uniquely named** throwaway on port **55434 or above**:

```bash
docker run -d --name finsight-<task>-db \
  -e POSTGRES_PASSWORD=testpass -e POSTGRES_USER=testuser -e POSTGRES_DB=finsight_test \
  -p 55434:5432 postgres:16-alpine
export DATABASE_URL='postgresql://testuser:testpass@localhost:55434/finsight_test'
export DIRECT_URL="$DATABASE_URL"
```

Remove the throwaway when finished.

**Protected containers — never stop, remove or reuse these:**
`finsight-test-db` (55432), `finsight-phase2-db-audit` (55433).

Integration tests are destructive and refuse to run against anything but the
dedicated `finsight_test` database. Never point them at the hosted Supabase
project.

### The one-line export trap

`export A=x B="$A"` leaves `B` empty. Prisma then fails closed with P1012, so
nothing is damaged, but the time is lost. Always use two statements, as above.

## Env files

`backend/.env`, `web/.env` and `mobile/.env` hold live credentials with no
other copy in the repo. **Never move, rename, overwrite or delete them.** This
has caused `backend/.env` to go missing at least four times.

If a task needs a scratch env file, copy it to a differently-named file
(`.env.citest`, `.env.bak`) and leave the original untouched. A backup exists
outside the repo at `~/.finsight-env-backup/`, and it is not a licence to be
careless — it lags the live file.

Reading an env file to check a non-secret setting is fine. Printing secrets
into the transcript is not: filter with
`grep -viE 'key|secret|token|password'`.

## What counts as evidence

A claim of "passing", "fixed" or "done" needs the command output that proves
it, in the same reply. Specifically:

- Name the counts you actually saw ("164 files / 2,418 passed / 1 skipped"),
  not a remembered number.
- If a suite was skipped or a project not run, say which and why.
- A test you wrote must be shown to fail against the unfixed code before its
  pass means anything. Stash the fix, run it, restore.
- **Never convert absent evidence into a pass.** Mobile camera, permission and
  lifecycle behaviour has no automated coverage: say "needs physical-device
  verification", never "tested". The OCR corpus is mostly synthetic: never
  present it as real-receipt evidence.

## Before reporting

- Working tree contains only the files the task called for
  (`git status --short`); no stray scratch files, no `.env` churn.
- Scratch work lives in the session scratchpad, never in the repo or `/tmp`.
- Commits in this repo carry **no** Claude co-author trailer.
