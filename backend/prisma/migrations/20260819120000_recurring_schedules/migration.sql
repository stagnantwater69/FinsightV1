-- Recurring schedules: owner intent gets its own table, separate from the
-- detector's inferences.
--
-- "RecurringPattern" is machine-written — it is the detector saying "these
-- records look like they repeat". "RecurringSchedule" is the owner saying "this
-- repeats, watch it for me". Those are different claims, with different owners
-- and different lifetimes, and until now they shared one row. That is the
-- reason a CONFIRMED pattern became invisible the moment it was confirmed: one
-- table was being asked to answer two questions at once.
--
-- Why a second table rather than nullable columns on "RecurringPattern":
--
--   1. An owner-declared schedule cannot physically fit that table. It carries
--      three DB-level CHECK constraints (see
--      20260807131343_recurring_patterns/migration.sql:25-27), and
--      "RecurringPattern_ObservationCount" >= 3 rejects, at the Postgres level,
--      any row for a payment that has not been observed three times yet.
--      "Rent, monthly, starting next month" is exactly such a row.
--   2. "RecurringPattern_Confidence" is NOT NULL and constrained to 0..1.
--      Confidence is a property of an INFERENCE. An owner-declared schedule has
--      none — it is a stated fact, not a guess, and there is no honest value to
--      put there.
--   3. "RecurringPattern_NormalizedKey" is NOT NULL and unique per profile, and
--      is sha256(categoryId | vendor | description) computed from the expense
--      RECORDS (recurring.service.ts:33-36). A schedule declared before any
--      record exists has nothing to derive a key from.
--
-- Relaxing any of those three to make owner rows fit would weaken constraints
-- that currently protect the detector's data quality, for the benefit of rows
-- that are not detector output at all. Splitting the tables instead makes
-- "the detector never clobbers owner input" structural rather than a rule
-- somebody has to remember: the detector has no reason to write here.
--
-- "RecurringPattern" is NOT altered by this migration. No column is dropped, no
-- CHECK is changed, no row is deleted or modified.

CREATE TABLE public."RecurringSchedule" (
  "RecurringSchedule_ID" SERIAL NOT NULL,
  "BusinessProfile_ID" INTEGER NOT NULL,
  "Category_ID" INTEGER NOT NULL,
  "RecurringSchedule_Label" VARCHAR(255) NOT NULL,
  "RecurringSchedule_Vendor" VARCHAR(150),
  "RecurringSchedule_IntervalDays" INTEGER NOT NULL,
  "RecurringSchedule_ExpectedAmount" DECIMAL(18,2) NOT NULL,
  "RecurringSchedule_AmountTolerance" DECIMAL(8,6) NOT NULL DEFAULT 0.15,
  "RecurringSchedule_NextDueDate" DATE NOT NULL,
  "RecurringSchedule_LastRecordedDate" DATE,
  "RecurringSchedule_IsActive" BOOLEAN NOT NULL DEFAULT true,
  -- Provenance only: which inference, if any, suggested this schedule.
  "RecurringPattern_ID" INTEGER,
  "RecurringSchedule_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "RecurringSchedule_UpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringSchedule_pkey" PRIMARY KEY ("RecurringSchedule_ID"),
  CONSTRAINT "RecurringSchedule_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID")
    REFERENCES public."BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecurringSchedule_Category_ID_fkey" FOREIGN KEY ("Category_ID")
    REFERENCES public."ExpenseCategory"("Category_ID") ON DELETE CASCADE ON UPDATE CASCADE,
  -- SET NULL, not CASCADE, and this is the whole point of the split: deleting
  -- the detector's inference must never delete the owner's schedule. The
  -- schedule survives, it simply forgets which guess it came from.
  CONSTRAINT "RecurringSchedule_RecurringPattern_ID_fkey" FOREIGN KEY ("RecurringPattern_ID")
    REFERENCES public."RecurringPattern"("RecurringPattern_ID") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "RecurringSchedule_IntervalDays_check" CHECK ("RecurringSchedule_IntervalDays" > 0),
  CONSTRAINT "RecurringSchedule_ExpectedAmount_check" CHECK ("RecurringSchedule_ExpectedAmount" > 0),
  CONSTRAINT "RecurringSchedule_AmountTolerance_check" CHECK ("RecurringSchedule_AmountTolerance" >= 0 AND "RecurringSchedule_AmountTolerance" <= 1)
);

-- One pattern cannot spawn two schedules. Confirming twice must be idempotent
-- at the database level, not only in whichever service happens to call it.
CREATE UNIQUE INDEX "RecurringSchedule_RecurringPattern_ID_key"
  ON public."RecurringSchedule"("RecurringPattern_ID");
-- The agenda query: active schedules for one profile, ordered by due date.
CREATE INDEX "RecurringSchedule_BusinessProfile_ID_RecurringSchedule_IsAc_idx"
  ON public."RecurringSchedule"("BusinessProfile_ID", "RecurringSchedule_IsActive", "RecurringSchedule_NextDueDate");
CREATE INDEX "RecurringSchedule_Category_ID_idx" ON public."RecurringSchedule"("Category_ID");

-- Backfill: every pattern an owner already CONFIRMED becomes a schedule.
--
-- A confirmation is an owner having already said "watch this". Leaving those
-- behind would mean this migration quietly discards a decision a human made,
-- and the confirmed rows would stay exactly as invisible as they are today.
--
-- Written set-based rather than as literal INSERTs even though production holds
-- exactly one CONFIRMED pattern right now: that count is a fact about one
-- database on one day, not about the schema. Staging, a developer's container,
-- and a fresh test database each hold a different number, and a hard-coded row
-- would be silently wrong on all of them.
--
-- The NOT EXISTS makes a re-run a no-op rather than a unique-violation, and
-- carries "one pattern, one schedule" as intent alongside the index that
-- enforces it. Nothing here writes to "RecurringPattern".
--
-- The LEAST(..., 1) on the tolerance is load-bearing, do not simplify it away.
-- "RecurringPattern" has NO check on its tolerance, and inferRecurringPattern
-- computes it as Math.max(0.15, median(deviations) * 2)
-- (recurring.service.ts:54) — unbounded above, so a pattern whose median
-- deviation exceeds 0.5 stores a value greater than 1. This table constrains
-- the column to 0..1, and without the clamp such a row would abort the whole
-- migration. Clamping rather than widening the CHECK is deliberate: a tolerance
-- above 1 means "any amount whatsoever is acceptable", which is not a schedule
-- worth watching. No live row exceeds 0.36 today; that is a fact about one
-- database on one day, not a guarantee about the next one.
INSERT INTO public."RecurringSchedule" (
  "BusinessProfile_ID",
  "Category_ID",
  "RecurringSchedule_Label",
  "RecurringSchedule_Vendor",
  "RecurringSchedule_IntervalDays",
  "RecurringSchedule_ExpectedAmount",
  "RecurringSchedule_AmountTolerance",
  "RecurringSchedule_NextDueDate",
  "RecurringSchedule_LastRecordedDate",
  "RecurringSchedule_IsActive",
  "RecurringPattern_ID",
  "RecurringSchedule_CreatedAt",
  "RecurringSchedule_UpdatedAt"
)
SELECT
  pattern."BusinessProfile_ID",
  pattern."Category_ID",
  pattern."RecurringPattern_Description",
  pattern."RecurringPattern_Vendor",
  pattern."RecurringPattern_IntervalDays",
  pattern."RecurringPattern_ExpectedAmount",
  LEAST(pattern."RecurringPattern_AmountTolerance", 1),
  pattern."RecurringPattern_NextExpectedDate",
  pattern."RecurringPattern_LastOccurrence",
  true,
  pattern."RecurringPattern_ID",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM public."RecurringPattern" AS pattern
WHERE pattern."RecurringPattern_Status" = 'CONFIRMED'
  AND NOT EXISTS (
    SELECT 1
      FROM public."RecurringSchedule" AS existing
     WHERE existing."RecurringPattern_ID" = pattern."RecurringPattern_ID"
  );

-- Deny-all posture for the new table, matching every other application table
-- (see 20260806153854_secure_application_tables_from_data_api). All access goes
-- through the Express/Prisma connection; the Supabase Data API roles get
-- nothing. Guarded because those roles do not exist in the local test container.
ALTER TABLE public."RecurringSchedule" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public."RecurringSchedule" FROM anon;
    REVOKE ALL ON SEQUENCE public."RecurringSchedule_RecurringSchedule_ID_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public."RecurringSchedule" FROM authenticated;
    REVOKE ALL ON SEQUENCE public."RecurringSchedule_RecurringSchedule_ID_seq" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public."RecurringSchedule" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE public."RecurringSchedule_RecurringSchedule_ID_seq" TO service_role;
  END IF;
END $$;
