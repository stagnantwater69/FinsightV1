-- The existing available-funds amount becomes an opening balance at the
-- migration transaction time. New profiles receive their creation-time anchor.
ALTER TABLE "BusinessProfile" ADD COLUMN     "BusinessProfile_AvailableFundsBaselineAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "BusinessProfile_AvailableFundsBaselineDate" DATE,
ADD COLUMN     "BusinessProfile_ExpenseRecordsCompleteThroughMonth" DATE,
ADD COLUMN     "BusinessProfile_ExpenseRecordsCompleteThroughConfirmedAt" TIMESTAMP(3);

-- Freeze the business-local date independently of later timezone changes.
-- Asia/Manila is used only when a legacy row contains an invalid timezone.
UPDATE "BusinessProfile" AS profile
SET "BusinessProfile_AvailableFundsBaselineDate" = (
  CURRENT_TIMESTAMP AT TIME ZONE COALESCE(
    (
      SELECT tz.name
      FROM pg_timezone_names() AS tz
      WHERE tz.name = profile."BusinessProfile_Timezone"
      LIMIT 1
    ),
    'Asia/Manila'
  )
)::date;

ALTER TABLE "BusinessProfile"
ALTER COLUMN "BusinessProfile_AvailableFundsBaselineDate" SET NOT NULL,
ALTER COLUMN "BusinessProfile_AvailableFundsBaselineDate" SET DEFAULT CURRENT_TIMESTAMP;

-- A DATE represents a month only when normalized to its first calendar day.
ALTER TABLE "BusinessProfile"
ADD CONSTRAINT "BusinessProfile_expense_records_complete_through_month_check"
CHECK (
  "BusinessProfile_ExpenseRecordsCompleteThroughMonth" IS NULL
  OR EXTRACT(DAY FROM "BusinessProfile_ExpenseRecordsCompleteThroughMonth") = 1
);

ALTER TABLE "BusinessProfile"
ADD CONSTRAINT "BusinessProfile_expense_records_complete_pair_check"
CHECK (
  ("BusinessProfile_ExpenseRecordsCompleteThroughMonth" IS NULL)
  = ("BusinessProfile_ExpenseRecordsCompleteThroughConfirmedAt" IS NULL)
);
