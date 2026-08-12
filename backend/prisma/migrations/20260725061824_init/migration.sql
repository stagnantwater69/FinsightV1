-- CreateEnum
CREATE TYPE "ExpenseRecordSource" AS ENUM ('Manual Entry', 'CSV Upload', 'Receipt Scan');

-- CreateEnum
CREATE TYPE "SalesRecordSource" AS ENUM ('Manual Entry', 'CSV Upload');

-- CreateTable
CREATE TABLE "User" (
    "User_ID" SERIAL NOT NULL,
    "User_AuthID" UUID NOT NULL,
    "User_FirstName" VARCHAR(100) NOT NULL,
    "User_MiddleName" VARCHAR(100),
    "User_LastName" VARCHAR(100) NOT NULL,
    "User_Email" VARCHAR(150) NOT NULL,
    "User_PhoneNumber" VARCHAR(20),
    "User_Status" VARCHAR(50) NOT NULL DEFAULT 'Active',
    "User_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("User_ID")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "BusinessProfile_ID" SERIAL NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "BusinessProfile_Name" VARCHAR(150) NOT NULL,
    "BusinessProfile_Type" VARCHAR(100) NOT NULL,
    "BusinessProfile_AvailableFunds" DECIMAL(12,2) NOT NULL,
    "BusinessProfile_ExpectedMonthlyExpenses" DECIMAL(12,2) NOT NULL,
    "BusinessProfile_OperatingDays" INTEGER NOT NULL,
    "BusinessProfile_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("BusinessProfile_ID")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "Category_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "Category_Name" VARCHAR(100) NOT NULL,
    "Category_Description" VARCHAR(255),
    "Category_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("Category_ID")
);

-- CreateTable
CREATE TABLE "ExpenseRecord" (
    "ExpenseRecord_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "Category_ID" INTEGER NOT NULL,
    "ReceiptScan_ID" INTEGER,
    "ImportBatch_ID" INTEGER,
    "DuplicateOf_RecordID" INTEGER,
    "ExpenseRecord_Date" DATE NOT NULL,
    "ExpenseRecord_Description" VARCHAR(255) NOT NULL,
    "ExpenseRecord_Vendor" VARCHAR(150),
    "ExpenseRecord_Amount" DECIMAL(12,2) NOT NULL,
    "ExpenseRecord_Source" "ExpenseRecordSource" NOT NULL,
    "ExpenseRecord_ReviewStatus" VARCHAR(50) NOT NULL DEFAULT 'Needs Review',
    "ExpenseRecord_DuplicateStatus" VARCHAR(50) NOT NULL DEFAULT 'Not a Duplicate',
    "ExpenseRecord_LargeExpenseFlag" BOOLEAN NOT NULL DEFAULT false,
    "ExpenseRecord_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseRecord_pkey" PRIMARY KEY ("ExpenseRecord_ID")
);

-- CreateTable
CREATE TABLE "SalesReferenceRecord" (
    "SalesReferenceRecord_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ImportBatch_ID" INTEGER,
    "DuplicateOf_RecordID" INTEGER,
    "SalesReferenceRecord_Date" DATE NOT NULL,
    "SalesReferenceRecord_Description" VARCHAR(255) NOT NULL,
    "SalesReferenceRecord_Amount" DECIMAL(12,2) NOT NULL,
    "SalesReferenceRecord_Source" "SalesRecordSource" NOT NULL,
    "SalesReferenceRecord_ReviewStatus" VARCHAR(50) NOT NULL DEFAULT 'Needs Review',
    "SalesReferenceRecord_DuplicateStatus" VARCHAR(50) NOT NULL DEFAULT 'Not a Duplicate',
    "SalesReferenceRecord_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesReferenceRecord_pkey" PRIMARY KEY ("SalesReferenceRecord_ID")
);

-- CreateTable
CREATE TABLE "ReceiptScan" (
    "ReceiptScan_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER,
    "ReceiptScan_ImageFile" VARCHAR(255) NOT NULL,
    "ReceiptScan_ExtractedDate" DATE,
    "ReceiptScan_ExtractedVendor" VARCHAR(150),
    "ReceiptScan_ExtractedDescription" VARCHAR(255),
    "ReceiptScan_ExtractedAmount" DECIMAL(12,2),
    "ReceiptScan_ConfirmationStatus" VARCHAR(50) NOT NULL DEFAULT 'Pending',
    "ReceiptScan_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptScan_pkey" PRIMARY KEY ("ReceiptScan_ID")
);

-- CreateTable
CREATE TABLE "CSVImportBatch" (
    "ImportBatch_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ImportBatch_Title" VARCHAR(150) NOT NULL,
    "ImportBatch_UploadDate" DATE NOT NULL,
    "ImportBatch_FileReference" VARCHAR(255) NOT NULL,
    "ImportBatch_Status" VARCHAR(50) NOT NULL DEFAULT 'Needs Review',
    "ImportBatch_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CSVImportBatch_pkey" PRIMARY KEY ("ImportBatch_ID")
);

-- CreateTable
CREATE TABLE "Notification" (
    "Notification_ID" SERIAL NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "Notification_Message" VARCHAR(255) NOT NULL,
    "Notification_Type" VARCHAR(50) NOT NULL,
    "Notification_DateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Notification_ReadStatus" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("Notification_ID")
);

-- CreateTable
CREATE TABLE "AIInteraction" (
    "Interaction_ID" SERIAL NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "Interaction_Module" VARCHAR(50) NOT NULL,
    "Interaction_Question" VARCHAR(500) NOT NULL,
    "Interaction_AIResponse" VARCHAR(1000) NOT NULL,
    "Interaction_Timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIInteraction_pkey" PRIMARY KEY ("Interaction_ID")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_User_AuthID_key" ON "User"("User_AuthID");

-- CreateIndex
CREATE UNIQUE INDEX "User_User_Email_key" ON "User"("User_Email");

-- CreateIndex
CREATE INDEX "BusinessProfile_User_ID_idx" ON "BusinessProfile"("User_ID");

-- CreateIndex
CREATE INDEX "ExpenseCategory_BusinessProfile_ID_idx" ON "ExpenseCategory"("BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseRecord_ReceiptScan_ID_key" ON "ExpenseRecord"("ReceiptScan_ID");

-- CreateIndex
CREATE INDEX "ExpenseRecord_BusinessProfile_ID_idx" ON "ExpenseRecord"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "ExpenseRecord_Category_ID_idx" ON "ExpenseRecord"("Category_ID");

-- CreateIndex
CREATE INDEX "ExpenseRecord_ImportBatch_ID_idx" ON "ExpenseRecord"("ImportBatch_ID");

-- CreateIndex
CREATE INDEX "SalesReferenceRecord_BusinessProfile_ID_idx" ON "SalesReferenceRecord"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "SalesReferenceRecord_ImportBatch_ID_idx" ON "SalesReferenceRecord"("ImportBatch_ID");

-- CreateIndex
CREATE INDEX "ReceiptScan_BusinessProfile_ID_idx" ON "ReceiptScan"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "CSVImportBatch_BusinessProfile_ID_idx" ON "CSVImportBatch"("BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "Notification_User_ID_idx" ON "Notification"("User_ID");

-- CreateIndex
CREATE INDEX "AIInteraction_User_ID_idx" ON "AIInteraction"("User_ID");

-- CreateIndex
CREATE INDEX "AIInteraction_BusinessProfile_ID_idx" ON "AIInteraction"("BusinessProfile_ID");

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_User_ID_fkey" FOREIGN KEY ("User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRecord" ADD CONSTRAINT "ExpenseRecord_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRecord" ADD CONSTRAINT "ExpenseRecord_Category_ID_fkey" FOREIGN KEY ("Category_ID") REFERENCES "ExpenseCategory"("Category_ID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRecord" ADD CONSTRAINT "ExpenseRecord_ReceiptScan_ID_fkey" FOREIGN KEY ("ReceiptScan_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRecord" ADD CONSTRAINT "ExpenseRecord_ImportBatch_ID_fkey" FOREIGN KEY ("ImportBatch_ID") REFERENCES "CSVImportBatch"("ImportBatch_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRecord" ADD CONSTRAINT "ExpenseRecord_DuplicateOf_RecordID_fkey" FOREIGN KEY ("DuplicateOf_RecordID") REFERENCES "ExpenseRecord"("ExpenseRecord_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReferenceRecord" ADD CONSTRAINT "SalesReferenceRecord_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReferenceRecord" ADD CONSTRAINT "SalesReferenceRecord_ImportBatch_ID_fkey" FOREIGN KEY ("ImportBatch_ID") REFERENCES "CSVImportBatch"("ImportBatch_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReferenceRecord" ADD CONSTRAINT "SalesReferenceRecord_DuplicateOf_RecordID_fkey" FOREIGN KEY ("DuplicateOf_RecordID") REFERENCES "SalesReferenceRecord"("SalesReferenceRecord_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptScan" ADD CONSTRAINT "ReceiptScan_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CSVImportBatch" ADD CONSTRAINT "CSVImportBatch_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_User_ID_fkey" FOREIGN KEY ("User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIInteraction" ADD CONSTRAINT "AIInteraction_User_ID_fkey" FOREIGN KEY ("User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIInteraction" ADD CONSTRAINT "AIInteraction_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;
