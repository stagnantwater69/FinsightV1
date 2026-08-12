/*
  Warnings:

  - Added the required column `BusinessProfile_ID` to the `Notification` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "BusinessProfile_ID" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "Notification_BusinessProfile_ID_idx" ON "Notification"("BusinessProfile_ID");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;
