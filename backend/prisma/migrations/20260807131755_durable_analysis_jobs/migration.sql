CREATE TYPE "AnalysisJobKind" AS ENUM ('TRANSACTION', 'PROFILE_REFRESH');
CREATE TYPE "AnalysisJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

CREATE TABLE "AnalysisJob" (
  "AnalysisJob_ID" SERIAL NOT NULL,
  "BusinessProfile_ID" INTEGER NOT NULL,
  "ExpenseRecord_ID" INTEGER,
  "AnalysisJob_IdempotencyKey" VARCHAR(191) NOT NULL,
  "AnalysisJob_Kind" "AnalysisJobKind" NOT NULL,
  "AnalysisJob_Status" "AnalysisJobStatus" NOT NULL DEFAULT 'PENDING',
  "AnalysisJob_AttemptCount" INTEGER NOT NULL DEFAULT 0,
  "AnalysisJob_NextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "AnalysisJob_ProcessingStartedAt" TIMESTAMP(3),
  "AnalysisJob_HeartbeatAt" TIMESTAMP(3),
  "AnalysisJob_WorkerID" VARCHAR(100),
  "AnalysisJob_LastError" VARCHAR(1000),
  "AnalysisJob_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "AnalysisJob_UpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AnalysisJob_pkey" PRIMARY KEY ("AnalysisJob_ID"),
  CONSTRAINT "AnalysisJob_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID")
    REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalysisJob_ExpenseRecord_ID_fkey" FOREIGN KEY ("ExpenseRecord_ID")
    REFERENCES "ExpenseRecord"("ExpenseRecord_ID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalysisJob_AttemptCount_check" CHECK ("AnalysisJob_AttemptCount" >= 0)
);
CREATE UNIQUE INDEX "AnalysisJob_AnalysisJob_IdempotencyKey_key" ON "AnalysisJob"("AnalysisJob_IdempotencyKey");
CREATE INDEX "AnalysisJob_AnalysisJob_Status_AnalysisJob_NextAttemptAt_An_idx"
  ON "AnalysisJob"("AnalysisJob_Status", "AnalysisJob_NextAttemptAt", "AnalysisJob_HeartbeatAt");
CREATE INDEX "AnalysisJob_BusinessProfile_ID_AnalysisJob_Kind_idx" ON "AnalysisJob"("BusinessProfile_ID", "AnalysisJob_Kind");
CREATE INDEX "AnalysisJob_ExpenseRecord_ID_idx" ON "AnalysisJob"("ExpenseRecord_ID");

ALTER TABLE "AnalysisJob" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "AnalysisJob" FROM anon;
    REVOKE ALL ON SEQUENCE "AnalysisJob_AnalysisJob_ID_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "AnalysisJob" FROM authenticated;
    REVOKE ALL ON SEQUENCE "AnalysisJob_AnalysisJob_ID_seq" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE "AnalysisJob" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE "AnalysisJob_AnalysisJob_ID_seq" TO service_role;
  END IF;
END $$;
