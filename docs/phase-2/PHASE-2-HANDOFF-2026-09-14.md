# FinSight Phase 2 continuation handoff

**Prepared:** 14 September 2026

**Repository:** `/home/ken/FinsightV1`

**Branch:** `feat/phase2-scanner-acceptance`

**HEAD at handoff:** `28394be` (`feat: implement receipt workflow phase 2`)

**Current decision:** Do not merge or describe Phase 2 as accepted yet

**Status update, 14 September 2026 (after commit):** The fixes were committed on 14 September 2026 as `36223ae` (P1 and P2 fixes, reconciliation migration, `20260914010610`, harness, legacy fixture, and these documents) and `aede3a5` (provider-first routing and policy consent), both pushed to `finsightv1/feat/phase2-scanner-acceptance`. The hosted CI push run on `aede3a5` passed (run 34799460479). PR #1 against `main` is open; its pull-request run was still in progress when this was audited. Sentences below that describe an uncommitted worktree, untracked Phase 2 files, or a pending commit and CI run were accurate at 01:50 PHT and are superseded by this note; the external acceptance gates (Stages 4 to 8) are unchanged.

**Continuation, 14 September 2026 (01:50 PHT):** Stages 0, 0A, 1, 2, and 3 below are complete in the local worktree. All eight P2 findings are fixed, qa-security-reviewed, and verified by complete gates. See [Continuation log](#continuation-log-14-september-2026). Stages 4 to 8 remain open and require people, devices, private data, or owner authorization.

## Executive handoff

FinSight's Phase 2 receipt workflow is implemented as a review candidate. The four P1 findings from the first review have been fixed and verified locally, and as of 14 September 2026 the eight P2 findings are fixed and verified locally too. Physical Android testing, authorized hosted Supabase and private Storage checks, and a sealed consented real-receipt evaluation remain open. The P2 snapshot was committed later on 14 September (`36223ae`, then `aede3a5`; see the status update above).

The exact-snapshot backend replay (Stage 0A) was run and passed before any P2 change, the eight P2 findings were then resolved, and the complete repository and migration gates passed on the resulting snapshot. The independent read-only review of the whole range (PR 2), the commit, and hosted CI on `aede3a5` have since happened; the next gate is the PR #1 merge decision. The external acceptance work must remain open until the required people, devices, private data, credentials, and explicit authorization are available.

There is a large dirty and untracked worktree. Preserve it. Do not clean, reset, delete, stage, or commit unrelated files. The post-`28394be` P1 and P2 work was committed as `36223ae`; unrelated untracked files remain uncommitted.

## Read these first

Use the actual code, tests, and Git state as the final authority. Read these records before changing anything:

1. [AGENTS.md](../../AGENTS.md) for ownership, security rules, dependency order, and the required agent report format.
2. [PR 1 Phase 2 review](./PR-1-REVIEW-2026-09-13.md) for the four fixed P1 findings, the eight P2 findings and their 14 September resolution, residual risks, and required merge order.
3. [Phase 2 acceptance checklist](./PHASE-2-ACCEPTANCE-CHECKLIST.md) for the frozen policy, external evaluator, physical-device, hosted Storage, purge, and real-corpus gates.
4. [Phase 2 implementation evidence](./IMPLEMENTATION-EVIDENCE.md) for delivered scope and recorded test evidence.
5. [Hosted migration incident](./HOSTED-MIGRATION-INCIDENT.md) before running any database or Prisma command.
6. [Cost-first core feature implementation plan](../COST-FIRST-CORE-FEATURES-IMPLEMENTATION-PLAN.md) for the original full program plan and acceptance policy.
7. [Phase 0 status](../phase-0/README.md) for the frozen baseline and external evidence that remained open before implementation.
8. [Phase 1 implementation evidence](../phase-1/IMPLEMENTATION-EVIDENCE.md) for worker, provider, upload, operational, and earlier hosted-incident context.
9. [Deployment runbook](../deployment-runbook.md) before any authorized deployment or operational drill.

This document is a continuation map. It does not override newer source, tests, reviewer evidence, or an explicit owner decision.

## What the full plan was

### Program goal

Build a cost-first, privacy-preserving financial workflow that turns receipt captures into recoverable, owner-reviewed records. Local Tesseract remains the default OCR path. Paid OCR stays disabled unless a separate frozen benchmark, consent, budget, lifecycle, and operational gate approves it.

The wider program also covers CSV import and safe categorization, but the active branch is focused on Phase 2 scanner acceptance and receipt results.

### Original program roadmap

| Phase | Intended result | Current interpretation |
| --- | --- | --- |
| 0. Baseline and decisions | Freeze schema, corpus policy, benchmark inputs, retention, budget, device targets, and hosted classifications | The repository and migration prerequisite was locally checkpointed. External corpus, device, account, backup, and hosted classifications are still required for release acceptance. |
| 1. Worker, upload, and cost guardrails | Dedicated OCR worker, bounded uploads, packaged offline language data, local-first routing, provider consent and hard budget controls | Implemented before the Phase 2 branch. Keep its safety properties green. |
| 2. Scanner acceptance and results | Full-resolution evidence, Standard and Long capture, batches, stored retry, review, item edits, duplicate handling, confirmation, and deletion | Code is implemented. Four P1 review blockers and eight P2 items are fixed, committed (`36223ae`, `aede3a5`), and green in hosted CI on `aede3a5`. External acceptance and the PR #1 merge decision are still open. |
| 3. Extraction and provider benchmark | Normalize expanded fields and compare local OCR with an optional provider under a frozen benchmark | Not the current task. Cloud remains disabled until this phase's separate gates pass. |
| 4A. CSV result completion | Durable upload-once CSV import, malware checks, row lifecycle, complete report, and recoverable partial failure | Outside the present Phase 2 continuation. |
| 4B. Safe Excel extension | Add `.xlsx` only if OOXML, security, precision, and resource gates pass | Outside the present Phase 2 continuation. CSV-only is the honest fallback. |
| 5. Categorization | Deterministic owner rules and safe confidence bands, with low confidence never silently assigning a category | Outside the present Phase 2 continuation. |
| 6. Release gate | Full QA/security, hosted audit, backup/restore, capacity, UAT, and cost evidence | Open. It cannot be closed by repository tests alone. |

### Phase 2 target workflow

1. The authenticated owner captures or selects one or more receipt images.
2. Original full-resolution evidence is stored privately before OCR starts.
3. Upload and retry enqueue work. A dedicated worker owns OCR and provider dispatch.
4. Local Tesseract and parsing run first. Provider rescue remains disabled unless all separate gates approve it.
5. Processing state, pages, warnings, extracted fields, field regions, items, totals, categories, and duplicate candidates are durable and recoverable.
6. The owner can resume a scan, inspect source and derived evidence, correct fields and items, retry from stored bytes, or delete an unfinished scan.
7. Revisions prevent a stale client from overwriting newer scan edits.
8. Confirmation performs a locked duplicate recheck and writes financial records atomically.
9. Explicit `Save anyway` can override a reviewed duplicate warning while preserving the audit trail.
10. Unfinished scans can be purged. Confirmed financial records survive evidence detachment.
11. Private evidence links are owner-scoped and expire after ten minutes.
12. Abandoned unfinished scans enter an idempotent purge flow after seven days of inactivity. Implemented on 14 September as P2 finding 5.

### Phase 2 implementation sequence

The ownership sequence is:

`database -> backend-api -> mobile/web/AI-OCR in parallel -> qa-security -> devops-release -> orchestrator review`

The plan deliberately splits work by ownership boundary:

- `database` owns Prisma models, migrations, indexes, foreign keys, RLS, revokes, and query-plan-sensitive changes.
- `backend-api` owns receipt controllers, upload and retry orchestration, confirmation, leases, provider dispatch controls, duplicate persistence, Storage lifecycle, and purge behavior.
- `ai-ocr-analytics` owns OCR internals, parsing, confidence, provider adapters, extraction reconciliation, and benchmark reports.
- `mobile` owns capture, lifecycle, progress, evidence review, recovery, and device behavior.
- `web-frontend` owns web review, recovery history, accessible actions, and status behavior.
- `qa-security` owns regression, contract, concurrency, ownership-isolation, adversarial, and release-evidence coverage.
- `devops-release` owns CI, production images, secrets, worker health, hosted verification, backup/restore, and runbooks.
- `orchestrator` owns dependency order, integration, evidence review, and the final decision.

## What has been completed

### Original Phase 2 implementation

Commit `28394be` added the first Phase 2 implementation over main commit `204ca03`. The recorded delivered scope includes:

- durable ordered capture batches with explicit cancellation;
- active receipt history, resume, retry from stored bytes, and unfinished-scan deletion;
- private original and derived evidence with short-lived signed retrieval;
- field evidence regions and owner review;
- revision-guarded item editing, removal, and confirmation;
- locked duplicate recheck, paginated review responses, candidate hashes, and `Save anyway` acknowledgement;
- exact-image matching based on canonical ordered original bytes;
- shared business-profile transaction gates across receipt, manual-entry, and CSV duplicate writes;
- durable staged evidence purge with leases, checkpoints, retry, and terminal handling;
- Android Standard, manual, and Long capture support with bounded waits and recovery;
- mobile and web review flows that preserve edits through recoverable failures.

### Four P1 review findings fixed locally

#### P1-1: deletion versus provider dispatch race

The final provider submission now serializes against deletion by locking the same `ReceiptScan` row and rechecking the state immediately before submission. The check requires:

- the active business profile;
- `Pending` and `Processing` scan state;
- no evidence-deletion request;
- no `DELETE_SCAN` purge;
- a non-null, exact worker ID and attempt;
- a fresh worker heartbeat and lease.

Deletion-first and provider-first PostgreSQL lock-contention tests use `pg_blocking_pids` to prove real serialization. A stale `RESERVED` dispatch releases resource and business budget exactly once only when no fresh eligible scan remains. A stale `SUBMITTED` dispatch becomes `AMBIGUOUS` without releasing possibly billable units. The worker runs the reconciler on each pass.

Key files:

- [receiptProviderDispatch.service.ts](../../backend/src/services/receiptProviderDispatch.service.ts)
- [receiptPurge.service.ts](../../backend/src/services/receiptPurge.service.ts)
- [receipt scan worker](../../backend/src/services/receiptScan/worker.ts)
- [worker entrypoint](../../backend/src/worker.ts)
- [receiptProviderDispatch.test.ts](../../backend/tests/integration/receiptProviderDispatch.test.ts)

#### P1-2: purge crash on the final attempt

Stale `PROCESSING` jobs at attempt ten and queued `PENDING` or `RETRY` jobs at the attempt ceiling now become `FAILED` with `PURGE_ATTEMPTS_EXHAUSTED`. Their lease is cleared and readiness reports them. A genuinely fresh tenth-attempt lease remains active.

Key files:

- [receiptPurge.service.ts](../../backend/src/services/receiptPurge.service.ts)
- [phase2ReceiptAcceptance.test.ts](../../backend/tests/integration/phase2ReceiptAcceptance.test.ts)

#### P1-3: mobile `Choose another receipt` reset

Single, batch, and resumed foreign-currency replacement paths now use one complete reset. It clears visible scan state and the less visible operation locks, upload identities, batch and child references, replay state, queue and recovery state, issue/evidence state, camera state, form state, and local files. Regression coverage proves the next upload receives a fresh identity without stale batch binding.

Key files:

- [ScanReceiptScreen.tsx](../../mobile/src/screens/records/ScanReceiptScreen.tsx)
- [receiptImportFlow.test.tsx](../../mobile/tests/render/receiptImportFlow.test.tsx)

#### P1-4: same-name migration drift

A new forward-only reconciliation migration handles exactly two supported source histories:

- current source migration checksum `8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b`, which takes a verification-only path;
- known legacy checksum `a0e4f79275cbb0e975f16d4675776ecf954395eaa6dd5900f15cd3f73030ca5b`, repaired only after the catalog matches the migration's precondition inventory. That inventory was reconstructed in `backend/tests/fixtures/phase2-legacy-scanner.sql`; the migration text with that checksum exists in no git object.

The migration SQL aborts and rolls back on unknown checksums, partial state, malformed constraints, weakened predicates, altered collations, and altered operator classes; the harness exercises only the weakened legacy CHECK, altered predicate, collation, and operator-class cases (see the acceptance checklist). Verification covers exact CHECK definitions, foreign-key mappings and actions, nineteen index definitions, target tables, btree method, primary and unique flags, validity and readiness, key order and options, predicates, null semantics, no unexpected INCLUDE columns, namespace-qualified collations and operator classes, RLS, policies, and direct grants.

The startup guard now fails closed when the migration directory itself is missing or unreadable and for reachable ledger or catalog failures. It checks the migrations that this checkout recognizes, but it intentionally ignores database-ahead historical ledger rows with no corresponding expected checksum; a subdirectory without `migration.sql` is also excluded from the expected set. It may return an unknown transient state only for classified Prisma database-availability errors `P1001`, `P1002`, `P1008`, or `P1017`.

Frozen reconciliation SQL SHA-256:

`d2f4805aef790c484fd1878edecfcba0a39b93529cb8d9b0879469e2aaa99d46`

Fresh and supported-legacy databases produced an identical 235-fact canonical catalog and security digest on the P1 snapshot:

`5b9fbff1a7f8d9aeb3ca15ebdf484e5078d81ec4541cde9fc716ced4a45e39d3`

After the P2-5 migration added `lastActivityAt` and its index, both paths produce an identical 237-fact catalog:

`eb4d357dd91fe66da9f52557dc500b9b6859ed5da9a8f48deedbea886d9c8c50`

Key files:

- [reconciliation migration](../../backend/prisma/migrations/20260913230000_reconcile_phase2_scanner_migration_drift/migration.sql)
- [migrationGuard.ts](../../backend/src/config/migrationGuard.ts)
- [verification harness](../../backend/scripts/migrate-workflow/verify-phase2-reconciliation.ts)
- [legacy fixture](../../backend/tests/fixtures/phase2-legacy-scanner.sql)
- [migrationGuard.test.ts](../../backend/tests/unit/migrationGuard.test.ts)
- [CI workflow](../../.github/workflows/ci.yml)

### Policy-v1 evaluator tooling

The worktree also contains the external policy-v1 evaluator, validator, report generator, statistics, focused configuration, and tests under [backend/tests/receipt-scanner-evaluation](../../backend/tests/receipt-scanner-evaluation). Its isolated recorded gate passed 75 of 75 tests with focused type-check and lint.

This tooling does not perform OCR, inspect images for scoring, prove that reviewers are human, or close device, Storage, ownership, provider, or operational gates. It validates caller-prepared sealed inputs and aggregates scored observations.

## Verification already recorded

| Gate | Recorded result | Scope warning |
| --- | --- | --- |
| Focused backend P1 | 90 of 90 passed across provider dispatch, Phase 2 receipt acceptance, and migration guard | Final-snapshot focused evidence |
| Focused mobile receipt flow | 48 of 48 passed | Render-level regression evidence, not physical-device evidence |
| Full mobile | 97 files and 1,056 tests passed on Node 22 | Physical Android remains open |
| Reconciliation harness | Fresh and legacy paths match; malformed CHECK, predicate, collation, and operator-class variants fail closed | Disposable local PostgreSQL only |
| Migration replay | All 44 migrations applied on fresh PostgreSQL 16; Prisma status current; schema diff clean | Disposable local PostgreSQL only |
| Startup guard | `status: ok` with no pending, failed, checksum mismatch, or schema issue | Disposable local PostgreSQL only |
| Full backend | 151 files, 2,245 passed, 1 skipped, 2,246 total on Node 22.23.2 | See the conservative replay note below |
| Backend type-check and lint | Type-check passed; lint exited 0 with 8 unrelated existing warnings | Warnings remain visible |
| Mobile type-check and lint | Type-check passed; lint and token check exited 0 with 12 existing Fast Refresh warnings | Warnings remain visible |
| Earlier web gate | 83 files and 726 unit/component tests, 18 Chromium end-to-end tests, type-check, lint, build, and bundle budget passed | Predates the open web P2 changes |

The final disposable full-suite database had zero remaining sessions before it was removed. The reconciliation harness reported removing the temporary containers it created. Two other containers, `finsight-test-db` and `finsight-phase2-db-audit`, are present at this handoff and must not be assumed disposable or removed by the next AI.

Conservative replay note, closed on 14 September: the complete backend suite was rerun on the exact P1 snapshot (tracked-diff SHA-256 `08d93d04cba4652d04a5af4f7285c8d16dafc038cc5a5c6c5a0bbf43474ba7ed`) with the frozen reconciliation migration unchanged and passed with identical counts, 151 files, 2,245 passed, 1 skipped. The P1 snapshot is complete-suite green.

An independent read-only reviewer found no remaining P0 or P1 issue in the P1 delta. The eight P2 findings were closed separately on 14 September; see the continuation log.

## Hosted migration incidents and hard safety boundary

There were two separate unauthorized hosted migration incidents in the recovered plan history. Neither authorizes another hosted operation.

### Earlier Phase 1 incident

During Phase 1 local verification, Prisma inherited `backend/.env` and applied `20260913075700_provider_consent_budget_dispatch_and_purge` to the configured hosted database. It added schema objects and revoked privileges but did not delete or rewrite application rows. The work stopped without a rollback or migration rewrite. The follow-up read-only record is in [Phase 1 implementation evidence](../phase-1/IMPLEMENTATION-EVIDENCE.md#hosted-migration-incident-and-verification). This is separate from the Phase 2 incident below.

### Phase 2 incident

Detected on 13 September 2026 at 18:53 PHT, a Phase 2 migration validation pinned `DATABASE_URL` to a disposable database but accidentally inherited the repository's hosted `DIRECT_URL`. Within this Phase 2 incident, Prisma applied only this largely additive, non-row-destructive migration to hosted Supabase without authorization:

- `20260913100918_receipt_capture_batches_and_scan_revision`
- SHA-256 `8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b`

The migration added Phase 2 objects and fields and replaced two indexes. It contained no row deletion, table or column drop, or application-data rewrite. No destructive rollback or compensating write was attempted because rollback would itself create destructive risk. The incident did not deploy the later migrations. Separately and deliberately, the owner deployed the `CANCELLED` and source-image-hash migrations from an interactive shell between 21:28 and 21:33 PHT on 13 September, and the reconciliation and `20260914010610` migrations at about 02:07 on 14 September, both times to restore the development API. The hosted ledger is expected to hold all 45 migrations, unverified by an authorized check. See the incident record's final section.

At approximately 23:02 to 23:04 PHT on 13 September 2026, three later verification entrypoints also inherited the hosted connection:

1. a Phase 2 schema-shape catalog query;
2. the combined migration-ledger and schema-shape guard;
3. a `SELECT` of the `20260913100918` ledger row.

Those three probes were read-only. They made no hosted write or migration, queried no user or receipt data, and emitted no credentials. They do not count as authorized hosted verification.

Rules for every next agent:

- Do not access hosted Supabase without explicit owner authorization for the exact operation.
- Do not infer authorization from this handoff, earlier generic approval, or a request to continue local work.
- Do not roll back either hosted incident migration.
- Do not edit any already-applied migration or its ledger row.
- For every local database command, set both `DATABASE_URL` and `DIRECT_URL` to the same explicit disposable local PostgreSQL database.
- Do not rely on `.env`, a partially overridden environment, or a migration command's apparent target.
- Do not print, inspect, or copy hosted credential values.
- Treat hosted state as unknown and unaccepted until an authorized verification is performed.

## Current repository state

At handoff preparation:

- at handoff time, branch and remote branch both pointed to `28394be`; they now point to `aede3a5`, and `36223ae` holds the P1 and P2 work;
- at handoff time, the post-commit P1 fixes were modified or untracked working-tree files; they are now committed;
- the worktree contains many other untracked files from broader FinSight work;
- the final reconciliation migration, the 14 September `20260914010610_receipt_scan_last_activity` migration, the policy-v1 evaluator files, the P2 implementation and test files listed in the continuation log, and the Phase 2 review documents were untracked at handoff time and are now committed in `36223ae`;
- unrelated files must not be swept into a commit.

Before editing, run `git status --short --branch` and inspect the exact diff for the path you own. Never use a broad reset, checkout, clean, recursive deletion, or blanket `git add .`.

### Known stale wording in the earlier Phase 2 documents

At handoff time the PR review, acceptance checklist, and implementation evidence called the reconciliation verifier a `committed` harness and used prospective wording about a final commit and hosted CI while those artifacts were still untracked. The commit (`36223ae`) and the hosted CI run on `aede3a5` have since happened, and on 14 September the wording in those documents was corrected to state what is committed, what CI ran on, and exactly which reconciliation branches the harness exercises.

## Markdown inventory for the recovered plan sequence

This inventory is scoped to the cost-first plan and its Phase 0, Phase 1, and Phase 2 execution sequence. It is based on the branch history and current worktree, not on the presence of unrelated untracked Markdown files.

### Plan and Phase 0 records

The Phase 0 close commit `e81386f` first added these paths to the current branch history:

1. [COST-FIRST-CORE-FEATURES-IMPLEMENTATION-PLAN.md](../COST-FIRST-CORE-FEATURES-IMPLEMENTATION-PLAN.md), the original full program plan.
2. [database-connection-incident-2026-09-11.md](../database-connection-incident-2026-09-11.md), the local database connection-path incident and recovery record.
3. [mobile-apk-tailscale-setup.md](../mobile-apk-tailscale-setup.md), device build and connectivity guidance.
4. [CORPUS-DATA-DICTIONARY.md](../phase-0/CORPUS-DATA-DICTIONARY.md), private corpus field definitions.
5. [P0-CLOSE-01-EVIDENCE.md](../phase-0/P0-CLOSE-01-EVIDENCE.md), Phase 0 implementation-close evidence.
6. [PHASE-1-BACKLOG.md](../phase-0/PHASE-1-BACKLOG.md), the dependency-ordered Phase 1 tickets.
7. [phase-0/README.md](../phase-0/README.md), the Phase 0 status and remaining external gates.

The same commit reintroduced or materially updated these paths, which existed in older repository history and should not be described as first-authored by this continuation:

8. [deployment-runbook.md](../deployment-runbook.md).
9. [internal-acceptance-checklist.md](../internal-acceptance-checklist.md).
10. [mobile-camera-verification-checklist.md](../mobile-camera-verification-checklist.md).

### Phase 1 records

Commit `204ca03` added:

11. [phase-1/IMPLEMENTATION-EVIDENCE.md](../phase-1/IMPLEMENTATION-EVIDENCE.md).
12. [phase-1/P1-OPS-03-EVIDENCE.md](../phase-1/P1-OPS-03-EVIDENCE.md).

That commit also materially updated the already listed [deployment-runbook.md](../deployment-runbook.md) and [PHASE-1-BACKLOG.md](../phase-0/PHASE-1-BACKLOG.md).

### Phase 2 records

Commit `28394be` added the first two Phase 2 records. The next three are current follow-up worktree files:

13. [HOSTED-MIGRATION-INCIDENT.md](./HOSTED-MIGRATION-INCIDENT.md), added in `28394be` and updated during P1 hardening.
14. [IMPLEMENTATION-EVIDENCE.md](./IMPLEMENTATION-EVIDENCE.md), added in `28394be` and updated during P1 hardening.
15. [PHASE-2-ACCEPTANCE-CHECKLIST.md](./PHASE-2-ACCEPTANCE-CHECKLIST.md), created during review and acceptance-tooling work; committed in `36223ae`.
16. [PR-1-REVIEW-2026-09-13.md](./PR-1-REVIEW-2026-09-13.md), created during the independent Phase 2 review; committed in `36223ae`.
17. [PHASE-2-HANDOFF-2026-09-14.md](./PHASE-2-HANDOFF-2026-09-14.md), this continuation handoff; committed in `36223ae`.

### Materially updated but not created in this sequence

- [backend/tests/receipt-scanner-evaluation/README.md](../../backend/tests/receipt-scanner-evaluation/README.md) was expanded for policy-v1 evaluator work.
- [skill-observations/log.md](../../skill-observations/log.md) accumulated workflow observations.

Git status contains many other untracked Markdown files from earlier or separate FinSight work. Their presence alone does not establish that this plan created them.

## Continuation log, 14 September 2026

Executed by the orchestrator with the specialist agents named in `AGENTS.md`; every implementation report was verified against the actual diff and a re-run of its tests before acceptance. Nothing was committed, pushed, or deployed during these stages (the commit came later; see the status update at the top); hosted Supabase was not accessed by any agent.

1. **Stage 0.** Preflight matched this document. Node 22.23.2 was installed through nvm alongside the existing v24.18.0, and the nvm default alias was pinned to `24.18.0` so the owner's shells are unchanged. Provider dispatch confirmed disabled with zero network calls.
2. **Stage 0A.** Passed on the exact P1 snapshot (see the replay note above).
3. **Stage 1.** Four lanes in parallel, each with its own disposable database: Lane A backend-api (P2-6, P2-7); Lane B database then backend-api (P2-5 schema, P2-8, P2-5 sweep); Lane C mobile (P2-9); Lane D web-frontend (P2-10, P2-11, P2-12). Each started from a failing reproducing test. The per-finding changes and evidence are tabulated in the [PR review](./PR-1-REVIEW-2026-09-13.md#p2-resolution-14-september-2026).
4. **qa-security review** of the full range: eight verdicts, all verified; one P3 (cursor ids past int4 reached Prisma as a 500) fixed in the same session in both the new duplicate-candidate cursor and the pre-existing history cursor; nine adversarial tests added.
5. **Stage 2.** Complete gates on the final snapshot: backend 156 files / 2,305 passed / 1 skipped, mobile 98 / 1,064, web 85 / 745 plus 18 Chromium end-to-end, policy-v1 75, fresh replay of 45 migrations with clean status, diff, and guard, reconciliation harness 237 facts, type-check, lint, build, bundle budget, type parity, ops smoke drills, and `docker compose config`. One e2e selector written by Lane D omitted a receipt ordinal and was corrected before the final 18-of-18 run. Full details are in the [acceptance checklist](./PHASE-2-ACCEPTANCE-CHECKLIST.md#p2-snapshot-verification-14-september-2026).
6. **Stage 3.** The PR review, acceptance checklist, implementation evidence, hosted incident record, and this handoff were reconciled: counts, the 237-fact digest, the then-untracked status of the harness and migrations, and the owner-performed hosted deployment agreed across all five at that time (the commit came later).
7. **Independent full-range review (PR 2).** A 21-finder, adversarially verified read-only review of `204ca03..28394be` plus the worktree confirmed 2 P1, 24 P2 (about 15 distinct), and 41 P3 findings; 4 were refuted. Both P1s (the `npm test` `DIRECT_URL` guard gap behind the hosted incidents; batch resume dead-ending after an accepted child's files were released) and eleven P2 clusters were fixed in the same session with reproducing tests, including three regressions introduced by the P1 and P2 fixes themselves (splits of one receipt flagging each other, the purge stage ceiling, the discovery cap). Four P2 items needed an owner disposition; the dispositions are recorded in [PR-2-REVIEW-2026-09-14.md](./PR-2-REVIEW-2026-09-14.md). The complete gates were rerun afterwards; see the acceptance checklist's post-review section.
8. **Round 3 (after `aede3a5`).** The verified P3 backlog and the follow-ups from the provider work were run as seven owner lanes plus a qa-security review: purge failure-path contract with re-drive, receipt-core P3s, stored provider outcome with replay, unreconciled-items merge policy, consent source and `policyBlocked`, grace migration, guard sentinels, web and mobile P3s, parity tripwire and harness hygiene, docs audit. 48 migrations. Gates: backend 163 / 2,396, web 86 / 770 + 18 e2e, mobile 98 / 1,090. Recorded in the PR 2 review's round 3 section; committed as the next commit after `aede3a5`.
9. **Round 4 (after `c3e4484`).** Type-name parity closed on both clients (tripwire drift lists empty), post-commit side effects isolated on both write paths, replay re-checks consent and scan state, purge expiry edge closed, grant sentinels extended to the provider tables, harness now exercises six rejections. Gates: backend 163 / 2,401, web 86 / 772 + 18 e2e, mobile 98 / 1,092. Recorded in the PR 2 review's round 4 section.
10. **Round 5 (after `ef6dcf5`).** Update-path post-commit isolation, the ninth harness scenario (seven rejections), shape-level type alignment on both clients. Gates: backend 163 / 2,402, web 86 / 772 + 18 e2e, mobile 98 / 1,092. The repository backlog from PR 1 and PR 2 is now empty; only external gates and the PR #1 merge decision remain.

New files (P2 lanes): `backend/prisma/migrations/20260914010610_receipt_scan_last_activity/`, `backend/src/services/receiptScan/confirmMode.ts`, `backend/tests/integration/{receiptAbandonedScanSweep,receiptConfirmPostCommit,receiptConfirmModes,receiptDuplicateCandidateBounds}.test.ts`, `backend/tests/contract/receiptConfirmModes.test.ts`, `mobile/tests/render/receiptEvidenceViewerLoading.test.tsx`, `web/src/pages/scanReceipt/{recoveryHistory.ts,recoveryHistory.test.ts}`, `web/src/pages/ScanReceipt.recoveryHistory.test.tsx`. Modified (P2 lanes): `backend/prisma/schema.prisma`, `backend/src/{worker.ts,controllers/receiptScan.controller.ts,services/receiptDuplicate.service.ts,services/receiptPurge.service.ts,services/receiptScan/{history,queue,reconciliation,types,worker}.ts}`, `mobile/src/screens/records/scanReceipt/ReceiptEvidenceViewer.tsx`, `web/src/pages/{ScanReceipt.tsx,ScanReceipt.test.tsx}`, `web/e2e/phase2-receipt-review.spec.ts`. PR 2 fixes added `backend/tests/integration/{receiptSplitDuplicates,receiptWorkerAttemptCeiling}.test.ts` and `docs/phase-2/PR-2-REVIEW-2026-09-14.md`, and modified `backend/tests/setup/globalSetup.ts`, `backend/src/controllers/receiptCaptureBatch.controller.ts`, `backend/src/services/expenseRecord.service.ts`, `backend/src/config/migrationGuard.ts`, `backend/tests/integration/{phase2ReceiptAcceptance,receiptDuplicateCandidateBounds}.test.ts`, `mobile/src/screens/records/ScanReceiptScreen.tsx`, `mobile/src/screens/records/scanReceipt/ActiveReceiptQueue.tsx`, `mobile/tests/render/receiptImportFlow.test.tsx`, and `web/src/pages/ScanReceipt.tsx` plus its test.

Open items: the four P2 dispositions and the P3 backlog in the PR 2 review, which subsume the earlier notes (manual-entry post-commit isolation, no-match discovery at scale, and the P2-5 backfill's unrecorded owner views, the last of which is now the first open P2 disposition). The three disposable containers created for this work, `finsight-phase2-handoff-20260914`, `finsight-phase2-laneB-20260914`, and `finsight-phase2-db-20260914`, were removed after the final gates with zero remaining sessions; `finsight-test-db` and `finsight-phase2-db-audit` were not touched.

## What remained at handoff: eight P2 findings, all fixed on 14 September

### P2-5: seven-day abandoned-scan cleanup

**Owner chain:** database -> backend-api -> qa-security

**Problem:** `ABANDONED_SCAN` exists as a purge reason, but there is no complete seven-day lifecycle. `ReceiptScan` lacks the required indexed last-activity state, and the worker does not schedule an abandoned-scan sweep.

**Required work:**

1. Confirm the exact activity events that refresh the clock, including owner and worker activity.
2. Add forward-only schema and index support through the database owner.
3. Update the timestamp through the existing receipt paths without weakening tenant scoping or lease correctness.
4. Add a bounded worker sweep that enqueues an idempotent abandoned-scan purge.
5. Protect confirmed, actively leased, deletion-in-progress, and recently active scans according to the final state contract.
6. Test immediately before, at, and after the seven-day boundary, repeated sweeps, concurrent activity, and cross-profile isolation.

**Alternative:** record an explicit approved scope decision. Silence or omission is not a disposition because the frozen MVP plan requires the seven-day clock.

### P2-6: error response after the financial commit succeeds

**Owner chain:** backend-api -> qa-security for an isolated noncritical-effect correction. If the selected design introduces a transactional outbox or changes analysis queueing, use database -> backend-api and, where the analysis boundary changes, ai-ocr-analytics -> qa-security.

**Problem:** receipt confirmation commits financial records before deferred notification, analysis, and feedback effects finish. A later side-effect failure can return HTTP 500 even though the records already exist, encouraging a dangerous retry and an inaccurate client state.

**Required work:**

1. Inventory every post-commit effect and label it critical or noncritical.
2. Use the repository's established durable pattern if a transactional outbox already exists; otherwise isolate noncritical post-commit failures and return the committed result with observable retry or warning behavior.
3. Preserve confirmation idempotency and the duplicate lock/recheck.
4. Add failure injection separately for notification creation, analysis queueing, and confirmation feedback.
5. Prove a successful financial commit never becomes an ambiguous HTTP 500 because a noncritical effect failed.
6. Prove retries cannot create another financial record.

Do not solve this by moving financial writes outside their existing atomic transaction.

### P2-7: mixed confirmation payload modes

**Owner chain:** backend-api -> affected clients if the public contract changes -> qa-security

**Problem:** `splits`, `itemAssignments`, `additionalItems`, and `reconciliation` are independently optional. The service selects one path and can silently ignore valid fields belonging to another mode.

**Required work:**

1. Define the accepted confirmation modes as an exact discriminated union or XOR contract.
2. Reject mixed modes at the controller boundary with a stable owner-safe validation response.
3. Keep shared fields explicit rather than relying on accidental optionality.
4. Review web and mobile payload builders against the final contract.
5. Add controller, service, and contract tests for every valid mode, all mixed combinations, missing required members, and unknown members.

No accepted request may contain silently ignored financial input.

### P2-8: unbounded duplicate-candidate handling

**Owner chain:** database, if query or index support changes -> backend-api -> qa-security

**Problem:** candidate discovery uses unbounded reads, persistence performs repeated linear searches and sequential writes, and the list endpoint loads all candidates before slicing. This work can occur inside bounded OCR or confirmation transactions.

**Required work:**

1. Define and document an oversized candidate-set limit and cursor contract.
2. Move list pagination into the database query rather than slicing an unbounded in-memory set.
3. Map existing candidates by stable key and bulk-write safe changes where the repository pattern supports it.
4. Keep all reads and writes scoped to the authenticated active business profile.
5. Minimize transaction duration without weakening the locked confirmation recheck.
6. Test multiple pages, exact cursor boundaries, deterministic order, oversized data, repeated persistence, concurrency, and another profile's candidates.
7. Measure or explain the query plan and indexes used for the bounded path.

### P2-9: mobile evidence loading race

**Owner chain:** mobile -> qa-security

**Problem:** `ReceiptEvidenceViewer` shares one loading boolean across evidence keys. When a request is made inactive during a page switch, cleanup can leave the flag set. Returning to a cached or failed key can leave a permanent loading veil.

**Required work:**

1. Track loading by evidence key or clear it for every key transition.
2. Prevent an older request from overwriting state for the current key.
3. Preserve cached-image and recoverable-error behavior.
4. Add a deferred-request test that switches away and back before the first request settles.
5. Cover success, failure, cached return, rapid page changes, and unmount.

This repository test does not replace physical-device evidence.

### P2-10: web recovery history stops after the first page

**Owner chain:** web-frontend -> qa-security

**Problem:** the web scan page requests twenty active scans and discards `nextCursor`. Older unfinished scans cannot be resumed or deleted through the recovery interface.

**Required work:**

1. Implement cursor pagination or a clear load-more interaction using the existing API contract.
2. Preserve deterministic ordering and prevent duplicates when pages overlap or history refreshes.
3. Keep loading, empty, partial, error, retry, and end-of-list states accessible.
4. Test at least two result pages, cursor forwarding, repeated load attempts, refresh, and profile change.

### P2-11: newly abandoned web scans are hidden until reload

**Owner chain:** web-frontend -> qa-security

**Problem:** `handleRescan` clears the current scan and batch references but does not refresh active history. The server-side pending scan exists but is absent from the recovery UI until the route remounts.

**Required work:**

1. Refresh or reconcile history after the scan is abandoned.
2. Keep the abandoned scan visible or provide a clear local recovery entry while refresh is pending.
3. If refresh fails, retain an explicit retry path rather than silently losing access.
4. Test success, refresh failure, retry, pagination interaction, and profile change.

Coordinate this with P2-10 so pagination state and refresh behavior are designed once.

### P2-12: ambiguous accessible names in recovery rows

**Owner chain:** web-frontend -> qa-security

**Problem:** repeated buttons named only `Review result` or `Delete scan` do not identify their receipt row during screen-reader button navigation.

**Required work:**

1. Give each repeated action a receipt-specific accessible name or description using safe visible context.
2. Do not expose receipt data that the row does not already present to that authenticated owner.
3. Keep visible labels concise while making the accessibility tree unambiguous.
4. Add a multiple-row assertion that queries actions by their unique accessible names or descriptions.

## Detailed next execution plan

### Stage 0: safe bootstrap and source audit

1. Read the source documents listed above.
2. Read the affected implementation and tests before proposing a rewrite.
3. Record `git status --short --branch` and the exact changed paths.
4. Confirm Node 22 is active.
5. Verify the frozen reconciliation migration hash before touching database work.
6. Confirm provider dispatch remains disabled by configuration. Do not enable or invoke a live provider.
7. Treat every database target as unsafe until both connection variables are explicitly set to the same disposable local database.
8. Preserve unrelated changes and assign one owner per path.

### Stage 0A: close the final P1 full-suite evidence gap (done 14 September)

Before changing P2 code, run the complete backend suite on a fresh disposable PostgreSQL 16 database with the frozen reconciliation migration unchanged. Also rerun migration status, the Prisma schema diff, and the live startup guard. Record the exact commit, worktree diff identity, Node version, migration count, test count, skip count, and cleanup result.

If this gate fails, treat the failure as P0 or P1 triage before starting P2. If it passes, record it as baseline evidence for the exact P1 snapshot. The post-P2 final gate must still run again because the code will have changed.

### Stage 1: implement the P2 lanes (done 14 September)

The lanes can run in parallel after the orchestrator confirms dependencies:

- **Lane A, backend correctness:** P2-6 and P2-7.
- **Lane B, database and backend lifecycle/performance:** P2-5 and P2-8, with the database owner completing any schema or index work before backend integration.
- **Lane C, mobile:** P2-9.
- **Lane D, web:** P2-10, P2-11, and P2-12 as one coherent recovery-history update.

For each lane:

1. Reproduce or encode the finding in a failing focused test.
2. Implement the smallest change that satisfies the final contract.
3. Run the focused tests, type-check, and lint for the owned area.
4. Re-read the diff for ownership isolation, idempotency, accessibility, and error semantics.
5. Report using the `AGENTS.md` task template.
6. Have qa-security review the result and add cross-boundary or adversarial coverage.

Do not mark the checklist item complete from an implementation report alone. The orchestrator must verify the diff and test output.

### Stage 2: integration and fresh-database verification (done 14 September, except hosted CI)

After all P2 lanes are integrated:

1. Re-run the focused P1 suites to detect regression.
2. Run all affected P2 suites.
3. Run complete backend, web, and mobile suites under Node 22.
4. Run backend, web, and mobile type-check and lint.
5. Run the web production build, bundle budget, and Chromium end-to-end suite.
6. Run the policy-v1 evaluator unit suite, focused type-check, and focused lint.
7. Replay all migrations on fresh disposable PostgreSQL 16.
8. Run the fresh and legacy reconciliation harness.
9. Verify Prisma migration status, database-to-schema diff, and live migration guard.
10. Confirm both database URLs were pinned locally for every database-capable command.
11. Confirm no disposable database sessions or test containers remain.
12. Run `git diff --check` and inspect `git status` for private data or unrelated staging.
13. Reproduce the applicable jobs and commands from [.github/workflows/ci.yml](../../.github/workflows/ci.yml) locally where the required tooling is available. The workflow has only `push` and `pull_request` triggers, so hosted CI belongs in Stage 8 after commit or push authorization.
14. If native mobile code changes, separately repeat Android Kotlin compilation and instrumentation APK assembly using the native scanner instructions. This is not currently a CI workflow step and does not replace physical-device execution.

The complete current CI surface includes shared client-type parity, provider and queue status/readiness, operational smoke drills, ML-worker tests and dependency checks, Docker Compose and nginx validation, upload-envelope and orphan-cleanup drills, API and worker signal/readiness checks, production API and worker image builds, packaged network-disabled OCR and missing-language refusal, and production dependency assertions. Keep any platform-specific skipped or externally blocked execution visible.

If P2-5 or P2-8 adds a migration, use a new forward-only migration. Never modify the four existing Phase 2 migration files.

### Stage 3: new review and documentation reconciliation (qa-security review and documentation done 14 September; an independent read-only review of the full range is still open)

1. Review the full changed range, not only each lane in isolation.
2. Confirm no P0 or P1 issue was introduced and every P2 item has either verified evidence or an explicit approved disposition.
3. Update the PR review, acceptance checklist, implementation evidence, and this handoff so their counts, hashes, and status agree.
4. Keep external gates unchecked unless their required evidence was actually collected.
5. Run a final source and documentation drift scan.

### Stage 4: prepare the governed private corpus and evaluator contract

This stage requires two real human custodians and approved private storage outside the Git worktree.

1. Use policy ID `finsight-core-evidence-gates-v1`.
2. Verify policy SHA-256 `4368086c7ef0ae38be67d7c510c91b7b8cc37fb383a179e6ab543cfb2039650f`.
3. Keep all policy-pinned thresholds, the data dictionary, and header-only templates unchanged.
4. Collect at least thirty distinct consented-owner receipts, at least five in each frozen cohort, at least ten eligible non-receipts, at least ten known duplicate pairs, and at least twenty known non-duplicate pairs. Keep each vendor template at or below twenty percent of distinct eligible receipt IDs.
5. Record consent version, permitted uses, provider list, retention end, and private references without receipt content in the manifest.
6. Have two distinct human custodians independently prepare and reconcile the ground truth.
7. Prepare draft intake, pair labels, artifact map, ground-truth bundle, source files, predeclared trial IDs, declared run context, and unused output locations outside the repository. Do not prepare or open scored results yet.
8. Use opaque IDs and references. Keep receipt content, vendor values, amounts, private paths, URLs, and Storage references out of scored results and aggregate reports.
9. Resolve the policy-v1 contract gap before the acceptance run. The current scored-results contract cannot represent every required cohort and capture-mode split, and recapture robustness has no versioned frame or thresholds. Add and freeze a versioned contract for mandatory missing evidence, or record an explicit authorized policy disposition. An unresolved mandatory `NOT_MEASURED` family remains a blocker.
10. Do not freeze the final artifact bundle or open model/provider results yet. Complete the device policy and eligible physical acquisition in Stage 5, then perform the final seal and evaluation in Stage 7.

The private evaluator command and exact input contracts are in the acceptance checklist. Do not use the legacy tracked evaluator for private data because it reads and overwrites tracked fixtures.

### Stage 5: physical Android acceptance

This stage cannot be completed by source review, an emulator, or a built instrumentation APK.

1. Select the minimum supported API/RAM-class device and a mainstream target.
2. Record model, OS/API, camera output, RAM, app memory class, build type, and starting thermal state.
3. Freeze a numeric peak-PSS ceiling for each device in a versioned policy amendment before the first run. No physical run is eligible while that ceiling is null.
4. Run ten Standard sessions per target.
5. Run five Long sessions per target, each no longer than ninety seconds.
6. Run five background and resume cycles per target.
7. Exercise permission denial and revocation, process recreation, low memory, thermal pressure, torch, rotation and crop, cancellation, and recovery.
8. Exercise TalkBack and large text.
9. Record no OOM, ANR, or thermal shutdown.
10. Verify source, rectified, enhanced, composite labels, page order, batch boundaries, and readable evidence review.

### Stage 6: authorized hosted private-Storage and purge acceptance

This stage requires explicit authorization for the exact hosted project and operations.

1. Classify the hosted project as synthetic/demo-only or real-owner.
2. Obtain explicit authorization before any migration, query, deployment, or configuration change.
3. Establish the migration checksum and schema shape through the approved read-only procedure.
4. Verify hosted table and sequence grants, default ACLs, RLS, and the absence of direct `anon` or `authenticated` application-table access.
5. Verify the private receipt-bucket configuration, MIME and size controls, and Storage policies.
6. Verify backup and restore behavior, quota alerts, cost controls, and applicable billing limits.
7. If the project contains real-owner credentials or data, enable leaked-password protection or an approved equivalent, provision the private owner, close public signup, and complete the applicable Supabase Pro Spend Cap and add-on review.
8. Plan later migration deployment through the reviewed deployment workflow. Do not rewrite or roll back either incident migration.
9. Retrieve source, rectified, and enhanced evidence as the owning active business.
10. Prove another business profile cannot obtain any evidence variant.
11. Verify signed links expire after ten minutes and refresh only after a new authorized request.
12. Delete an unfinished scan and inspect private Storage to confirm every source and derived object is gone after purge. Separately verify through the authorized database path that scan corrections, category provenance, duplicate candidates, and other scan-owned rows were removed.
13. Detach evidence from a confirmed scan and prove the financial record remains while stored evidence is removed.
14. Verify purge retry, lease recovery, checkpoint continuation, and terminal failure behavior.
15. Run the inherited deployed operational drills: authenticated upload abort, API restart, stopped worker and stale-lease recovery, secret rotation, and independent API and worker rollback.
16. Verify the provider kill switch and disabled status produce zero live calls. If provider enablement is ever proposed, keep it blocked until terms, region, retention, calibration, consent, finite budget, billing reconciliation, and explicit owner approval all pass under a separate promotion plan.

A database status alone is not evidence that private Storage was purged.

### Stage 7: seal and run consented real-receipt acceptance

1. Confirm the Stage 4 corpus floors, consents, ground truth, contract decision, and privacy controls are complete.
2. Confirm Stage 5 supplied eligible acquisition evidence under the predeclared device policy and peak-PSS ceilings.
3. Finalize the manifest, pair labels, artifact map, ground-truth bundle, exact private source paths and hashes, independent-trial bindings, denominators, and run context.
4. Freeze and hash those exact bytes before anyone opens model or provider results. Record `sealed_at_utc` before `results_opened_at_utc`.
5. Run local Tesseract after sealing. Policy v1 does not authorize cloud result evaluation.
6. Create the complete scored-results file only after the result-open boundary.
7. Generate a new non-overwriting aggregate report within the sealed review window.
8. Review every measured gate and every `NOT_MEASURED`, failed, or uncalibrated result. A mandatory unresolved family blocks acceptance.

Thirty receipts can support a capstone demonstration and transparent point estimates. They do not support a production accuracy claim.

### Stage 8: final merge and release decision

Only after repository review and all mandatory external evidence:

1. Verify every P2 finding is fixed or has an explicit approved disposition.
2. Verify the physical, hosted Storage, purge, and corpus gates have actual evidence.
3. Confirm cloud/provider dispatch remains disabled unless its separate promotion contract passes.
4. Review the exact intended commit file list and exclude unrelated or private artifacts.
5. Obtain owner authorization for the commit and push.
6. Commit and push the reviewed snapshot.
7. Observe hosted CI on that exact SHA. If a fix changes the SHA, rerun the required gates and CI on the replacement SHA.
8. Obtain separate authorization for merge or deployment when required.
9. Record any remaining unavailable evidence. Never convert unavailable evidence into a pass.

## Safe command guide for the next AI

### Read-only preflight

```bash
cd /home/ken/FinsightV1
git status --short --branch
git diff --check
node --version
sha256sum backend/prisma/migrations/20260913230000_reconcile_phase2_scanner_migration_drift/migration.sql
```

`git diff --check` covers tracked changes only. Review every intended untracked deliverable by exact path. For a new file, `git diff --no-index --check -- /dev/null <exact-file>` should print no whitespace diagnostic; exit status 1 is still expected because the file differs from `/dev/null`. Do not stage broadly just to make untracked files visible to Git's normal diff.

Expected migration hash:

```text
d2f4805aef790c484fd1878edecfcba0a39b93529cb8d9b0879469e2aaa99d46
```

### Node 22 gate

The interactive shell used to prepare this handoff reported Node `v24.18.0`, and Node `22.23.2` was later installed under nvm (see Stage 0 in the continuation log). The project and CI gate use Node 22, and the recorded full backend run used Node `22.23.2`. Activate an approved Node 22 installation or run the gate in CI, then make this guard pass before running any npm, npx, Prisma, Vitest, or TSX command below:

```bash
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) { console.error(`Node 22 required; found ${process.version}`); process.exit(1); }'
```

`nvm use 22` resolves to `v22.23.2` on this machine since Stage 0 (`source ~/.nvm/nvm.sh && nvm use 22`); the nvm default alias is still `24.18.0`, so verify with the guard above in every new shell.

### Database test safety

Do not use port `55432`, database `finsight_test`, or the containers `finsight-test-db` and `finsight-phase2-db-audit` as a new disposable target. Those containers already exist and must be preserved. At handoff time, they occupy ports `55432` and `55433`.

Create a uniquely named local PostgreSQL 16 container and database. The example below used an unused name and port when this document was prepared, but recheck both immediately before running it. If either is now occupied, choose another explicit unique name and port.

```bash
if docker ps -a --format '{{.Names}}' | rg -qx 'finsight-phase2-handoff-20260914'; then
  echo 'Choose a new explicit container name; this one already exists.'
  exit 1
fi
if ss -ltnH '( sport = :55434 )' | rg -q .; then
  echo 'Choose a new explicit local port; 55434 is already in use.'
  exit 1
fi
docker run -d \
  --name finsight-phase2-handoff-20260914 \
  -e POSTGRES_USER=phase2handoff \
  -e POSTGRES_PASSWORD=phase2handoff \
  -e POSTGRES_DB=finsight_test_phase2_handoff_20260914 \
  -p 127.0.0.1:55434:5432 \
  postgres:16-alpine
```

Wait for that exact container to report ready, then set the task-specific URL:

```bash
docker exec finsight-phase2-handoff-20260914 \
  pg_isready -U phase2handoff -d finsight_test_phase2_handoff_20260914
export FINSIGHT_PHASE2_DISPOSABLE_DB_URL='postgresql://phase2handoff:phase2handoff@127.0.0.1:55434/finsight_test_phase2_handoff_20260914'
cd /home/ken/FinsightV1/backend
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npx prisma migrate deploy
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npx prisma migrate status
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npx prisma migrate diff \
  --from-url "$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npx tsx -e 'import { checkMigrationDrift } from "./src/config/migrationGuard"; import { prisma } from "./src/config/prisma"; void (async () => { const result = await checkMigrationDrift(); console.log(JSON.stringify(result)); if (result.status !== "ok") process.exitCode = 1; await prisma.$disconnect(); })();'
```

Never copy a value from `backend/.env`. Both connection variables are mandatory even when a command appears to use only one. Do not run `npm run test:db:down` in the current workspace because it targets the pre-existing `finsight-test-db` container.

### Focused P1 regression

```bash
cd /home/ken/FinsightV1/backend
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npx vitest --config vitest.config.mts run \
  tests/integration/receiptProviderDispatch.test.ts \
  tests/integration/phase2ReceiptAcceptance.test.ts \
  tests/unit/migrationGuard.test.ts
```

```bash
cd /home/ken/FinsightV1/mobile
npx vitest run tests/render/receiptImportFlow.test.tsx
```

### Reconciliation harness

The committed harness creates isolated local PostgreSQL containers, reconstructs fresh and legacy states, runs four adversarial variants (weakened legacy CHECK, altered predicate, collation, operator class), and cleans up its own containers. It bind-mounts only `backend/prisma/migrations` and `backend/tests/fixtures/phase2-legacy-scanner.sql` into the container, read-only, so `backend/.env` is never visible inside it:

```bash
cd /home/ken/FinsightV1/backend
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npm run migrate:verify-phase2-reconciliation
```

### Complete repository gates

```bash
cd /home/ken/FinsightV1/backend
DATABASE_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
DIRECT_URL="$FINSIGHT_PHASE2_DISPOSABLE_DB_URL" \
npm test
npm run typecheck
npm run lint
npm run build
```

```bash
cd /home/ken/FinsightV1/web
npm run typecheck
npm run lint
npm run build
npm run check:bundle-budget
VITE_SUPABASE_URL='https://example.supabase.co' \
VITE_SUPABASE_ANON_KEY='ci-placeholder-anon-key' \
VITE_API_BASE_URL='http://localhost:4000/api/v1' \
npm test
VITE_SUPABASE_URL='https://example.supabase.co' \
VITE_SUPABASE_ANON_KEY='ci-placeholder-anon-key' \
VITE_API_BASE_URL='http://localhost:4000/api/v1' \
CI='1' \
npm run test:e2e
```

Setting `CI=1` prevents Playwright from silently reusing a stale server on port 4173. Ensure the repository's expected Chromium runtime is installed before the end-to-end command, or rely on the CI job that installs it explicitly.

```bash
cd /home/ken/FinsightV1/mobile
npm test
npm run typecheck
npm run lint
```

### Policy-v1 evaluator repository checks

```bash
cd /home/ken/FinsightV1/backend
npm run typecheck:receipt-scanner:policy-v1
npm run test:receipt-scanner:policy-v1
npx oxlint tests/receipt-scanner-evaluation/policy-v1-*.ts \
  tests/receipt-scanner-evaluation/run-policy-v1-evaluation.ts
```

The command that uses populated private inputs is documented in the acceptance checklist and must use absolute paths outside this repository.

### Disposable database cleanup

After all database-capable checks finish, confirm the target name and remove only the exact handoff container created above:

```bash
docker rm -f finsight-phase2-handoff-20260914
```

Re-run `docker ps -a` and confirm the pre-existing `finsight-test-db` and `finsight-phase2-db-audit` containers were not changed.

## Non-negotiable constraints

- Every application query remains scoped to the authenticated user's active business profile.
- RLS remains deny-all on application tables. `anon` and `authenticated` receive no direct table access.
- Durable database-backed rate limiting must not fall back to memory.
- Provider dispatch remains off by default with consent, budget, lease, deletion, and kill-switch gates intact.
- Never rewrite an applied migration or its Prisma ledger row. Add a forward-only migration.
- Never let a database command inherit an unspecified `DIRECT_URL` or `DATABASE_URL`.
- Do not access hosted Supabase without exact, explicit authorization.
- Do not place private receipt data, ground truth, local private paths, credentials, or scored private results in Git.
- Do not claim emulator, render, synthetic, or APK-build evidence as physical-device evidence.
- Do not claim a thirty-receipt capstone corpus proves production accuracy.
- Do not enable cloud OCR from this handoff. Policy v1 accepts local Tesseract only.
- Do not hide warnings, skipped tests, failed gates, `NOT_MEASURED` results, or unavailable evidence.
- Do not clean the dirty worktree or commit unrelated untracked files.
- Mobile camera lifecycle changes always require physical-device disclosure.

## Definition of done

Phase 2 is ready for a merge decision only when all of the following are true:

- all four fixed P1 findings remain green;
- every P2 finding is verified as fixed or has an explicit approved disposition that does not silently weaken the frozen policy;
- complete backend, web, mobile, migration, build, type-check, lint, and relevant end-to-end gates pass on the exact proposed commit;
- a new review finds no unresolved P0 or P1 and reconciles all P2 results;
- the physical Android matrix passes with predeclared device-specific memory ceilings;
- authorized hosted ownership, signed-link, private Storage, migration, and purge checks pass;
- the sealed consented real-receipt report contains no failed mandatory gate;
- no mandatory family remains `NOT_MEASURED` or uncalibrated unless a versioned, explicitly approved policy decision has first removed it from the gate; naming a mandatory evidence gap does not make it pass;
- every remaining nonmandatory, unavailable, or `NOT_MEASURED` item remains named;
- Git contains no private inputs or unrelated staged work;
- hosted CI passes on the exact proposed commit;
- commit, push, merge, or deployment occurs only with owner authorization.

Until then, the accurate status is:

> Phase 2 is a locally hardened review candidate with all four P1 and all eight P2 findings fixed, verified, independently reviewed (PR 2), committed (`36223ae`, `aede3a5`), and green in hosted CI on `aede3a5`, with physical-device, hosted, private-Storage, purge, and consented-corpus acceptance and the PR #1 merge decision still pending.

## Starter prompt for another AI

```text
Continue FinSight Phase 2 in /home/ken/FinsightV1 on branch
feat/phase2-scanner-acceptance. First read AGENTS.md and
docs/phase-2/PHASE-2-HANDOFF-2026-09-14.md, then read the linked PR review,
acceptance checklist, evidence record, and hosted incident.

Preserve the large dirty/untracked worktree. Do not clean, reset, stage all,
commit, push, deploy, or access hosted Supabase. For every database-capable
command, explicitly pin DATABASE_URL and DIRECT_URL to the same verified
disposable local PostgreSQL 16 database. The current shell is Node 24, so
activate and verify Node 22 before npm, npx, Prisma, Vitest, or TSX commands. Preserve the existing
finsight-test-db and finsight-phase2-db-audit containers. Keep provider
dispatch disabled.

The four P1 and eight P2 findings are fixed, verified, and committed
(36223ae, then aede3a5; hosted CI passed on aede3a5; PR #1 is open); read
the status update and continuation log in the handoff. Node 22.23.2 is
installed under nvm (`nvm use 22`). The owner's dispositions for the four
PR 2 P2 items are recorded in docs/phase-2/PR-2-REVIEW-2026-09-14.md. The
remaining work is the P3 backlog in the PR 2 review as later lanes, and the
external acceptance gates. Do not deploy the two outstanding
migrations to hosted Supabase without an explicit owner instruction for that
exact operation. Do not call Phase 2 accepted while physical Android,
authorized hosted Storage/purge, and sealed consented-corpus gates remain
open.

Report each task using the AGENTS.md format and cite actual diff and test
evidence. If any instruction conflicts with current source or newer verified
evidence, stop and reconcile the discrepancy rather than guessing.
```
