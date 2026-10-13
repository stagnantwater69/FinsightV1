-- AlterTable
ALTER TABLE "ExternalProviderDispatch" ADD COLUMN     "ExternalProviderDispatch_ProviderRetryAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_provider_completed_idx" ON "ExternalProviderDispatch"("ExternalProviderDispatch_Provider", "ExternalProviderDispatch_ProviderVersion", "ExternalProviderDispatch_ProviderRegion", "ExternalProviderDispatch_CompletedAt");
