-- Stored provider outcome for a SUCCEEDED external dispatch.
--
-- A worker that died after a successful, billed provider call lost the
-- answer: the dispatch row read SUCCEEDED and the next attempt on the same
-- reservation key was refused. receiptProviderDispatch.service.ts now writes
-- the validated outcome here once billing settles and replays it on retry.
-- The service reads and writes it through the Prisma model; the startup
-- guard checks the table is present with row-level security and no policies.
--
-- Ownership semantics differ from the parent on purpose. The dispatch audit
-- row keeps only hashes and counts and survives a receipt purge with its scan
-- columns set to null (ON DELETE SET NULL). This row holds extracted receipt
-- content, so it cascades from the scan: purging the receipt deletes the
-- outcome while the audit row remains. Deleting the dispatch row itself (only
-- via the business-profile cascade) removes the outcome too.
--
-- No sequence: the primary key is the parent dispatch id.

-- CreateTable
CREATE TABLE "ExternalProviderDispatchOutcome" (
    "ExternalProviderDispatch_ID" INTEGER NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ReceiptScan_ID" INTEGER NOT NULL,
    "ReceiptScan_BusinessProfile_ID" INTEGER NOT NULL,
    "ExternalProviderDispatchOutcome_Outcome" JSONB NOT NULL,
    "ExternalProviderDispatchOutcome_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalProviderDispatchOutcome_pkey" PRIMARY KEY ("ExternalProviderDispatch_ID"),
    -- Same invariant ExternalProviderDispatch_receipt_scope_check enforces on
    -- the parent when its scan columns are populated.
    CONSTRAINT "ExternalProviderDispatchOutcome_receipt_scope_check" CHECK (
        "ReceiptScan_BusinessProfile_ID" = "BusinessProfile_ID"
    )
);

-- CreateIndex
CREATE INDEX "ExternalProviderDispatchOutcome_profile_idx" ON "ExternalProviderDispatchOutcome"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatchOutcome_receipt_idx" ON "ExternalProviderDispatchOutcome"("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID");

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatchOutcome" ADD CONSTRAINT "ExternalProviderDispatchOutcome_ExternalProviderDispatch_I_fkey" FOREIGN KEY ("ExternalProviderDispatch_ID") REFERENCES "ExternalProviderDispatch"("ExternalProviderDispatch_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatchOutcome" ADD CONSTRAINT "ExternalProviderDispatchOutcome_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatchOutcome" ADD CONSTRAINT "ExternalProviderDispatchOutcome_ReceiptScan_ID_ReceiptScan_fkey" FOREIGN KEY ("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny-all posture, matching 20260806153854 and 20260913075700: RLS on with
-- no policies, and no privileges for PUBLIC or the Supabase API roles. Only
-- the Express/Prisma connection reaches this table.
ALTER TABLE "ExternalProviderDispatchOutcome" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "ExternalProviderDispatchOutcome" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE "ExternalProviderDispatchOutcome" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
