-- User-level preferences, moved off per-device client storage.
--
-- The dashboard mascot toggle and the guided tour's progress are the same
-- preference wherever the owner signs in, so they belong to the account. Both
-- previously lived in localStorage (web) / SecureStore (mobile), which meant
-- finishing the tour on a laptop still offered it on a phone.
--
-- Additive only: every column is either defaulted to today's behaviour (the
-- mascot showed, nobody had the tour pinned open) or nullable, so existing
-- rows are unchanged and the clients keep working until their own updates
-- land. Theme is deliberately NOT stored here — it stays per-device.
--
-- No RLS block needed: "User" already has ROW LEVEL SECURITY enabled by
-- 20260806153854_secure_application_tables_from_data_api, and RLS plus the
-- REVOKE/ALTER DEFAULT PRIVILEGES in that migration are table-level, so new
-- columns inherit the deny-all posture without any further grant work.
ALTER TABLE "User"
  ADD COLUMN "User_ShowDashboardMascotMessage" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "User_TourStatus" VARCHAR(20),
  ADD COLUMN "User_TourStep" INTEGER,
  ADD COLUMN "User_TourAlwaysShow" BOOLEAN NOT NULL DEFAULT false;
