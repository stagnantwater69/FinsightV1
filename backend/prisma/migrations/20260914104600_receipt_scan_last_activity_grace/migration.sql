-- Abandoned-scan grace floor (docs/deployment-runbook.md section 5).
--
-- 20260914010610 backfilled "ReceiptScan_LastActivityAt" from creation,
-- processing, evidence-deletion and field-correction timestamps. None of
-- those recorded owner views, so a pending scan the owner merely opened last
-- week looks inactive since its last edit or OCR pass and the seven-day sweep
-- would purge it on its first run after deploy. Flooring unconfirmed scans
-- at deploy time minus six days gives every owner at least a day to resume.
--
-- The floor is anchored to this migration's own ledger row (Prisma writes
-- started_at before running the script) and truncated to milliseconds to
-- match TIMESTAMP(3), so a re-run computes the same floor and updates no
-- rows. CURRENT_TIMESTAMP is only the fallback outside Prisma. No schema
-- shape changes, so the Phase 2 catalog sentinels are unaffected.
DO $grace$
DECLARE
    grace_floor TIMESTAMP(3);
BEGIN
    SELECT date_trunc(
        'milliseconds',
        COALESCE(
            (
                SELECT ledger.started_at
                FROM public."_prisma_migrations" ledger
                WHERE ledger.migration_name = '20260914104600_receipt_scan_last_activity_grace'
                  AND ledger.rolled_back_at IS NULL
                ORDER BY ledger.started_at
                LIMIT 1
            ),
            CURRENT_TIMESTAMP
        ) - interval '6 days'
    )
    INTO grace_floor;

    UPDATE public."ReceiptScan"
    SET "ReceiptScan_LastActivityAt" = grace_floor
    WHERE "ReceiptScan_ConfirmationStatus" = 'Pending'
      AND "ReceiptScan_LastActivityAt" < grace_floor;
END
$grace$;
