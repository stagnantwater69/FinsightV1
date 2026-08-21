# FinSight development workflow

This document describes the current path from the working candidate to a
capstone demonstration, while preserving future production requirements. It replaces the original scaffold-era phase plan, whose
functional phases have now been substantially implemented. Read the
[progress report](PROGRESS-REPORT.md) for the supporting evidence and the
[implementation brief](CLAUDE-CODE-PROMPT.md) for product constraints.

## Current status

FinSight is feature-complete for its capstone demonstration and is entering
internal acceptance and physical-device validation. The project team are the
intended evaluators; there is no external participant cohort. New broad feature
work should wait until the candidate is reproducible and demo-ready.

## Stage 0 — stabilize the candidate

1. Review the full working tree, including migrations, tests, documentation,
   generated assets, and intentional file moves.
2. Keep changes in coherent commits by concern; do not mix unrelated feature,
   migration, content, and release-operation changes when they can be reviewed
   independently.
3. Run the complete backend, web, and mobile verification gate.
4. Apply the full Prisma migration chain to a clean dedicated database.
5. Smoke-test registration, business creation, record entry, dashboard output,
   receipt upload, owner confirmation, and source-file access.

Exit criteria:

- the working tree contains no accidental files or unreviewed generated output;
- all migrations and required assets are committed;
- all automated checks pass from the committed state;
- the clean-database smoke flow completes or any external dependency blocker
  is recorded explicitly.

## Stage 1 — internal capstone acceptance

1. Use the existing Supabase development project with a clearly labeled test
   account and synthetic business data; a separate paid UAT project is not
   required for the declared capstone scope.
2. Resolve critical hosted-project security findings before adding more test
   data, especially public tables without RLS or equivalent Data API isolation.
3. Follow the [internal acceptance checklist](internal-acceptance-checklist.md)
   on web and mobile.
4. Include at least one complete scan-to-confirm session on the Android phone
   that will be used for the presentation.
5. Record screenshots, expected versus actual financial totals, defects, fixes,
   and retest results.
6. Use only synthetic transactions and non-sensitive sample receipts.
7. Prepare and preserve a clean demonstration account and fallback screenshots.

Exit criteria:

- every critical checklist item passes;
- no unresolved defect prevents the presentation workflow;
- real-device evidence and expected-versus-actual financial totals are recorded;
- the work is described as internal/developer acceptance, not representative
  end-user UAT.

## Stage 2 — close production-operation gaps

These remain future production requirements and are not claimed as completed
capstone deliverables:

- choose the production topology and secrets-management approach;
- route the implemented structured, correlated logs to centralized retention and alerting;
- configure platform probes for the implemented liveness and database-aware readiness endpoints;
- rehearse database restoration into a scratch environment and record recovery
  time;
- define and test recovery for receipt and CSV storage objects;
- load-test and monitor the implemented durable receipt-job leasing/retry process;
- exercise the implemented account erasure flow against disposable hosted data;
- monitor shared rate-limit cleanup and sustained quota exhaustion.

## Stage 3 — release engineering

1. Produce and install a signed Android test build.
2. Verify permissions, camera capture, upload, network loss, and app
   backgrounding on representative devices.
3. Extend the Playwright foundation with authenticated money-changing workflows.
4. Establish performance budgets for web bundles and receipt processing.
5. Complete web and mobile accessibility reviews.
6. Handle dependency upgrades separately from candidate stabilization.

## Change rules

- Treat financial calculations, ownership checks, confirmation flows, and
  migrations as high-risk changes requiring targeted tests.
- Do not run destructive integration tests against a shared or hosted
  database.
- Do not expose Supabase service-role credentials to either client.
- For a hosted migration, verify both database URLs and the target project
  before applying it.
- Re-run the complete verification gate after the final commit, not only before
  committing.
- Record any manual or external validation that cannot be reproduced in CI.

## Complete verification gate

```bash
cd backend
npm run typecheck
npm run build
npx prisma validate
npm test

cd ../web
npm run typecheck
npm test
npm run build

cd ../mobile
npm run typecheck
npm test
```

The release gates and unresolved risks remain authoritative in
[PROGRESS-REPORT.md](PROGRESS-REPORT.md#proposed-production-pilot-gates).
