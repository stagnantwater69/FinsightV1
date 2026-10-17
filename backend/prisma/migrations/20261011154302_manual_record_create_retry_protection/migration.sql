-- CreateEnum
CREATE TYPE "ManualRecordKind" AS ENUM ('EXPENSE', 'SALES');

-- CreateTable
CREATE TABLE "ManualRecordCreateRequest" (
    "ManualRecordCreateRequest_KeyHash" CHAR(64) NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ManualRecordCreateRequest_Kind" "ManualRecordKind" NOT NULL,
    "ManualRecordCreateRequest_InputHash" CHAR(64) NOT NULL,
    "ExpenseRecord_ID" INTEGER,
    "ExpenseRecord_BusinessProfile_ID" INTEGER,
    "SalesReferenceRecord_ID" INTEGER,
    "SalesReferenceRecord_BusinessProfile_ID" INTEGER,
    "ManualRecordCreateRequest_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualRecordCreateRequest_pkey" PRIMARY KEY ("ManualRecordCreateRequest_KeyHash")
);

-- CreateIndex
CREATE INDEX "ManualRecordCreateRequest_profile_idx" ON "ManualRecordCreateRequest"("BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "ManualRecordCreateRequest_expense_key" ON "ManualRecordCreateRequest"("ExpenseRecord_ID", "ExpenseRecord_BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "ManualRecordCreateRequest_sales_key" ON "ManualRecordCreateRequest"("SalesReferenceRecord_ID", "SalesReferenceRecord_BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReferenceRecord_ID_BusinessProfile_ID_key" ON "SalesReferenceRecord"("SalesReferenceRecord_ID", "BusinessProfile_ID");

-- AddForeignKey
ALTER TABLE "ManualRecordCreateRequest" ADD CONSTRAINT "ManualRecordCreateRequest_profile_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualRecordCreateRequest" ADD CONSTRAINT "ManualRecordCreateRequest_expense_fkey" FOREIGN KEY ("ExpenseRecord_ID", "ExpenseRecord_BusinessProfile_ID") REFERENCES "ExpenseRecord"("ExpenseRecord_ID", "BusinessProfile_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualRecordCreateRequest" ADD CONSTRAINT "ManualRecordCreateRequest_sales_fkey" FOREIGN KEY ("SalesReferenceRecord_ID", "SalesReferenceRecord_BusinessProfile_ID") REFERENCES "SalesReferenceRecord"("SalesReferenceRecord_ID", "BusinessProfile_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- Null link pairs retain a deleted record's request; populated pairs must match its kind and business.
ALTER TABLE "ManualRecordCreateRequest"
    ADD CONSTRAINT "ManualRecordCreateRequest_expense_scope_check" CHECK (
        ("ExpenseRecord_ID" IS NULL AND "ExpenseRecord_BusinessProfile_ID" IS NULL)
        OR (
            "ExpenseRecord_ID" IS NOT NULL
            AND "ExpenseRecord_BusinessProfile_ID" IS NOT NULL
            AND "ManualRecordCreateRequest_Kind" = 'EXPENSE'
            AND "ExpenseRecord_BusinessProfile_ID" = "BusinessProfile_ID"
        )
    ),
    ADD CONSTRAINT "ManualRecordCreateRequest_sales_scope_check" CHECK (
        ("SalesReferenceRecord_ID" IS NULL AND "SalesReferenceRecord_BusinessProfile_ID" IS NULL)
        OR (
            "SalesReferenceRecord_ID" IS NOT NULL
            AND "SalesReferenceRecord_BusinessProfile_ID" IS NOT NULL
            AND "ManualRecordCreateRequest_Kind" = 'SALES'
            AND "SalesReferenceRecord_BusinessProfile_ID" = "BusinessProfile_ID"
        )
    );

-- Application tables are accessible through Express/Prisma only; no client-role policies or grants.
ALTER TABLE public."ManualRecordCreateRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."ManualRecordCreateRequest" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public."ManualRecordCreateRequest" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;

