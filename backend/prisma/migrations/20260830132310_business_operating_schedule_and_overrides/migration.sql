-- Recovery Target plan §7.2 / §7.3 / §7.4 step 1 — weekly operating
-- schedule and per-date overrides, additive alongside the still-untouched
-- BusinessProfile.operatingDays approximation. Nothing here changes the
-- current calculation:
--   * BusinessOperatingDay has no rows backfilled for existing profiles —
--     zero rows means "no schedule configured yet" (§7.4 step 2), not
--     "closed every day". Weekdays are never guessed from the existing
--     operatingDays count, since several distinct weekly patterns can
--     produce the same number (§7.4).
--   * BusinessOperatingDayOverride records owner-entered date exceptions
--     (holidays, temporary closures, special openings) that take
--     precedence over the weekly schedule for that date; `reason` is
--     free-text display context only, never financial evidence (§7.3).
--
-- Note: `prisma migrate diff` against the current CLI also emitted 7
-- unrelated `RenameIndex` statements (the same Postgres 63-byte
-- identifier-truncation drift on AnomalyFinding/CategoryStatistics/
-- ExpenseRecord/ReceiptScan/RecurringPattern indexes already documented in
-- docs/P1B-MIGRATION-HISTORY-INVESTIGATION.md finding #4, and already
-- excluded from 20260830124738_business_profile_timezone for the same
-- reason). Deliberately excluded here too to keep this migration purely
-- additive and in scope.

-- CreateEnum
CREATE TYPE "OperatingDayOverrideType" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "BusinessOperatingDay" (
    "BusinessOperatingDay_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "BusinessOperatingDay_Weekday" INTEGER NOT NULL,
    "BusinessOperatingDay_IsOpen" BOOLEAN NOT NULL,

    CONSTRAINT "BusinessOperatingDay_pkey" PRIMARY KEY ("BusinessOperatingDay_ID")
);

-- CreateTable
CREATE TABLE "BusinessOperatingDayOverride" (
    "BusinessOperatingDayOverride_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "BusinessOperatingDayOverride_Date" DATE NOT NULL,
    "BusinessOperatingDayOverride_Type" "OperatingDayOverrideType" NOT NULL,
    "BusinessOperatingDayOverride_Reason" VARCHAR(120),

    CONSTRAINT "BusinessOperatingDayOverride_pkey" PRIMARY KEY ("BusinessOperatingDayOverride_ID")
);

-- CreateIndex
CREATE INDEX "BusinessOperatingDay_profile_idx" ON "BusinessOperatingDay"("BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessOperatingDay_profile_weekday_key" ON "BusinessOperatingDay"("BusinessProfile_ID", "BusinessOperatingDay_Weekday");

-- CreateIndex
CREATE INDEX "BusinessOperatingDayOverride_profile_date_idx" ON "BusinessOperatingDayOverride"("BusinessProfile_ID", "BusinessOperatingDayOverride_Date");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessOperatingDayOverride_profile_date_key" ON "BusinessOperatingDayOverride"("BusinessProfile_ID", "BusinessOperatingDayOverride_Date");

-- AddForeignKey
ALTER TABLE "BusinessOperatingDay" ADD CONSTRAINT "BusinessOperatingDay_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOperatingDayOverride" ADD CONSTRAINT "BusinessOperatingDayOverride_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny-all RLS, matching every other application table (see
-- 20260806153854_secure_application_tables_from_data_api / docs/SECURITY.md).
-- Only the backend's Express/Prisma "postgres" role connection reads these
-- tables; anon/authenticated Supabase Data API roles get nothing.
ALTER TABLE "BusinessOperatingDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessOperatingDayOverride" ENABLE ROW LEVEL SECURITY;
