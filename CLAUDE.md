# FinSight — working agreement

**Read [`AGENTS.md`](AGENTS.md) before starting any non-trivial task.** It defines the 8-agent team, the ownership map for every directory, the task-report format, priority levels (P0–P3), and the rules that keep agents from making conflicting edits.

## Fast facts

- Monorepo-ish layout, three independent npm projects — no root install step: `backend/` (Express + Prisma + TypeScript), `web/` (Vite + React 19 + Tailwind), `mobile/` (Expo + React Native).
- Postgres via Supabase; Supabase also provides Auth and Storage. All application-table access goes through Express/Prisma — RLS is deny-all for the `anon`/`authenticated` roles by design.
- **This is a mature codebase, not a prototype.** Nearly every core feature is already implemented and tested (~845 tests across the three projects). Verify against the code before concluding a feature is missing.

## Verification gate

Use Node 22 and install all three projects first; backend contract tests import
web and mobile payload builders. These are the core checks also enforced by CI:

```bash
node scripts/check-type-parity.mjs
cd backend && npx prisma generate && npx prisma validate && npm run typecheck && npm run lint && npm run build && npm test
cd ../web && npm run typecheck && npm run lint && npm test && npm run build && npm run check:bundle-budget
cd ../mobile && npm run typecheck && npm run lint && npm test
```

Backend integration tests need the throwaway Postgres container: `npm run test:db:up --prefix backend`. They are destructive and refuse to run against anything but the dedicated `finsight_test` database.

Set `DATABASE_URL` and `DIRECT_URL` explicitly to an isolated local `finsight_test`
instance before the backend gate. Do not run two suites against that database at
once. The [verification skill](.claude/skills/finsight-verify/SKILL.md) explains
protected containers and session isolation. CI additionally checks migration
reconciliation/drift, browser journeys, production dependencies, container boot,
worker readiness, and proxy probes; see [the workflow](.github/workflows/ci.yml).

## Hard rules

- Never regress ownership isolation (every query scoped to the authenticated user's active business profile), the deny-all RLS posture, or durable DB-backed rate limiting.
- Never commit `.env` files, Supabase service-role keys, or other secrets.
- Never move, rename, or delete `backend/.env`, `web/.env`, or `mobile/.env` — they hold live credentials with no other copy in the repo (a local backup lives outside the repo at `~/.finsight-env-backup/`, but don't rely on that as a reason to be careless). If a task needs a scratch/throwaway env file (e.g. for a CI-simulation test), copy it to a differently-named file (`.env.citest`, `.env.bak`, etc.) and leave the original untouched — do not `mv` or overwrite the original, even temporarily. This has caused the real `backend/.env` to go missing at least four times.
- Mobile camera/permission/lifecycle behavior has **no** automated coverage — say "needs physical-device verification," never claim test coverage it doesn't have.
- Don't present the mostly-synthetic OCR corpus as real-receipt evidence.
- Commits in this repo do **not** carry a Claude co-author trailer.

<!-- antislop:start -->
## Project skills

Beyond the anti-slop set below, two FinSight-specific skills are installed and
should be loaded when they apply:

- `finsight-verify` — before claiming anything is done, verified or passing,
  and before running the gate or backend integration tests. Covers the Node 22
  requirement, the throwaway-database rules (the shared `finsight-test-db`
  drifts and fails migration-guard tests you did not break), the env-file
  rules, and what counts as evidence.
- `finsight-receipt-pipeline` — before changing anything in the receipt
  scan/extraction path. Maps the stages to their owning files and states the
  invariants that a passing suite will not always protect: which reading wins
  under each routing mode, what local evidence may claim, lease-guarded
  writes, and dispatch idempotency.

`finsight-ui-polish` still applies to any UI change in `web/src` or
`mobile/src`.

## Anti-slop skill routing

Project-local skills `antislop`, `antislop-copywriting`, and `antislop-code`
are already installed. For work that changes or audits UI, user-facing copy,
or code comments, invoke the core and then only the relevant add-on through
the Skill tool. Treat a requested implementation/refinement as DURING mode;
use AFTER only for an explicit anti-slop audit. Do not run the embedded
first-run wizard or installer.

Limit the checks to the requested or directly affected surface. `AGENTS.md`,
`PRODUCT.md`, `DESIGN.md`, ownership/security rules, and FinSight-specific
skills take precedence over generic anti-slop advice. Its Delivery Gate
supplements proportional project verification and never converts missing
physical-device or representative-receipt evidence into a pass.
<!-- antislop:end -->
