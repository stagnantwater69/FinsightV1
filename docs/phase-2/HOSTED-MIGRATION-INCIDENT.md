# Phase 2 hosted migration incident

**Detected:** 13 September 2026, 18:53 Asia/Manila
**Status:** Contained; no rollback performed; three subsequent unintended SELECT-only entrypoints and one later owner-performed hosted deployment are disclosed below

## What happened

During a fresh-database replay, `DATABASE_URL` was pointed at the disposable PostgreSQL 16 database but Prisma also read the repository's configured `DIRECT_URL`. `prisma migrate deploy` therefore applied `20260913100918_receipt_capture_batches_and_scan_revision` to the hosted Supabase database instead of the disposable database.

This deployment was not part of the requested local implementation or CI work. The command was stopped after it completed, hosted access was halted, and no rollback or compensating database write was attempted.

## Applied artifact

- Migration: `20260913100918_receipt_capture_batches_and_scan_revision`
- SHA-256: `8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b`
- Size: 14,098 bytes
- Prisma reported 41 migrations and a successful application.
- A following status command reported the hosted schema migration ledger up to date.

The migration file was frozen immediately. Any correction must use a later migration; changing the applied file would create a checksum mismatch.

## Data-impact review

The applied SQL is additive except for replacing two indexes with their Phase 2 equivalents. It creates Phase 2 receipt batch and duplicate-candidate structures, adds nullable or defaulted receipt fields, adds constraints and foreign keys, and enables RLS/revokes on the new tables. It contains no row deletion, table drop, column drop, or data rewrite that removes business records.

The previous application version does not write `ReceiptPurgeJob`, so the new required purge-mode column does not break an existing write path. The Phase 2 branch must still pass its migration, compatibility, and application tests before deployment.

## Initial containment and follow-up

1. Do not run another hosted migration, rollback, or schema repair without explicit owner approval.
2. Run all remaining migration checks with both `DATABASE_URL` and `DIRECT_URL` explicitly pinned to a disposable PostgreSQL 16 database.
3. Preserve and commit the exact migration bytes above.
4. Run the complete branch CI and review the Phase 2 pull request before deploying application code.
5. Keep the hosted migration incident visible in the Phase 2 handoff; a green CI run does not erase the unauthorized deployment.

The migration remains in place because a rollback would require destructive schema operations and is not authorized by this task. Application deployment remains blocked pending the PR review findings and the verification note below.

## Later review note

The 13 September PR review found a disposable local database with the same `20260913100918_receipt_capture_batches_and_scan_revision` name recorded under the earlier checksum `a0e4f79275cbb0e975f16d4675776ecf954395eaa6dd5900f15cd3f73030ca5b`. A read-only schema diff shows that the local database lacks the duplicate table and enums, purge mode, evidence-deletion and semantic-fingerprint fields, history indexes, and other current migration objects. Prisma deployment and the application startup guard nevertheless report the named migration as applied. A fresh database created from the tracked `8e03ef8f...` file has the expected schema and passes the backend suite.

This does not disprove the artifact hash captured above or establish hosted drift. It does show that migration-name status alone is insufficient evidence. At this review checkpoint, the required response was an explicitly authorized read-only hosted checksum and schema-shape verification plus a new forward-only reconciliation migration for any supported earlier revision. Rewriting the applied migration or its ledger row remained prohibited.

## Forward reconciliation implemented locally

The forward-only migration `20260913230000_reconcile_phase2_scanner_migration_drift` is frozen at SHA-256 `d2f4805aef790c484fd1878edecfcba0a39b93529cb8d9b0879469e2aaa99d46`. It recognizes exactly two source histories: the current `8e03ef8f...` migration revision, which takes a verification-only path, and the known legacy `a0e4f792...` revision, which is repaired only after its expected legacy catalog shape is proven. Unknown checksums, unexpected partial Phase 2 objects, malformed constraints, and altered index semantics—including collations and operator classes—fail closed.

Local disposable-database tests pinned both `DATABASE_URL` and `DIRECT_URL`. Fresh and reconciled legacy paths produced the same 235-fact canonical Phase 2 catalog and security digest, `5b9fbff1a7f8d9aeb3ca15ebdf484e5078d81ec4541cde9fc716ced4a45e39d3` on the P1 snapshot, and an identical 237-fact catalog at `eb4d357dd91fe66da9f52557dc500b9b6859ed5da9a8f48deedbea886d9c8c50` after the 14 September `20260914010610_receipt_scan_last_activity` migration, while intentional unknown, partial, and malformed fixtures were rejected. The reconciliation migration has not been deployed to the hosted database.

## Later accidental hosted read-only access

At approximately 23:02 to 23:04 PHT on 13 September 2026, three verification entrypoints unintentionally inherited the hosted connection from `backend/.env`:

1. The Phase 2 schema-sentinel catalog query.
2. The combined migration-ledger and schema-shape guard.
3. One `SELECT` of the `20260913100918_receipt_capture_batches_and_scan_revision` ledger row.

These entrypoints were SELECT-only. They performed no write or migration, accessed no user or receipt data, and emitted no credential values. Hosted access stopped after the inherited connection was discovered. The results are not treated as authorized hosted verification, and no hosted reconciliation or application deployment followed.

## Owner-performed hosted deployment, 13 September 2026

This is disclosed for completeness because it changed the hosted ledger and is easy to confuse with the incident above. It was not an agent action and not part of the incident.

Between 21:28 and 21:33 PHT on 13 September 2026, the owner ran `npx prisma migrate deploy` from an interactive shell in `backend/`, using the repository's configured hosted connection on purpose, to restore the development API for the standalone Android build. The startup guard had refused to start at 21:28 with exactly two pending migrations, `20260913192200_receipt_capture_batch_cancelled_status` and `20260913194745_receipt_scan_source_image_hash`; the reconciliation directory did not exist on disk until 23:03 that night, so it was neither pending nor applied. The owner's restarted API passed the guard at 21:33 and served `health/live` over the private network.

Consequences for the hosted ledger, as reported by the owner and by the guard's pending list rather than by an authorized hosted query:

- Applied by the owner: `20260913192200` and `20260913194745`. Both are additive.
- Applied by the owner in a second interactive `npx prisma migrate deploy` at about 02:07 PHT on 14 September, again to restore the development API after the guard refused with those two pending: `20260913230000_reconcile_phase2_scanner_migration_drift` (verification-only path on the hosted `8e03ef8f...` revision) and `20260914010610_receipt_scan_last_activity` (additive column, full-table backfill, one index). The owner's API then passed the startup guard with all 45 migrations and served `health/live`. The development worker started at the same time with the abandoned-scan sweep code as it stood then, which swept at boot; any unconfirmed Complete or Failed scan on the development project whose backfilled clock was older than seven days was enqueued for purge in that first pass. The boot-time sweep was removed from the code afterwards (PR 2 review).

Nothing in this section authorizes a further hosted operation. Both deploys were the owner's own interactive actions on the development project. The hosted ledger is therefore expected to hold all 45 migrations, but that expectation rests on the owner's report and the guard's pass, not on an authorized read-only ledger and schema-shape check, which is still required before the hosted state can be called verified.
