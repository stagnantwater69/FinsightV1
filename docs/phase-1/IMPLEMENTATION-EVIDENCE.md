# FinSight Phase 1 implementation evidence

**Date:** 13 September 2026 (Asia/Manila)

**Scope:** the single-owner receipt workflow. No staff, bookkeeper, invitation,
or collaboration role was added.

## Result

The Phase 1 repository implementation is complete and the local automated gate
passes. Receipt upload now queues durable work for a dedicated worker, local
Tesseract remains the default reader, exact confirmed owner category choices
are reused locally, and optional receipt-image providers fail closed behind
explicit consent, calibration, budget, and kill-switch checks.

This is not yet a production-release declaration. The remaining hosted,
physical-device, and real-receipt evidence is listed below.

## Ticket status

| Ticket | Repository result | Evidence still outside the repository |
|---|---|---|
| P1-DB-01 | Additive consent, budget, dispatch-audit, purge-state, RLS, revoke, and tenant-FK migration implemented | None for implementation |
| P1-BE-01 | API upload/retry is queue-only; only the worker imports OCR and receipt provider adapters; scan, page, and item output commits atomically under the current worker lease | Deployed API/worker process checks |
| P1-BE-02 | Disk-backed bounded multipart ingestion; 10 MiB/object, 8 pages, 16 objects, 80 MiB aggregate; idempotent cleanup | Authenticated abort/restart drill |
| P1-DB-02 | Read-only verifier and explicit `--apply` configurator implemented | Apply and verify the target hosted private buckets |
| P1-OPS-01 | English traineddata is tracked, checksummed, read-only in the worker image, and configured with no runtime cache/download | Complete the production-image network-disabled CI run |
| P1-AI-01 | Versioned deterministic local-first rescue decision implemented | Real-corpus calibration remains a later evidence gate |
| P1-AI-02 | Provider-neutral request/outcome/evidence seam implemented; no Azure client or network adapter exists | None for the disabled seam |
| P1-BE-03 | Exact current consent/revocation, safe public codes, metadata-only provider logs, and account deletion implemented | Provider terms must be reviewed before any real enablement |
| P1-BE-04 | One Gemini-or-Veryfi gate enforces consent, atomic units, evidence hashes, calibration, live config recheck, and no fallback cascade | Keep disabled unless separately approved and calibrated |
| P1-WEB-01 | Exact limits, retained invalid selections, conditional consent, and revoke-only stale-consent state implemented | Deployed browser smoke |
| P1-MOB-01 | Actual URI byte checks, MIME checks, retained correction state, and conditional/revoke-only consent implemented | Physical Android verification |
| P1-OPS-02 | 81 MiB proxy envelope, 192 MiB private API tmpfs, safe sweeper, and graceful API signal handling implemented | Authenticated deployed cleanup/restart drill |
| P1-OPS-03 | Provider/queue status, kill-switch, stale dispatch review, worker readiness, and recovery/rollback runbook implemented | Deployed recovery, secret-rotation, rollback, and applicable billing checks |
| P1-QA-01 | Local ownership, multipart, process, consent, budget-race, timeout, logging, and deletion gates pass | Real receipts, physical devices, and any authorized live-provider check |

## Free-first receipt behavior

- Receipt images are read locally with packaged Tesseract first.
- Receipt-derived item names, vendors, category names, and prior choices are not
  sent through the general Gemini/OpenRouter category endpoint.
- An exact normalized match from this owner's confirmed receipt history is
  assigned automatically. An unfamiliar item remains `Uncategorized` and
  editable during review.
- Optional Gemini or Veryfi receipt-image rescue defaults to disabled. A key by
  itself cannot enable it, an absent or zero budget allows no call, and one
  provider can be selected without paid-provider fallback.
- Azure appears only as a future contract enum. Phase 1 has no Azure client,
  endpoint, credential, SDK, or network call.

## Automated evidence

| Gate | Result |
|---|---|
| Backend focused Phase 1 tests | PASS: 19 files, 294 tests |
| Stale-worker concurrency regression | PASS: the stale attempt lock-waits, fails its lease guard after reclaim, and cannot alter the newer scan, page, or item output |
| Backend full tests | PASS: 149 files, 2,101 tests; 1 intentional inverse-environment skip |
| Web full tests | PASS: 82 files, 707 tests |
| Web receipt-review Chromium E2E | PASS: 1 test across its existing layouts/themes |
| Mobile full tests | PASS: 94 files, 1,013 tests |
| Combined backend/web/mobile tests | PASS: 3,821 tests; 1 intentional backend skip |
| Backend/web/mobile TypeScript | PASS |
| Backend/web/mobile lint | PASS with existing warnings outside the Phase 1 changes |
| Backend and web production builds | PASS |
| Shared web/mobile type parity | PASS: 91 exported types match |
| Prisma validation and local migration status | PASS: 40 migrations current |
| Local database-to-schema diff | PASS: no difference detected |
| Provider configuration smoke | PASS: 7 scenarios, zero network calls |
| Provider disabled status with a placeholder credential | PASS: disabled, zero network calls |
| Queue-readiness smoke | PASS: stale `SUBMITTED` state requires attention; no sensitive output fields |
| Local queue readiness | PASS: explicit read-only transaction, idle queue, bounded budget, no provider audit requiring review |
| Upload orphan, API signal, and worker readiness drills | PASS |
| Live nginx upload-envelope drill | PASS: 83,886,080 file bytes reached the backend inside an 84,413,748-byte request; 81 MiB + 1 byte was rejected with 413 |
| Shell syntax and Compose configuration | PASS |
| Phase 1 migration SHA-256 | `df2979d2faf603dd577b79c48090e2768cba577392fee56d2a4e72b50fbaed9b` |
| English traineddata SHA-256 | `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |

The production Docker image was not rebuilt locally because the workstation's
root filesystem did not have a safe build margin. CI contains the production
worker build, network-disabled cold OCR, missing-language failure, image target,
entrypoint, and health checks; that workflow run remains release evidence.

## Hosted migration incident and verification

During local verification, `npx prisma migrate deploy` was accidentally invoked
without an explicit local datasource override. Prisma loaded `backend/.env` and
applied the new additive Phase 1 migration to the configured hosted database.
The run was stopped from making any further hosted change; no rollback or
migration-file rewrite was attempted.

The migration adds schema objects and revokes privileges. It contains no row
delete or data rewrite. Immediate read-only verification found:

- all 40 migrations applied and the hosted schema at zero Prisma drift;
- RLS enabled on `ExternalProcessingConsent`, `ExternalProviderBudget`,
  `ExternalProviderDispatch`, and `ReceiptPurgeJob`;
- no effective application-table DML grant for `anon`, `authenticated`, or
  `service_role` on those four tables; and
- no receipt row, provider dispatch, object, or financial value was read.

The hosted Storage configuration was not changed. Its read-only check found the
`receipts` and `csv-imports` buckets private but missing the new object-size and
MIME restrictions. That mismatch remains an explicit release gate.

## Release-only work still open

- Apply `npm run storage:buckets:configure -- --apply` only as an authorized,
  deliberate hosted operation, then require `npm run storage:buckets:verify`
  to pass.
- Run the committed CI workflow, including the clean production worker image
  with outbound network disabled.
- Run authenticated upload-abort, API restart, stopped-worker/stale-lease
  recovery, secret-rotation, and independent API/worker rollback drills in a
  disposable deployed environment.
- Complete the consented real-receipt corpus and sealed ground truth before
  making an accuracy-improvement claim.
- Verify camera permissions, lifecycle, long receipts, correction retention,
  and memory ceiling on the two named physical Android targets.
- Record whether the hosted project is synthetic-only or contains a real owner
  account. Before real financial data, close leaked-password protection,
  signup, backup/restore, and applicable Supabase Pro Spend Cap checks.
- Keep every live receipt provider disabled until its data terms, region,
  retention, calibration, consent, cap, and owner approval are current. No live
  provider call was made for this implementation gate.

The operational commands and evidence rules are in
[`../deployment-runbook.md`](../deployment-runbook.md), and the detailed local
drill record is in [`P1-OPS-03-EVIDENCE.md`](P1-OPS-03-EVIDENCE.md).
