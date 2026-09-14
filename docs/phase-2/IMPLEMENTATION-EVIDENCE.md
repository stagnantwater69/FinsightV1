# Phase 2 receipt workflow implementation evidence

**Branch:** `feat/phase2-scanner-acceptance`
**Prepared:** 13 September 2026
**Release status:** Acceptance-blocked candidate; the four P1 and eight P2 findings now have local fixes and coordinated local verification (14 September 2026), committed as `36223ae` and `aede3a5` with hosted CI passing on `aede3a5`, while physical-device evidence, consented-corpus evidence, deployed private-storage checks, and the PR #1 merge decision remain open

The current review verdict is recorded in [PR-1-REVIEW-2026-09-13.md](./PR-1-REVIEW-2026-09-13.md). This implementation record preserves the original build evidence; it is not a merge or release approval. Operational closure is tracked in [PHASE-2-ACCEPTANCE-CHECKLIST.md](./PHASE-2-ACCEPTANCE-CHECKLIST.md).

## Outcome

Phase 2 turns a receipt capture into a recoverable, owner-reviewed workflow:

1. The original image is stored before OCR begins.
2. OCR and categorization run through the existing local-first processing path.
3. Failed processing can be retried from stored bytes without another upload.
4. The owner reviews the source image, extracted fields, items, totals, categories, and possible duplicates.
5. Edits use a scan revision so a stale screen cannot overwrite newer data.
6. Confirmation writes the financial records atomically.
7. Unfinished scans can be deleted; confirmed scans retain their financial audit while their receipt evidence can be detached asynchronously.

For a multi-receipt selection, every child must receive a server-side scan ID before the first review screen opens. Uploads are sequential and idempotent. Once review starts, a browser reload or mobile process restart can recover each accepted child from receipt history.

## Delivered scope

- Durable, ordered receipt-capture batches with explicit `CANCELLED` handling.
- Active receipt history, stored-result resume, whole-scan retry, and unconfirmed-scan deletion.
- Private original and derived page evidence with short-lived signed-link retrieval.
- Source-region evidence for extracted fields.
- Revision-guarded item edit, item removal, and receipt confirmation.
- Locked duplicate recheck at confirmation, paginated candidate review, explicit “save anyway” acknowledgement, and stable candidate-set hashes.
- Exact-image matching based only on canonical ordered original bytes; upload/idempotency metadata uses a separate hash.
- A shared business-profile transaction gate for receipt, manual-entry, and CSV duplicate writes.
- Durable staged evidence purge with retry, leases, checkpoints, and expiry cleanup for terminal purge results.
- Full-resolution Android Standard capture, source-coordinate geometry, bounded capture/read waits, Long/manual modes, interruption recovery, and scanner-cache cleanup.
- Web and mobile review flows that preserve owner edits through recoverable failures.

FinSight still has one human role in this scope: the business owner. Phase 2 does not add staff, bookkeeper, or multi-role workflows. Business-profile scoping remains in place so an owner's businesses cannot read or mutate one another's receipt data.

## Technology and cost posture

The default OCR path remains Tesseract with packaged English language data. It runs locally in the FinSight worker image, works without an OCR-provider network call, and has no per-receipt fee. Optional paid OCR-provider dispatch remains disabled behind consent, budget, and kill-switch controls. Phase 2 does not require a paid provider.

## Database evidence

All database-capable verification commands pin both `DATABASE_URL` and `DIRECT_URL` to a disposable PostgreSQL 16 database. The original database gate, completed before the P1 forward reconciliation, recorded:

- Fresh replay: 43 migrations applied successfully.
- On that fresh database, Prisma migration status was current and the database-to-`schema.prisma` diff was empty.
- `sourceImageHash` constraint probe: accepts `NULL` and 64-character lowercase hexadecimal values; rejects uppercase and 63-character values.

Phase 2 migrations and frozen SHA-256 values:

| Migration | SHA-256 |
|---|---|
| `20260913100918_receipt_capture_batches_and_scan_revision` | `8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b` |
| `20260913192200_receipt_capture_batch_cancelled_status` | `24b9972b0fa9a4a49f537e946986f2f9cdc43d35bafe0530a6716fa864479281` |
| `20260913194745_receipt_scan_source_image_hash` | `d33826adc8864f0d682fe03bc3cafeb099b53d51e353e41296c0d3343a4db4d6` |
| `20260913230000_reconcile_phase2_scanner_migration_drift` | `d2f4805aef790c484fd1878edecfcba0a39b93529cb8d9b0879469e2aaa99d46` |

### Upgrade-path reconciliation

A later review found that an existing disposable local database records `20260913100918_receipt_capture_batches_and_scan_revision` under the earlier checksum `a0e4f79275cbb0e975f16d4675776ecf954395eaa6dd5900f15cd3f73030ca5b`. A read-only database-to-schema diff shows that this database lacks the duplicate table and enums, purge mode, evidence-deletion and semantic-fingerprint fields, history indexes, and other current migration objects. Both Prisma deployment and the application startup guard still treat the migration name as applied. The current tracked file's SHA-256 is `8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b`.

The frozen forward-only migration `20260913230000_reconcile_phase2_scanner_migration_drift` now supports exactly two source histories. A database with the current `8e03ef8f...` checksum takes a verification-only path. A database with the known legacy `a0e4f792...` checksum is repaired only after the migration proves the expected legacy catalog shape. Any unknown checksum, unexpected partial Phase 2 state, or malformed legacy shape fails closed.

Local-only verification replayed both supported paths with `DATABASE_URL` and `DIRECT_URL` pinned to disposable PostgreSQL databases. On the P1 snapshot the fresh and reconciled legacy databases produced the same 235-fact canonical Phase 2 catalog and security digest, `5b9fbff1a7f8d9aeb3ca15ebdf484e5078d81ec4541cde9fc716ced4a45e39d3`; with the P2-5 `lastActivityAt` column and sweep index they produce an identical 237-fact catalog at `eb4d357dd91fe66da9f52557dc500b9b6859ed5da9a8f48deedbea886d9c8c50`. The `migrate:verify-phase2-reconciliation` harness (committed in `36223ae`) rebuilds both catalogs and executes the forward migration. The harness builds eight disposable databases (six until round 4) and proves exactly this: the fresh chain and the reconstructed legacy fixture reach an identical catalog with no Prisma schema difference and a clean startup guard; a legacy database whose `ReceiptScan_batch_link_check` was weakened is rejected with no partial repair objects left behind; and a current-checksum database is rejected when the `ReceiptPurgeJob_active_profile_receipt_key` predicate is altered, when `ReceiptScan_profile_source_image_hash_idx` uses the `bpchar_pattern_ops` operator class, or when that index uses `COLLATE "C"`. Since 14 September (round 4) it also builds two more: a legacy-shaped database whose `20260913100918` ledger row carries a checksum that is neither `8e03ef8f...` nor `a0e4f792...` is rejected by `prisma migrate deploy` with `Unsupported checksum for 20260913100918_receipt_capture_batches_and_scan_revision: <checksum>.`, and a legacy-shaped database where the `ReceiptPurgeMode` enum already exists is rejected with `Unsupported legacy Phase 2 shape: later Phase 2 objects are partially present.`; in both cases the harness asserts that no repair object exists afterwards and that the ledger holds no completed, non-rolled-back row for the reconciliation migration (Prisma leaves an unfinished row). Six rejections are exercised in all. The legacy fixture [`phase2-legacy-scanner.sql`](../../backend/tests/fixtures/phase2-legacy-scanner.sql) (SHA-256 `f63fe18dd045922f33287d4d74663fa7c79555778143c3b9807326c6fcc9b448`) is a reconstruction of the `a0e4f792...` revision's catalog; no git object holds a migration file with that checksum, so the harness proves the migration accepts the reconstructed shape, not the recorded revision itself. The startup guard verifies applied checksums, exact Phase 2 CHECK bodies, foreign-key mappings, primary/unique/secondary index semantics including namespace-qualified collations and operator classes, and deny-all security controls. Only classified transient database unavailability may continue startup without a verdict; missing migration assets and ledger or catalog inspection failures refuse startup. No reconciliation migration or schema repair was deployed to the hosted database.

## Automated verification

The fixes were committed on 14 September 2026 as `36223ae` (P1 and P2 fixes, reconciliation migration, `20260914010610`, harness, legacy fixture, and these documents) and `aede3a5` (provider-first routing and policy consent), both pushed to `finsightv1/feat/phase2-scanner-acceptance`. The hosted CI push run on `aede3a5` passed (run 34799460479). PR #1 against `main` is open; its pull-request run was still in progress when this was audited. Local coordinated-gate evidence, recorded before the commit:

- Backend focused acceptance: 26/26 tests passed.
- Backend affected integration set: 184/184 tests passed.
- Backend complete suite: 150 files, 2,131 tests passed and 1 skipped.
- Web unit/component suite: 83 files, 726 tests passed.
- Web Chromium end-to-end suite: 18/18 tests passed.
- Web type-check, lint, production build, and bundle budget passed; largest JavaScript chunk was 344.1 KiB.
- Mobile on Node 22: 97 files, 1,053 tests passed; type-check and lint passed with no errors.
- Android Kotlin compilation and instrumentation APK assembly passed (109 tasks). No Android device was attached, so the instrumentation APK was not executed.
- ML worker: 13/13 tests passed and `pip check` reported no dependency conflicts.
- Compose parsing, nginx syntax, upload-envelope validation, orphan cleanup, API signal forwarding, and worker-readiness drills passed.
- Production API and worker image builds, image command/entrypoint checks, worker health, network-disabled packaged OCR, missing-language refusal, and API-to-PostgreSQL readiness passed.
- The network-disabled OCR gate invokes Node directly, so the embedded script is executed rather than being detached from standard input by the worker supervisor.
- Production-image assertions confirm that the Prisma CLI, `@prisma/config`, and `deepmerge-ts` are absent while the generated Prisma query engine remains present. The API image is 162,527,162 bytes after pruning the optional CLI peer.

The pruned production dependency tree no longer contains the high-advisory Prisma CLI chain. Three moderate `qs` findings remain through Express 4 and `body-parser`; these stay visible in the non-blocking audit and are not described as a clean security audit. Updating that chain is a separate compatibility task.

After the review tooling was added, its isolated policy-v1 suite passed 75/75 tests; its focused type-check and lint also passed. The backend suite was then replayed against a newly created disposable database using both explicitly pinned connection URLs. All 43 migrations applied and 151 files passed with 2,206 passing tests and 1 skipped test. The database was removed after the run. At that checkpoint, this fresh-chain result did not close the earlier-revision upgrade-path blocker.

Focused P1 regression verification now covers all four review blockers:

- Provider rescue revalidates the scan under a row lock immediately before submission. The check binds a fresh active worker lease, pending and processing state, undeleted evidence, and absence of a delete-scan purge. PostgreSQL lock-contention tests prove both deletion-first and provider-first ordering with `pg_blocking_pids`. A bounded worker reconciler cancels abandoned `RESERVED` dispatches with exact-once budget release and marks stale `SUBMITTED` dispatches `AMBIGUOUS` without releasing potentially billable units.
- Receipt purge recovery terminalizes stale jobs abandoned at the ten-attempt ceiling, reports them through readiness, and leaves a final attempt alone while its lease heartbeat is fresh.
- Mobile's “Choose another receipt” action now uses the complete receipt reset path. Single, batched, and resumed foreign-currency regressions confirm that the next upload receives a new idempotency key and no stale batch binding.
- Migration regression coverage checks exact SQL checksums, the known legacy exception only after the frozen reconciliation completes, and live schema sentinels. Missing sentinels, unknown checksums, and unverifiable catalog state fail closed.

### Current coordinated P1 gate

The root verification run used Node 22.23.2 and a fresh disposable PostgreSQL database with both connection URLs explicitly pinned. It recorded:

- All 44 migrations applied. `prisma migrate status` reported the chain up to date, and the schema diff exited 0 with no difference.
- The live local startup guard returned `{status:ok,pending:[],failed:[],checksumMismatches:[],schemaIssues:[]}`.
- The backend complete suite passed 2,245 tests across 151 files, with 1 intentional skip and 2,246 tests total.
- The mobile complete suite passed 1,056 tests across 97 files.
- Backend and mobile type-checks passed.
- Both lint commands passed. Backend reported 8 existing warnings, and mobile reported 12 existing Fast Refresh warnings; all are outside the P1 changed files.
- The database cleanup check found zero remaining sessions before removing the disposable database.

This coordinated run used only the disposable local database and performed no hosted deployment. It does not replace physical-device verification or consented real-receipt evidence.

### P2 remediation gate, 14 September 2026

Before any P2 code changed, the exact P1 snapshot was replayed in full on a fresh disposable PostgreSQL 16 database with the frozen reconciliation migration unchanged: 151 files, 2,245 passed, 1 skipped, 2,246 total, with the same 44-migration, status, diff, and guard results as above. That closes the conservative replay note from the handoff.

The eight P2 findings were then fixed by their owning agents, each starting from a failing reproducing test, reviewed as one range by qa-security, and verified again on the final snapshot. The per-finding changes and test files are tabulated in the [PR review](./PR-1-REVIEW-2026-09-13.md#p2-resolution-14-september-2026). The final gate recorded, all under Node 22.23.2 with both connection URLs pinned to disposable databases:

- A new forward-only migration, `20260914010610_receipt_scan_last_activity` (SHA-256 `30c6b971f39a835a00e098bf649277aea219e98530caac1fba47c561587e8038`), bringing the chain to 45. Fresh replay applied all 45; `prisma validate` clean; status current; schema diff clean; live guard `ok`.
- Backend complete suite: 156 files, 2,305 passed, 1 skipped, 2,306 total. Type-check, lint (8 pre-existing warnings outside the changed files), and production build passed. Zero remaining database sessions.
- Mobile complete suite: 98 files, 1,064 passed. Type-check and lint passed with the 12 pre-existing Fast Refresh warnings.
- Web complete suite: 85 files, 745 passed; Chromium end-to-end 18 passed; type-check, lint, production build, and bundle budget passed.
- Policy-v1 evaluator: 75 passed with clean focused type-check and lint.
- Backend CI steps reproduced locally: type parity, provider gate smoke with zero provider network calls, queue readiness smoke, provider status `--require-disabled`, queue readiness, and `docker compose config`. `npm audit`, the Docker image and ML jobs, and hosted CI were not reproduced.

An independent full-range review then followed ([PR 2](./PR-2-REVIEW-2026-09-14.md)); its two P1 and eleven P2 fixes were verified by a further complete gate: backend 158 files, 2,313 passed, 1 skipped on a fresh database with all 45 migrations, guard `ok`; web 85 files, 748 passed plus 18 end-to-end; mobile 98 files, 1,069 passed after the owner's dispositions were applied; reconciliation harness 237 facts. Of the four P2 dispositions, one was accepted with a runbook requirement, two were fixed, and one is deferred to after merge. Those changes were committed later the same day as `36223ae` and `aede3a5`; no deployment was made by an agent during this work.

## Incident disclosure

During migration validation, Prisma loaded the configured hosted `DIRECT_URL` even though `DATABASE_URL` pointed to a disposable database. The first additive Phase 2 migration was consequently applied to the hosted Supabase database without authorization. Hosted access stopped immediately. No rollback or compensating write was attempted because the migration is additive and a rollback would be destructive.

The incident record states that only `20260913100918_receipt_capture_batches_and_scan_revision` was deployed to the hosted database by the incident. Separately, the owner personally ran `prisma migrate deploy` from the interactive shell twice to restore the development server: on 13 September (applying `20260913192200` and `20260913194745`) and at about 02:07 PHT on 14 September (applying `20260913230000` and `20260914010610`). Those were owner actions on the development project, not agent actions. The hosted ledger is expected to hold all 45 migrations (the 45 committed at `aede3a5`; the two later worktree migrations `20260914104500_external_processing_consent_source` and `20260914104600_receipt_scan_last_activity_grace`, which bring the chain to 47, are not part of that expectation and are not recorded as deployed anywhere), unverified by an authorized check. At approximately 23:02 to 23:04 PHT on 13 September 2026, three later SELECT-only verification entrypoints accidentally inherited `backend/.env` and reached the hosted database: the Phase 2 schema-sentinel catalog query, the combined migration-ledger and schema-shape guard, and one `SELECT` of the `20260913100918` migration-ledger row. They performed no writes or migrations, read no user or receipt data, and emitted no credential values. Work stopped after the inherited connection was discovered. See [HOSTED-MIGRATION-INCIDENT.md](./HOSTED-MIGRATION-INCIDENT.md) for the full chronology.

The test harness now gives explicitly supplied environment variables precedence over checked-in local defaults. This does not replace reviewed deployment controls: later migrations must still be applied through the authorized deployment workflow.

## Open release acceptance

These checks require hardware, consented data, or deployed credentials and are not represented as automated passes:

- Current closure status for the [PR review](./PR-1-REVIEW-2026-09-13.md): the four P1 and eight P2 findings have coordinated local remediation evidence. The independent full-range review (PR 2), the commit (`36223ae`, `aede3a5`), and hosted CI on `aede3a5` are done; the PR #1 merge decision and the external acceptance gates remain open.

- Standard, Long, batch, permission, lifecycle, rotation/crop, low-memory, thermal, TalkBack, and large-text journeys on representative Android devices.
- Authenticated end-to-end retrieval from the deployed private receipt bucket, including signed-link expiry and refresh.
- OCR, field, line-item, duplicate, latency, and correction-rate thresholds on the consented real-receipt corpus.
- Manual inspection that deleted evidence is absent from private storage after the purge worker completes.

Native iOS VisionKit, trained handwriting models, local embeddings, multiple paid-provider failover, staff/bookkeeper roles, and configurable production retention/redaction remain post-MVP work.
