-- Recovery Target plan §7.5 / §10.8 / §11 Phase 6 — notification
-- preferences, per-trigger cooldown/dedup state, and an optional saved
-- Recovery Plan. Purely additive; does not touch any existing Recovery
-- Target calculation table or column:
--   * RecoveryNotificationPreference (one row per BusinessProfile) holds the
--     five per-trigger opt-in switches from §10.8's candidate-trigger list,
--     a configured threshold for the target-increase trigger, quiet hours
--     as bare local TIME-of-day values (resolved against the existing
--     BusinessProfile.timezone — no second timezone field), and a
--     frequency/cooldown cap in hours. Missing row = every trigger enabled,
--     no quiet hours, default cooldown.
--   * RecoveryNotificationTriggerState (one row per BusinessProfile x
--     trigger) is the durable last-fired state that makes generation
--     idempotent, per §11's "generate notifications durably and
--     idempotently... do not use in-memory scheduling". Deliberately
--     separate from the existing Notification table: that table already
--     covers stable-message dedup and simple time-window cooldown (see
--     recurring.service.ts's notifyScheduleFinding), but has no queryable
--     structured value, which some of these five triggers need to detect a
--     NEW condition (e.g. the adjusted daily target's value at the last
--     fire) rather than a repeat of an old one.
--   * RecoveryPlan is added exactly per §7.5's proposed shape. It is a
--     separate, owner-visible saved artifact and MUST NEVER be read by
--     computeRecoveryTarget/getRecoveryInsight or any live calculation
--     (§10.7/§13.2) — enforced at the service layer, not by this schema.
--
-- All three tables get deny-all RLS, matching every other application
-- table (20260806153854_secure_application_tables_from_data_api).

-- CreateEnum
CREATE TYPE "RecoveryNotificationTrigger" AS ENUM ('TARGET_INCREASE', 'BEHIND_THREE_DAYS', 'OPEN_DAY_NO_SALES', 'PROJECTION_SHORTFALL', 'COVERAGE_REACHED');

-- CreateTable
CREATE TABLE "RecoveryNotificationPreference" (
    "RecoveryNotificationPreference_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "RecoveryNotificationPreference_TargetIncreaseAlertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "RecoveryNotificationPreference_TargetIncreaseThresholdPercent" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "RecoveryNotificationPreference_BehindThreeDaysAlertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "RecoveryNotificationPreference_OpenDayNoSalesAlertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "RecoveryNotificationPreference_ProjectionShortfallAlertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "RecoveryNotificationPreference_CoverageReachedAlertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "RecoveryNotificationPreference_QuietHoursStart" TIME(0),
    "RecoveryNotificationPreference_QuietHoursEnd" TIME(0),
    "RecoveryNotificationPreference_MinHoursBetweenNotifications" INTEGER NOT NULL DEFAULT 24,
    "RecoveryNotificationPreference_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "RecoveryNotificationPreference_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryNotificationPreference_pkey" PRIMARY KEY ("RecoveryNotificationPreference_ID")
);

-- CreateTable
CREATE TABLE "RecoveryNotificationTriggerState" (
    "RecoveryNotificationTriggerState_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "RecoveryNotificationTriggerState_Trigger" "RecoveryNotificationTrigger" NOT NULL,
    "RecoveryNotificationTriggerState_LastEvaluatedAt" TIMESTAMP(3),
    "RecoveryNotificationTriggerState_LastFiredAt" TIMESTAMP(3),
    "RecoveryNotificationTriggerState_LastFiredValue" DECIMAL(12,2),
    "RecoveryNotificationTriggerState_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "RecoveryNotificationTriggerState_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryNotificationTriggerState_pkey" PRIMARY KEY ("RecoveryNotificationTriggerState_ID")
);

-- CreateTable
CREATE TABLE "RecoveryPlan" (
    "RecoveryPlan_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "RecoveryPlan_Month" DATE NOT NULL,
    "RecoveryPlan_BufferPercent" DECIMAL(5,2),
    "RecoveryPlan_Deadline" DATE,
    "RecoveryPlan_OwnerTargetAmount" DECIMAL(12,2),
    "RecoveryPlan_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "RecoveryPlan_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryPlan_pkey" PRIMARY KEY ("RecoveryPlan_ID")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryNotificationPreference_BusinessProfile_ID_key" ON "RecoveryNotificationPreference"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "RecoveryNotificationTriggerState_profile_idx" ON "RecoveryNotificationTriggerState"("BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryNotificationTriggerState_profile_trigger_key" ON "RecoveryNotificationTriggerState"("BusinessProfile_ID", "RecoveryNotificationTriggerState_Trigger");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPlan_profile_month_key" ON "RecoveryPlan"("BusinessProfile_ID", "RecoveryPlan_Month");

-- AddForeignKey
ALTER TABLE "RecoveryNotificationPreference" ADD CONSTRAINT "RecoveryNotificationPreference_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryNotificationTriggerState" ADD CONSTRAINT "RecoveryNotificationTriggerState_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny-all RLS, matching every other application table (see
-- 20260806153854_secure_application_tables_from_data_api / docs/SECURITY.md
-- and 20260830132310_business_operating_schedule_and_overrides for the same
-- pattern on the other Recovery Target tables). Only the backend's
-- Express/Prisma "postgres" role connection reads these tables;
-- anon/authenticated Supabase Data API roles get nothing.
ALTER TABLE "RecoveryNotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryNotificationTriggerState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryPlan" ENABLE ROW LEVEL SECURITY;

