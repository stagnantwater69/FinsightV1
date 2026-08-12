-- A common, versioned store for findings from every detector. Keeping this
-- separate from ExpenseRecord avoids adding one flag column per technique and
-- allows multiple explainable findings to refer to the same transaction.
CREATE TYPE "AnomalyFindingType" AS ENUM (
  'AMOUNT_OUTLIER',
  'POSSIBLE_DUPLICATE',
  'VELOCITY_ANOMALY',
  'RECURRING_CHANGE',
  'TREND_CHANGE',
  'BEHAVIORAL_NOVELTY'
);

CREATE TYPE "AnomalyFindingSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "AnomalyFindingStatus" AS ENUM ('OPEN', 'CONFIRMED', 'DISMISSED', 'RESOLVED', 'SUPERSEDED');
CREATE TYPE "AnomalyFindingFeedback" AS ENUM (
  'CONFIRMED_UNUSUAL',
  'EXPECTED_TRANSACTION',
  'DUPLICATE',
  'INCORRECT_MATCH',
  'NO_LONGER_RELEVANT'
);

CREATE TABLE "AnomalyFinding" (
  "AnomalyFinding_ID" SERIAL NOT NULL,
  "BusinessProfile_ID" INTEGER NOT NULL,
  "ExpenseRecord_ID" INTEGER,
  "AnomalyFinding_Fingerprint" VARCHAR(191) NOT NULL,
  "AnomalyFinding_Type" "AnomalyFindingType" NOT NULL,
  "AnomalyFinding_Method" VARCHAR(100) NOT NULL,
  "AnomalyFinding_Severity" "AnomalyFindingSeverity" NOT NULL,
  "AnomalyFinding_Score" DECIMAL(12,6),
  "AnomalyFinding_Title" VARCHAR(180) NOT NULL,
  "AnomalyFinding_Reasons" JSONB NOT NULL,
  "AnomalyFinding_Metadata" JSONB,
  "AnomalyFinding_DetectorVersion" VARCHAR(50) NOT NULL,
  "AnomalyFinding_Status" "AnomalyFindingStatus" NOT NULL DEFAULT 'OPEN',
  "AnomalyFinding_Feedback" "AnomalyFindingFeedback",
  "AnomalyFinding_DetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "AnomalyFinding_ReviewedAt" TIMESTAMP(3),
  "AnomalyFinding_UpdatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AnomalyFinding_pkey" PRIMARY KEY ("AnomalyFinding_ID"),
  CONSTRAINT "AnomalyFinding_BusinessProfile_ID_fkey"
    FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnomalyFinding_ExpenseRecord_ID_fkey"
    FOREIGN KEY ("ExpenseRecord_ID") REFERENCES "ExpenseRecord"("ExpenseRecord_ID")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AnomalyFinding_BusinessProfile_ID_AnomalyFinding_Fingerprint_key"
  ON "AnomalyFinding"("BusinessProfile_ID", "AnomalyFinding_Fingerprint");
CREATE INDEX "AnomalyFinding_BusinessProfile_ID_AnomalyFinding_Status_An_idx"
  ON "AnomalyFinding"("BusinessProfile_ID", "AnomalyFinding_Status", "AnomalyFinding_DetectedAt");
CREATE INDEX "AnomalyFinding_BusinessProfile_ID_AnomalyFinding_Type_Anom_idx"
  ON "AnomalyFinding"("BusinessProfile_ID", "AnomalyFinding_Type", "AnomalyFinding_DetectedAt");
CREATE INDEX "AnomalyFinding_ExpenseRecord_ID_idx"
  ON "AnomalyFinding"("ExpenseRecord_ID");

-- FinSight's clients use Supabase for Auth, not direct application-table
-- access. Follow the existing deny-by-default Data API policy while allowing
-- the trusted backend service role to operate when used by infrastructure.
ALTER TABLE "AnomalyFinding" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "AnomalyFinding" FROM anon;
    REVOKE ALL ON SEQUENCE "AnomalyFinding_AnomalyFinding_ID_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "AnomalyFinding" FROM authenticated;
    REVOKE ALL ON SEQUENCE "AnomalyFinding_AnomalyFinding_ID_seq" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE "AnomalyFinding" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE "AnomalyFinding_AnomalyFinding_ID_seq" TO service_role;
  END IF;
END $$;
