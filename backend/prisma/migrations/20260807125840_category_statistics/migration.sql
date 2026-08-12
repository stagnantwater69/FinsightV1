-- Current rolling summaries used by the anomaly engine. One row per category
-- and window is updated in place, so daily refreshes do not grow this table.
CREATE TABLE "CategoryStatistics" (
  "CategoryStatistics_ID" SERIAL NOT NULL,
  "BusinessProfile_ID" INTEGER NOT NULL,
  "Category_ID" INTEGER NOT NULL,
  "CategoryStatistics_WindowDays" INTEGER NOT NULL,
  "CategoryStatistics_WindowStart" DATE NOT NULL,
  "CategoryStatistics_WindowEnd" DATE NOT NULL,
  "CategoryStatistics_RecordCount" INTEGER NOT NULL,
  "CategoryStatistics_Sum" DECIMAL(18,2) NOT NULL,
  "CategoryStatistics_SumOfSquares" DECIMAL(24,2) NOT NULL,
  "CategoryStatistics_Mean" DECIMAL(18,6) NOT NULL,
  "CategoryStatistics_StandardDeviation" DECIMAL(18,6) NOT NULL,
  "CategoryStatistics_Q1" DECIMAL(18,6) NOT NULL,
  "CategoryStatistics_Q3" DECIMAL(18,6) NOT NULL,
  "CategoryStatistics_Minimum" DECIMAL(18,2),
  "CategoryStatistics_Maximum" DECIMAL(18,2),
  "CategoryStatistics_CalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "CategoryStatistics_UpdatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CategoryStatistics_pkey" PRIMARY KEY ("CategoryStatistics_ID"),
  CONSTRAINT "CategoryStatistics_BusinessProfile_ID_fkey"
    FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CategoryStatistics_Category_ID_fkey"
    FOREIGN KEY ("Category_ID") REFERENCES "ExpenseCategory"("Category_ID")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CategoryStatistics_WindowDays_check"
    CHECK ("CategoryStatistics_WindowDays" > 0),
  CONSTRAINT "CategoryStatistics_RecordCount_check"
    CHECK ("CategoryStatistics_RecordCount" >= 0),
  CONSTRAINT "CategoryStatistics_Window_check"
    CHECK ("CategoryStatistics_WindowStart" <= "CategoryStatistics_WindowEnd")
);

CREATE UNIQUE INDEX "CategoryStatistics_Category_ID_CategoryStatistics_WindowDays_key"
  ON "CategoryStatistics"("Category_ID", "CategoryStatistics_WindowDays");
CREATE INDEX "CategoryStatistics_BusinessProfile_ID_CategoryStatistics_W_idx"
  ON "CategoryStatistics"("BusinessProfile_ID", "CategoryStatistics_WindowDays");

ALTER TABLE "CategoryStatistics" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "CategoryStatistics" FROM anon;
    REVOKE ALL ON SEQUENCE "CategoryStatistics_CategoryStatistics_ID_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "CategoryStatistics" FROM authenticated;
    REVOKE ALL ON SEQUENCE "CategoryStatistics_CategoryStatistics_ID_seq" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE "CategoryStatistics" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE "CategoryStatistics_CategoryStatistics_ID_seq" TO service_role;
  END IF;
END $$;
