-- Bind each same-day classification to the exact balance baseline it answers.
ALTER TABLE "ExpenseRecord"
ADD COLUMN "ExpenseRecord_IncludedInAvailableFundsBaseline" BOOLEAN,
ADD COLUMN "ExpenseRecord_AvailableFundsDeltaBaselineAt" TIMESTAMP(3);

ALTER TABLE "SalesReferenceRecord"
ADD COLUMN "SalesReferenceRecord_IncludedInAvailableFundsBaseline" BOOLEAN,
ADD COLUMN "SalesReferenceRecord_AvailableFundsDeltaBaselineAt" TIMESTAMP(3);

-- Match the former created-after-baseline rule so migration does not change
-- the calculated balance for existing records.
UPDATE "ExpenseRecord" AS record
SET
  "ExpenseRecord_IncludedInAvailableFundsBaseline" =
    record."ExpenseRecord_CreatedAt" <= profile."BusinessProfile_AvailableFundsBaselineAt",
  "ExpenseRecord_AvailableFundsDeltaBaselineAt" =
    profile."BusinessProfile_AvailableFundsBaselineAt"
FROM "BusinessProfile" AS profile
WHERE record."BusinessProfile_ID" = profile."BusinessProfile_ID"
  AND record."ExpenseRecord_Date" = profile."BusinessProfile_AvailableFundsBaselineDate";

UPDATE "SalesReferenceRecord" AS record
SET
  "SalesReferenceRecord_IncludedInAvailableFundsBaseline" =
    record."SalesReferenceRecord_CreatedAt" <= profile."BusinessProfile_AvailableFundsBaselineAt",
  "SalesReferenceRecord_AvailableFundsDeltaBaselineAt" =
    profile."BusinessProfile_AvailableFundsBaselineAt"
FROM "BusinessProfile" AS profile
WHERE record."BusinessProfile_ID" = profile."BusinessProfile_ID"
  AND record."SalesReferenceRecord_Date" = profile."BusinessProfile_AvailableFundsBaselineDate";

ALTER TABLE "ExpenseRecord"
ADD CONSTRAINT "ExpenseRecord_available_funds_baseline_pair_check"
CHECK (
  ("ExpenseRecord_IncludedInAvailableFundsBaseline" IS NULL)
  = ("ExpenseRecord_AvailableFundsDeltaBaselineAt" IS NULL)
);

ALTER TABLE "SalesReferenceRecord"
ADD CONSTRAINT "SalesReferenceRecord_available_funds_baseline_pair_check"
CHECK (
  ("SalesReferenceRecord_IncludedInAvailableFundsBaseline" IS NULL)
  = ("SalesReferenceRecord_AvailableFundsDeltaBaselineAt" IS NULL)
);
