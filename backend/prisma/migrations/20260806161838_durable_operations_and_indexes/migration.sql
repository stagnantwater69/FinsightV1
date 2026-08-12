-- A receipt read is a durable database job. The lease fields let a new
-- backend process reclaim work after a crash without requiring Redis/PGMQ.
ALTER TABLE "ReceiptScan"
  ADD COLUMN "ReceiptScan_ProcessingAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ReceiptScan_ProcessingStartedAt" TIMESTAMP(3),
  ADD COLUMN "ReceiptScan_ProcessingHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "ReceiptScan_NextProcessingAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ReceiptScan_ProcessingWorkerID" VARCHAR(100);

CREATE INDEX "ReceiptScan_ReceiptScan_ProcessingStatus_ReceiptScan_NextProces_idx"
  ON "ReceiptScan"("ReceiptScan_ProcessingStatus", "ReceiptScan_NextProcessingAttemptAt", "ReceiptScan_ProcessingHeartbeatAt");

-- Missing FK indexes reported by Supabase's performance advisor.
CREATE INDEX "ExpenseRecord_DuplicateOf_RecordID_idx"
  ON "ExpenseRecord"("DuplicateOf_RecordID");
CREATE INDEX "SalesReferenceRecord_DuplicateOf_RecordID_idx"
  ON "SalesReferenceRecord"("DuplicateOf_RecordID");

-- Supports bounded date/keyset pages without scanning every record owned by
-- the business. ID provides a deterministic tiebreaker for same-day rows.
CREATE INDEX "ExpenseRecord_BusinessProfile_ID_ExpenseRecord_Date_ExpenseR_idx"
  ON "ExpenseRecord"("BusinessProfile_ID", "ExpenseRecord_Date", "ExpenseRecord_ID");
CREATE INDEX "SalesReferenceRecord_BusinessProfile_ID_SalesReferenceRecor_idx"
  ON "SalesReferenceRecord"("BusinessProfile_ID", "SalesReferenceRecord_Date", "SalesReferenceRecord_ID");

-- Retrying a scan must not duplicate lines already persisted by an earlier
-- attempt that died just before it marked the scan complete.
CREATE UNIQUE INDEX "ReceiptScanItem_ReceiptScan_ID_ReceiptScanItem_LineNumber_key"
  ON "ReceiptScanItem"("ReceiptScan_ID", "ReceiptScanItem_LineNumber");

CREATE TABLE "ApiRateLimit" (
  "ApiRateLimit_Key" VARCHAR(255) NOT NULL,
  "ApiRateLimit_WindowStart" TIMESTAMP(3) NOT NULL,
  "ApiRateLimit_Count" INTEGER NOT NULL DEFAULT 0,
  "ApiRateLimit_ExpiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiRateLimit_pkey" PRIMARY KEY ("ApiRateLimit_Key")
);
CREATE INDEX "ApiRateLimit_ApiRateLimit_ExpiresAt_idx"
  ON "ApiRateLimit"("ApiRateLimit_ExpiresAt");

-- The Data API is not an application-data access path. Keep new operational
-- tables under the same deny-by-default posture as the existing schema.
ALTER TABLE "ApiRateLimit" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "ApiRateLimit" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "ApiRateLimit" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE "ApiRateLimit" TO service_role;
  END IF;
END $$;
