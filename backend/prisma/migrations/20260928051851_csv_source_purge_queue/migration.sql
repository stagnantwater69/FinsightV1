-- CreateEnum
CREATE TYPE "CsvSourcePurgeStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "CSVSourcePurgeJob" (
    "CSVSourcePurgeJob_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ImportBatch_ID" INTEGER NOT NULL,
    "CSVSourcePurgeJob_TargetHash" CHAR(64) NOT NULL,
    "CSVSourcePurgeJob_FileReference" VARCHAR(255),
    "CSVSourcePurgeJob_Status" "CsvSourcePurgeStatus" NOT NULL DEFAULT 'PENDING',
    "CSVSourcePurgeJob_AttemptCount" INTEGER NOT NULL DEFAULT 0,
    "CSVSourcePurgeJob_NextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "CSVSourcePurgeJob_LeaseStartedAt" TIMESTAMP(3),
    "CSVSourcePurgeJob_HeartbeatAt" TIMESTAMP(3),
    "CSVSourcePurgeJob_WorkerID" VARCHAR(100),
    "CSVSourcePurgeJob_LastErrorCode" VARCHAR(64),
    "CSVSourcePurgeJob_RequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "CSVSourcePurgeJob_CompletedAt" TIMESTAMP(3),
    "CSVSourcePurgeJob_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CSVSourcePurgeJob_pkey" PRIMARY KEY ("CSVSourcePurgeJob_ID"),
    CONSTRAINT "CSVSourcePurgeJob_AttemptCount_check" CHECK ("CSVSourcePurgeJob_AttemptCount" >= 0),
    CONSTRAINT "CSVSourcePurgeJob_completion_check" CHECK (
        (
            "CSVSourcePurgeJob_Status" = 'COMPLETE'
            AND "CSVSourcePurgeJob_FileReference" IS NULL
            AND "CSVSourcePurgeJob_CompletedAt" IS NOT NULL
        )
        OR
        (
            "CSVSourcePurgeJob_Status" <> 'COMPLETE'
            AND "CSVSourcePurgeJob_FileReference" IS NOT NULL
            AND "CSVSourcePurgeJob_CompletedAt" IS NULL
        )
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "CSVSourcePurgeJob_CSVSourcePurgeJob_TargetHash_key" ON "CSVSourcePurgeJob"("CSVSourcePurgeJob_TargetHash");

-- CreateIndex
CREATE INDEX "CSVSourcePurgeJob_claim_idx" ON "CSVSourcePurgeJob"("CSVSourcePurgeJob_Status", "CSVSourcePurgeJob_NextAttemptAt", "CSVSourcePurgeJob_HeartbeatAt");

-- CreateIndex
CREATE INDEX "CSVSourcePurgeJob_status_requested_idx" ON "CSVSourcePurgeJob"("CSVSourcePurgeJob_Status", "CSVSourcePurgeJob_RequestedAt");

-- CreateIndex
CREATE INDEX "CSVSourcePurgeJob_profile_status_requested_idx" ON "CSVSourcePurgeJob"("BusinessProfile_ID", "CSVSourcePurgeJob_Status", "CSVSourcePurgeJob_RequestedAt");

ALTER TABLE "CSVSourcePurgeJob" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "CSVSourcePurgeJob" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE "CSVSourcePurgeJob_CSVSourcePurgeJob_ID_seq" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE "CSVSourcePurgeJob" FROM %I',
                api_role
            );
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE "CSVSourcePurgeJob_CSVSourcePurgeJob_ID_seq" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
