-- Expense Reduction Opportunities plan §15 Phase 5 — lightweight
-- helpful/not-relevant feedback on a reduction-opportunity card. v1 does not
-- persist opportunity rows (plan §17), so this table is keyed to the
-- opportunity's computed, non-persisted id (the
-- `${type}-${categoryId}-${periodEndKey}` string produced by
-- computeReductionOpportunities in reductionOpportunity.service.ts), not a
-- foreign key into a stored opportunities table.
--
-- One row per (business profile, opportunity, user): a resubmission should
-- upsert onto the unique constraint below rather than accumulate duplicate
-- rows, since this is a "what do you think right now" signal, not an
-- append-only log.

-- CreateEnum
CREATE TYPE "ReductionOpportunityFeedbackRating" AS ENUM ('HELPFUL', 'NOT_RELEVANT');

-- CreateTable
CREATE TABLE "ReductionOpportunityFeedback" (
    "ReductionOpportunityFeedback_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "ReductionOpportunityFeedback_OpportunityID" VARCHAR(150) NOT NULL,
    "ReductionOpportunityFeedback_Rating" "ReductionOpportunityFeedbackRating" NOT NULL,
    "ReductionOpportunityFeedback_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReductionOpportunityFeedback_pkey" PRIMARY KEY ("ReductionOpportunityFeedback_ID")
);

-- CreateIndex
CREATE INDEX "ReductionOpportunityFeedback_profile_opportunity_idx" ON "ReductionOpportunityFeedback"("BusinessProfile_ID", "ReductionOpportunityFeedback_OpportunityID");

-- CreateIndex
CREATE UNIQUE INDEX "ReductionOpportunityFeedback_profile_opportunity_user_key" ON "ReductionOpportunityFeedback"("BusinessProfile_ID", "ReductionOpportunityFeedback_OpportunityID", "User_ID");

-- AddForeignKey
ALTER TABLE "ReductionOpportunityFeedback" ADD CONSTRAINT "ReductionOpportunityFeedback_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReductionOpportunityFeedback" ADD CONSTRAINT "ReductionOpportunityFeedback_User_ID_fkey" FOREIGN KEY ("User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny-all RLS, matching every other application table (see
-- 20260806153854_secure_application_tables_from_data_api / docs/SECURITY.md).
-- Only the backend's Express/Prisma "postgres" role connection reads this
-- table; anon/authenticated Supabase Data API roles get nothing.
ALTER TABLE "ReductionOpportunityFeedback" ENABLE ROW LEVEL SECURITY;
