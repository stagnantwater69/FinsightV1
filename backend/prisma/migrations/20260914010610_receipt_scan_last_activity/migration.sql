-- Seven-day abandoned-scan lifecycle (Phase 2 finding P2-5).
--
-- Adds the last-activity clock the sweep needs. RLS on "ReceiptScan" is
-- table-level (20260806153854) and the anon/authenticated revokes cover all
-- columns, so a new column inherits the deny-all posture with no new policy.

-- AlterTable
ALTER TABLE "ReceiptScan"
    ADD COLUMN "ReceiptScan_LastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill from the timestamps that already exist rather than from now().
-- A scan nobody has touched for weeks is already abandoned; giving it a fresh
-- seven days it never earned would misreport the retention policy. GREATEST
-- ignores NULL operands, and "ReceiptScan_CreatedAt" is NOT NULL, so every
-- row gets a real value. Field corrections are the only durable record of
-- owner edits on an unconfirmed scan, so their latest timestamp counts too.
UPDATE "ReceiptScan" scan
SET "ReceiptScan_LastActivityAt" = GREATEST(
    scan."ReceiptScan_CreatedAt",
    scan."ReceiptScan_ProcessingStartedAt",
    scan."ReceiptScan_ProcessingHeartbeatAt",
    scan."ReceiptScan_EvidenceDeletionRequestedAt",
    scan."ReceiptScan_EvidenceDeletedAt",
    (
        SELECT MAX(correction."ReceiptFieldCorrection_CreatedAt")
        FROM "ReceiptFieldCorrection" correction
        WHERE correction."ReceiptScan_ID" = scan."ReceiptScan_ID"
    )
);

-- CreateIndex
-- Serves: WHERE "ReceiptScan_ConfirmationStatus" = 'Pending'
--           AND "ReceiptScan_ProcessingStatus" IN ('Complete', 'Failed')
--           AND "ReceiptScan_LastActivityAt" < now() - interval '7 days'
--         ORDER BY "ReceiptScan_LastActivityAt", "ReceiptScan_ID" LIMIT n
-- Equality columns lead, the range column follows, the id breaks ties so a
-- bounded sweep can page by keyset without re-reading rows it already saw.
CREATE INDEX "ReceiptScan_abandoned_sweep_idx"
    ON "ReceiptScan"(
        "ReceiptScan_ConfirmationStatus",
        "ReceiptScan_ProcessingStatus",
        "ReceiptScan_LastActivityAt",
        "ReceiptScan_ID"
    );
