-- Consent provenance (PR 2 review, device finding 5).
--
-- RECEIPT_PROVIDER_CONSENT_MODE=automatic records a consent row on first
-- dispatch, granted by operator policy rather than by the owner; the row
-- could not say which. Every existing row predates automatic mode and was
-- granted in-app, so default and backfill are both OWNER. RLS on the table
-- is table-level (20260913075700), so the column inherits deny-all.

-- CreateEnum
CREATE TYPE "ExternalProcessingConsentSource" AS ENUM ('OWNER', 'OPERATOR_POLICY');

-- AlterTable
ALTER TABLE "ExternalProcessingConsent"
    ADD COLUMN "ExternalProcessingConsent_Source" "ExternalProcessingConsentSource" NOT NULL DEFAULT 'OWNER';
