# Phase 2 hosted migration incident

**Detected:** 13 September 2026, 18:53 Asia/Manila
**Status:** Contained; no rollback or further hosted access performed

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

## Containment and follow-up

1. Do not run another hosted migration, rollback, or schema repair without explicit owner approval.
2. Run all remaining migration checks with both `DATABASE_URL` and `DIRECT_URL` explicitly pinned to a disposable PostgreSQL 16 database.
3. Preserve and commit the exact migration bytes above.
4. Run the complete branch CI and review the Phase 2 pull request before deploying application code.
5. Keep the hosted migration incident visible in the Phase 2 handoff; a green CI run does not erase the unauthorized deployment.

The lowest-risk current posture is to leave the additive migration in place and bring the reviewed application code forward after CI. A rollback would require destructive schema operations and is not authorized by this task.
