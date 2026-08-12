CREATE TYPE "RecurringPatternStatus" AS ENUM ('CANDIDATE', 'CONFIRMED', 'DISMISSED', 'DISABLED');

CREATE TABLE "RecurringPattern" (
  "RecurringPattern_ID" SERIAL NOT NULL,
  "BusinessProfile_ID" INTEGER NOT NULL,
  "Category_ID" INTEGER NOT NULL,
  "RecurringPattern_NormalizedKey" VARCHAR(64) NOT NULL,
  "RecurringPattern_Vendor" VARCHAR(150),
  "RecurringPattern_Description" VARCHAR(255) NOT NULL,
  "RecurringPattern_IntervalDays" INTEGER NOT NULL,
  "RecurringPattern_ExpectedAmount" DECIMAL(18,2) NOT NULL,
  "RecurringPattern_AmountTolerance" DECIMAL(8,6) NOT NULL,
  "RecurringPattern_Confidence" DECIMAL(8,6) NOT NULL,
  "RecurringPattern_ObservationCount" INTEGER NOT NULL,
  "RecurringPattern_LastOccurrence" DATE NOT NULL,
  "RecurringPattern_NextExpectedDate" DATE NOT NULL,
  "RecurringPattern_Status" "RecurringPatternStatus" NOT NULL DEFAULT 'CANDIDATE',
  "RecurringPattern_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "RecurringPattern_UpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringPattern_pkey" PRIMARY KEY ("RecurringPattern_ID"),
  CONSTRAINT "RecurringPattern_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID")
    REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecurringPattern_Category_ID_fkey" FOREIGN KEY ("Category_ID")
    REFERENCES "ExpenseCategory"("Category_ID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecurringPattern_IntervalDays_check" CHECK ("RecurringPattern_IntervalDays" > 0),
  CONSTRAINT "RecurringPattern_ObservationCount_check" CHECK ("RecurringPattern_ObservationCount" >= 3),
  CONSTRAINT "RecurringPattern_Confidence_check" CHECK ("RecurringPattern_Confidence" >= 0 AND "RecurringPattern_Confidence" <= 1)
);

CREATE UNIQUE INDEX "RecurringPattern_BusinessProfile_ID_RecurringPattern_NormalizedKey_key"
  ON "RecurringPattern"("BusinessProfile_ID", "RecurringPattern_NormalizedKey");
CREATE INDEX "RecurringPattern_BusinessProfile_ID_RecurringPattern_Status_Rec_idx"
  ON "RecurringPattern"("BusinessProfile_ID", "RecurringPattern_Status", "RecurringPattern_NextExpectedDate");
CREATE INDEX "RecurringPattern_Category_ID_idx" ON "RecurringPattern"("Category_ID");

ALTER TABLE "RecurringPattern" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "RecurringPattern" FROM anon;
    REVOKE ALL ON SEQUENCE "RecurringPattern_RecurringPattern_ID_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "RecurringPattern" FROM authenticated;
    REVOKE ALL ON SEQUENCE "RecurringPattern_RecurringPattern_ID_seq" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE "RecurringPattern" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE "RecurringPattern_RecurringPattern_ID_seq" TO service_role;
  END IF;
END $$;
