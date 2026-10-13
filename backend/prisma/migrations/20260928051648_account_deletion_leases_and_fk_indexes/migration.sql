-- DropIndex
DROP INDEX "User_DeletionQueue_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "User_DeletionClaimVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "User_DeletionHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "User_DeletionLeaseStartedAt" TIMESTAMP(3),
ADD COLUMN     "User_DeletionNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "User_DeletionStorageCheckpoint" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "User_DeletionStorageManifestHash" CHAR(64),
ADD COLUMN     "User_DeletionWorkerID" VARCHAR(100);

-- CreateIndex
CREATE INDEX "AuthHandoff_User_ID_idx" ON "AuthHandoff"("AuthHandoff_User_ID");

-- CreateIndex
CREATE INDEX "Conversation_BusinessProfile_ID_idx" ON "Conversation"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "ReductionOpportunityFeedback_User_ID_idx" ON "ReductionOpportunityFeedback"("User_ID");

-- CreateIndex
CREATE INDEX "User_DeletionQueue_idx" ON "User"("User_Status", "User_DeletionNextAttemptAt", "User_DeletionRequestedAt", "User_ID");
