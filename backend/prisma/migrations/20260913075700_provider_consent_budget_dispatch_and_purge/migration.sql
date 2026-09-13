-- PostgreSQL grants EXECUTE on new functions to PUBLIC globally by default.
-- A schema-local revoke cannot override that global default, so remove it at
-- the owner level before any future application function can be created.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Keep every object owner used by FinSight deny-by-default when the migration
-- role is authorized to change that owner's defaults.
DO $$
DECLARE
    owner_role TEXT;
    api_role TEXT;
    owner_is_authorized BOOLEAN;
BEGIN
    FOR owner_role IN
        SELECT DISTINCT role_name
        FROM unnest(ARRAY[current_user, 'postgres', 'supabase_admin']) AS role_name
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
            CONTINUE;
        END IF;

        SELECT owner_role = current_user
            OR pg_has_role(current_user, owner_role, 'MEMBER')
            OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
        INTO owner_is_authorized;

        IF NOT owner_is_authorized THEN
            CONTINUE;
        END IF;

        IF owner_role <> current_user THEN
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
                owner_role
            );
        END IF;

        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
        LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
                EXECUTE format(
                    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
                    owner_role,
                    api_role
                );
                EXECUTE format(
                    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
                    owner_role,
                    api_role
                );
                EXECUTE format(
                    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I',
                    owner_role,
                    api_role
                );
            END IF;
        END LOOP;
    END LOOP;
END
$$;

-- CreateEnum
CREATE TYPE "ExternalProcessingDataClass" AS ENUM ('RECEIPT_IMAGE', 'DERIVED_RECEIPT_IMAGE');

-- CreateEnum
CREATE TYPE "ExternalProcessingPurpose" AS ENUM ('RECEIPT_EXTRACTION');

-- CreateEnum
CREATE TYPE "ExternalProviderBudgetScope" AS ENUM ('RESOURCE', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ExternalProviderUnitType" AS ENUM ('PAGE', 'DOCUMENT', 'IMAGE_FEATURE');

-- CreateEnum
CREATE TYPE "ExternalProviderDispatchStatus" AS ENUM ('RESERVED', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'AMBIGUOUS');

-- CreateEnum
CREATE TYPE "ReceiptPurgeReason" AS ENUM ('OWNER_REQUEST', 'ABANDONED_SCAN', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "ReceiptPurgeStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ReceiptPurgeStage" AS ENUM ('STORAGE', 'DATABASE', 'COMPLETE');

-- AlterTable
ALTER TABLE "ReceiptScan" ADD COLUMN     "ReceiptScan_ProcessingErrorCode" VARCHAR(64);

ALTER TABLE "ReceiptScan"
    ADD CONSTRAINT "ReceiptScan_ProcessingErrorCode_check"
    CHECK (
        "ReceiptScan_ProcessingErrorCode" IS NULL
        OR "ReceiptScan_ProcessingErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'
    );

-- CreateTable
CREATE TABLE "ExternalProcessingConsent" (
    "ExternalProcessingConsent_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "ExternalProcessingConsent_Provider" VARCHAR(64) NOT NULL,
    "ExternalProcessingConsent_PolicyVersion" VARCHAR(64) NOT NULL,
    "ExternalProcessingConsent_Purpose" "ExternalProcessingPurpose" NOT NULL,
    "ExternalProcessingConsent_AllowedDataClasses" "ExternalProcessingDataClass"[] NOT NULL,
    "ExternalProcessingConsent_ProcessingRegion" VARCHAR(64) NOT NULL,
    "ExternalProcessingConsent_ProviderRetentionHours" INTEGER NOT NULL,
    "ExternalProcessingConsent_ProviderTrainingAllowed" BOOLEAN NOT NULL DEFAULT false,
    "ExternalProcessingConsent_GrantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ExternalProcessingConsent_RevokedAt" TIMESTAMP(3),
    "ExternalProcessingConsent_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ExternalProcessingConsent_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalProcessingConsent_pkey" PRIMARY KEY ("ExternalProcessingConsent_ID"),
    CONSTRAINT "ExternalProcessingConsent_provider_check" CHECK (
        "ExternalProcessingConsent_Provider" ~ '^[a-z][a-z0-9_-]{0,63}$'
    ),
    CONSTRAINT "ExternalProcessingConsent_policy_version_check" CHECK (
        btrim("ExternalProcessingConsent_PolicyVersion") <> ''
    ),
    CONSTRAINT "ExternalProcessingConsent_data_classes_check" CHECK (
        cardinality("ExternalProcessingConsent_AllowedDataClasses") BETWEEN 1 AND 2
        AND array_position("ExternalProcessingConsent_AllowedDataClasses", NULL) IS NULL
        AND array_ndims("ExternalProcessingConsent_AllowedDataClasses") = 1
        AND array_lower("ExternalProcessingConsent_AllowedDataClasses", 1) = 1
        AND (
            cardinality("ExternalProcessingConsent_AllowedDataClasses") = 1
            OR "ExternalProcessingConsent_AllowedDataClasses"[1]
                <> "ExternalProcessingConsent_AllowedDataClasses"[2]
        )
    ),
    CONSTRAINT "ExternalProcessingConsent_region_check" CHECK (
        btrim("ExternalProcessingConsent_ProcessingRegion") <> ''
    ),
    CONSTRAINT "ExternalProcessingConsent_retention_check" CHECK (
        "ExternalProcessingConsent_ProviderRetentionHours" BETWEEN 0 AND 8760
    ),
    CONSTRAINT "ExternalProcessingConsent_training_check" CHECK (
        NOT "ExternalProcessingConsent_ProviderTrainingAllowed"
    ),
    CONSTRAINT "ExternalProcessingConsent_revoked_check" CHECK (
        "ExternalProcessingConsent_RevokedAt" IS NULL
        OR "ExternalProcessingConsent_RevokedAt" >= "ExternalProcessingConsent_GrantedAt"
    )
);

-- CreateTable
CREATE TABLE "ExternalProviderBudget" (
    "ExternalProviderBudget_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER,
    "ExternalProviderBudget_Scope" "ExternalProviderBudgetScope" NOT NULL,
    "ExternalProviderBudget_Provider" VARCHAR(64) NOT NULL,
    "ExternalProviderBudget_UnitType" "ExternalProviderUnitType" NOT NULL,
    "ExternalProviderBudget_CycleStart" DATE NOT NULL,
    "ExternalProviderBudget_CycleEnd" DATE NOT NULL,
    "ExternalProviderBudget_LimitUnits" INTEGER NOT NULL DEFAULT 0,
    "ExternalProviderBudget_ReservedUnits" INTEGER NOT NULL DEFAULT 0,
    "ExternalProviderBudget_UsedUnits" INTEGER NOT NULL DEFAULT 0,
    "ExternalProviderBudget_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ExternalProviderBudget_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalProviderBudget_pkey" PRIMARY KEY ("ExternalProviderBudget_ID"),
    CONSTRAINT "ExternalProviderBudget_scope_check" CHECK (
        ("ExternalProviderBudget_Scope" = 'RESOURCE' AND "BusinessProfile_ID" IS NULL)
        OR ("ExternalProviderBudget_Scope" = 'BUSINESS' AND "BusinessProfile_ID" IS NOT NULL)
    ),
    CONSTRAINT "ExternalProviderBudget_provider_check" CHECK (
        "ExternalProviderBudget_Provider" ~ '^[a-z][a-z0-9_-]{0,63}$'
    ),
    CONSTRAINT "ExternalProviderBudget_cycle_check" CHECK (
        EXTRACT(DAY FROM "ExternalProviderBudget_CycleStart") = 1
        AND "ExternalProviderBudget_CycleEnd" =
            ("ExternalProviderBudget_CycleStart" + INTERVAL '1 month')::date
    ),
    CONSTRAINT "ExternalProviderBudget_units_check" CHECK (
        "ExternalProviderBudget_LimitUnits" >= 0
        AND "ExternalProviderBudget_ReservedUnits" >= 0
        AND "ExternalProviderBudget_UsedUnits" >= 0
        AND "ExternalProviderBudget_ReservedUnits"
            <= "ExternalProviderBudget_LimitUnits" - "ExternalProviderBudget_UsedUnits"
    )
);

-- CreateTable
CREATE TABLE "ExternalProviderDispatch" (
    "ExternalProviderDispatch_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ReceiptScan_ID" INTEGER,
    "ReceiptScan_BusinessProfile_ID" INTEGER,
    "ExternalProcessingConsent_ID" INTEGER NOT NULL,
    "ExternalProviderDispatch_ResourceBudget_ID" INTEGER NOT NULL,
    "ExternalProviderDispatch_ResourceBudgetScope" "ExternalProviderBudgetScope" NOT NULL DEFAULT 'RESOURCE',
    "ExternalProviderDispatch_BusinessBudget_ID" INTEGER,
    "ExternalProviderDispatch_BusinessBudgetScope" "ExternalProviderBudgetScope",
    "ExternalProviderDispatch_BusinessBudgetProfile_ID" INTEGER,
    "ExternalProviderDispatch_Provider" VARCHAR(64) NOT NULL,
    "ExternalProviderDispatch_ProviderVersion" VARCHAR(96) NOT NULL,
    "ExternalProviderDispatch_ProviderRegion" VARCHAR(64) NOT NULL,
    "ExternalProviderDispatch_UnitType" "ExternalProviderUnitType" NOT NULL,
    "ExternalProviderDispatch_CycleStart" DATE NOT NULL,
    "ExternalProviderDispatch_ReservationKeyHash" CHAR(64) NOT NULL,
    "ExternalProviderDispatch_InputHash" CHAR(64) NOT NULL,
    "ExternalProviderDispatch_ProviderRequestIDHash" CHAR(64),
    "ExternalProviderDispatch_PreprocessingVersion" VARCHAR(64) NOT NULL,
    "ExternalProviderDispatch_SchemaVersion" VARCHAR(64) NOT NULL,
    "ExternalProviderDispatch_RescueReasonCode" VARCHAR(64) NOT NULL,
    "ExternalProviderDispatch_ReservedUnits" INTEGER NOT NULL,
    "ExternalProviderDispatch_FinalBillableUnits" INTEGER,
    "ExternalProviderDispatch_PageCount" INTEGER NOT NULL,
    "ExternalProviderDispatch_DocumentCount" INTEGER NOT NULL DEFAULT 1,
    "ExternalProviderDispatch_EstimatedCostMicros" BIGINT,
    "ExternalProviderDispatch_LatencyMs" INTEGER,
    "ExternalProviderDispatch_Status" "ExternalProviderDispatchStatus" NOT NULL DEFAULT 'RESERVED',
    "ExternalProviderDispatch_OutcomeCode" VARCHAR(64),
    "ExternalProviderDispatch_SubmittedAt" TIMESTAMP(3),
    "ExternalProviderDispatch_CompletedAt" TIMESTAMP(3),
    "ExternalProviderDispatch_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ExternalProviderDispatch_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalProviderDispatch_pkey" PRIMARY KEY ("ExternalProviderDispatch_ID"),
    CONSTRAINT "ExternalProviderDispatch_receipt_scope_check" CHECK (
        ("ReceiptScan_ID" IS NULL AND "ReceiptScan_BusinessProfile_ID" IS NULL)
        OR (
            "ReceiptScan_ID" IS NOT NULL
            AND "ReceiptScan_BusinessProfile_ID" IS NOT NULL
            AND "ReceiptScan_BusinessProfile_ID" = "BusinessProfile_ID"
        )
    ),
    CONSTRAINT "ExternalProviderDispatch_budget_scope_check" CHECK (
        "ExternalProviderDispatch_ResourceBudgetScope" = 'RESOURCE'
        AND (
            (
                "ExternalProviderDispatch_BusinessBudget_ID" IS NULL
                AND "ExternalProviderDispatch_BusinessBudgetScope" IS NULL
                AND "ExternalProviderDispatch_BusinessBudgetProfile_ID" IS NULL
            )
            OR (
                "ExternalProviderDispatch_BusinessBudget_ID" IS NOT NULL
                AND "ExternalProviderDispatch_BusinessBudgetScope" IS NOT NULL
                AND "ExternalProviderDispatch_BusinessBudgetProfile_ID" IS NOT NULL
                AND "ExternalProviderDispatch_BusinessBudgetScope" = 'BUSINESS'
                AND "ExternalProviderDispatch_BusinessBudgetProfile_ID" = "BusinessProfile_ID"
                AND "ExternalProviderDispatch_BusinessBudget_ID"
                    <> "ExternalProviderDispatch_ResourceBudget_ID"
            )
        )
    ),
    CONSTRAINT "ExternalProviderDispatch_provider_check" CHECK (
        "ExternalProviderDispatch_Provider" ~ '^[a-z][a-z0-9_-]{0,63}$'
    ),
    CONSTRAINT "ExternalProviderDispatch_hashes_check" CHECK (
        "ExternalProviderDispatch_ReservationKeyHash" ~ '^[0-9a-f]{64}$'
        AND "ExternalProviderDispatch_InputHash" ~ '^[0-9a-f]{64}$'
        AND (
            "ExternalProviderDispatch_ProviderRequestIDHash" IS NULL
            OR "ExternalProviderDispatch_ProviderRequestIDHash" ~ '^[0-9a-f]{64}$'
        )
    ),
    CONSTRAINT "ExternalProviderDispatch_versions_check" CHECK (
        btrim("ExternalProviderDispatch_ProviderVersion") <> ''
        AND btrim("ExternalProviderDispatch_ProviderRegion") <> ''
        AND btrim("ExternalProviderDispatch_PreprocessingVersion") <> ''
        AND btrim("ExternalProviderDispatch_SchemaVersion") <> ''
    ),
    CONSTRAINT "ExternalProviderDispatch_codes_check" CHECK (
        "ExternalProviderDispatch_RescueReasonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'
        AND (
            "ExternalProviderDispatch_OutcomeCode" IS NULL
            OR "ExternalProviderDispatch_OutcomeCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'
        )
    ),
    CONSTRAINT "ExternalProviderDispatch_units_check" CHECK (
        "ExternalProviderDispatch_ReservedUnits" > 0
        AND (
            "ExternalProviderDispatch_FinalBillableUnits" IS NULL
            OR "ExternalProviderDispatch_FinalBillableUnits" BETWEEN 0
                AND "ExternalProviderDispatch_ReservedUnits"
        )
        AND "ExternalProviderDispatch_PageCount" BETWEEN 1 AND 8
        AND "ExternalProviderDispatch_DocumentCount" BETWEEN 1
            AND "ExternalProviderDispatch_PageCount"
        AND (
            "ExternalProviderDispatch_EstimatedCostMicros" IS NULL
            OR "ExternalProviderDispatch_EstimatedCostMicros" >= 0
        )
        AND (
            "ExternalProviderDispatch_LatencyMs" IS NULL
            OR "ExternalProviderDispatch_LatencyMs" >= 0
        )
    ),
    CONSTRAINT "ExternalProviderDispatch_status_check" CHECK (
        (
            "ExternalProviderDispatch_Status" = 'RESERVED'
            AND "ExternalProviderDispatch_SubmittedAt" IS NULL
            AND "ExternalProviderDispatch_CompletedAt" IS NULL
            AND "ExternalProviderDispatch_FinalBillableUnits" IS NULL
            AND "ExternalProviderDispatch_OutcomeCode" IS NULL
        )
        OR (
            "ExternalProviderDispatch_Status" = 'SUBMITTED'
            AND "ExternalProviderDispatch_SubmittedAt" IS NOT NULL
            AND "ExternalProviderDispatch_CompletedAt" IS NULL
            AND "ExternalProviderDispatch_FinalBillableUnits" IS NULL
            AND "ExternalProviderDispatch_OutcomeCode" IS NULL
        )
        OR (
            "ExternalProviderDispatch_Status" = 'AMBIGUOUS'
            AND "ExternalProviderDispatch_SubmittedAt" IS NOT NULL
            AND "ExternalProviderDispatch_CompletedAt" IS NOT NULL
            AND "ExternalProviderDispatch_FinalBillableUnits" IS NULL
            AND "ExternalProviderDispatch_OutcomeCode" IS NOT NULL
        )
        OR (
            "ExternalProviderDispatch_Status" IN ('SUCCEEDED', 'FAILED')
            AND "ExternalProviderDispatch_SubmittedAt" IS NOT NULL
            AND "ExternalProviderDispatch_CompletedAt" IS NOT NULL
            AND "ExternalProviderDispatch_FinalBillableUnits" IS NOT NULL
            AND "ExternalProviderDispatch_OutcomeCode" IS NOT NULL
        )
        OR (
            "ExternalProviderDispatch_Status" = 'CANCELLED'
            AND "ExternalProviderDispatch_CompletedAt" IS NOT NULL
            AND "ExternalProviderDispatch_FinalBillableUnits" = 0
            AND "ExternalProviderDispatch_OutcomeCode" IS NOT NULL
        )
    ),
    CONSTRAINT "ExternalProviderDispatch_timestamps_check" CHECK (
        ("ExternalProviderDispatch_SubmittedAt" IS NULL
            OR "ExternalProviderDispatch_SubmittedAt" >= "ExternalProviderDispatch_CreatedAt")
        AND ("ExternalProviderDispatch_CompletedAt" IS NULL
            OR "ExternalProviderDispatch_CompletedAt" >= "ExternalProviderDispatch_CreatedAt")
        AND (
            "ExternalProviderDispatch_SubmittedAt" IS NULL
            OR "ExternalProviderDispatch_CompletedAt" IS NULL
            OR "ExternalProviderDispatch_CompletedAt" >= "ExternalProviderDispatch_SubmittedAt"
        )
    )
);

-- CreateTable
CREATE TABLE "ReceiptPurgeJob" (
    "ReceiptPurgeJob_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ReceiptScan_ID" INTEGER,
    "ReceiptScan_BusinessProfile_ID" INTEGER,
    "ReceiptPurgeJob_RequestKeyHash" CHAR(64) NOT NULL,
    "ReceiptPurgeJob_TargetReferenceHash" CHAR(64) NOT NULL,
    "ReceiptPurgeJob_Reason" "ReceiptPurgeReason" NOT NULL,
    "ReceiptPurgeJob_Status" "ReceiptPurgeStatus" NOT NULL DEFAULT 'PENDING',
    "ReceiptPurgeJob_Stage" "ReceiptPurgeStage" NOT NULL DEFAULT 'STORAGE',
    "ReceiptPurgeJob_CheckpointPageNumber" INTEGER NOT NULL DEFAULT 0,
    "ReceiptPurgeJob_StorageObjectsExpected" INTEGER NOT NULL DEFAULT 0,
    "ReceiptPurgeJob_StorageObjectsDeleted" INTEGER NOT NULL DEFAULT 0,
    "ReceiptPurgeJob_AttemptCount" INTEGER NOT NULL DEFAULT 0,
    "ReceiptPurgeJob_NextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ReceiptPurgeJob_LeaseStartedAt" TIMESTAMP(3),
    "ReceiptPurgeJob_HeartbeatAt" TIMESTAMP(3),
    "ReceiptPurgeJob_WorkerID" VARCHAR(100),
    "ReceiptPurgeJob_LastErrorCode" VARCHAR(64),
    "ReceiptPurgeJob_RequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ReceiptPurgeJob_CompletedAt" TIMESTAMP(3),
    "ReceiptPurgeJob_ExpiresAt" TIMESTAMP(3) NOT NULL,
    "ReceiptPurgeJob_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptPurgeJob_pkey" PRIMARY KEY ("ReceiptPurgeJob_ID"),
    CONSTRAINT "ReceiptPurgeJob_receipt_scope_check" CHECK (
        ("ReceiptScan_ID" IS NULL AND "ReceiptScan_BusinessProfile_ID" IS NULL)
        OR (
            "ReceiptScan_ID" IS NOT NULL
            AND "ReceiptScan_BusinessProfile_ID" IS NOT NULL
            AND "ReceiptScan_BusinessProfile_ID" = "BusinessProfile_ID"
        )
    ),
    CONSTRAINT "ReceiptPurgeJob_hashes_check" CHECK (
        "ReceiptPurgeJob_RequestKeyHash" ~ '^[0-9a-f]{64}$'
        AND "ReceiptPurgeJob_TargetReferenceHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ReceiptPurgeJob_counts_check" CHECK (
        "ReceiptPurgeJob_CheckpointPageNumber" >= 0
        AND "ReceiptPurgeJob_StorageObjectsExpected" >= 0
        AND "ReceiptPurgeJob_StorageObjectsDeleted" BETWEEN 0
            AND "ReceiptPurgeJob_StorageObjectsExpected"
        AND "ReceiptPurgeJob_AttemptCount" >= 0
    ),
    CONSTRAINT "ReceiptPurgeJob_error_code_check" CHECK (
        "ReceiptPurgeJob_LastErrorCode" IS NULL
        OR "ReceiptPurgeJob_LastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    CONSTRAINT "ReceiptPurgeJob_status_check" CHECK (
        (
            "ReceiptPurgeJob_Status" = 'COMPLETE'
            AND "ReceiptPurgeJob_Stage" = 'COMPLETE'
            AND "ReceiptPurgeJob_CompletedAt" IS NOT NULL
        )
        OR (
            "ReceiptPurgeJob_Status" <> 'COMPLETE'
            AND "ReceiptPurgeJob_Stage" <> 'COMPLETE'
            AND "ReceiptPurgeJob_CompletedAt" IS NULL
        )
    ),
    CONSTRAINT "ReceiptPurgeJob_lease_check" CHECK (
        "ReceiptPurgeJob_Status" <> 'PROCESSING'
        OR (
            "ReceiptPurgeJob_LeaseStartedAt" IS NOT NULL
            AND "ReceiptPurgeJob_HeartbeatAt" IS NOT NULL
            AND "ReceiptPurgeJob_WorkerID" IS NOT NULL
            AND btrim("ReceiptPurgeJob_WorkerID") <> ''
        )
    ),
    CONSTRAINT "ReceiptPurgeJob_timestamps_check" CHECK (
        "ReceiptPurgeJob_ExpiresAt" > "ReceiptPurgeJob_RequestedAt"
        AND ("ReceiptPurgeJob_CompletedAt" IS NULL
            OR "ReceiptPurgeJob_CompletedAt" >= "ReceiptPurgeJob_RequestedAt")
        AND ("ReceiptPurgeJob_HeartbeatAt" IS NULL
            OR "ReceiptPurgeJob_LeaseStartedAt" IS NULL
            OR "ReceiptPurgeJob_HeartbeatAt" >= "ReceiptPurgeJob_LeaseStartedAt")
    )
);

-- CreateIndex
CREATE INDEX "ExternalProcessingConsent_profile_provider_revoked_idx" ON "ExternalProcessingConsent"("BusinessProfile_ID", "ExternalProcessingConsent_Provider", "ExternalProcessingConsent_RevokedAt");

-- Only one unrevoked grant can authorize a business/provider pair.
CREATE UNIQUE INDEX "ExternalProcessingConsent_active_business_provider_key"
    ON "ExternalProcessingConsent"("BusinessProfile_ID", "ExternalProcessingConsent_Provider")
    WHERE "ExternalProcessingConsent_RevokedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ExternalProcessingConsent_ID_profile_provider_key" ON "ExternalProcessingConsent"("ExternalProcessingConsent_ID", "BusinessProfile_ID", "ExternalProcessingConsent_Provider");

-- CreateIndex
CREATE INDEX "ExternalProviderBudget_resource_cycle_idx" ON "ExternalProviderBudget"("ExternalProviderBudget_Provider", "ExternalProviderBudget_CycleStart", "ExternalProviderBudget_UnitType");

-- CreateIndex
CREATE INDEX "ExternalProviderBudget_business_cycle_idx" ON "ExternalProviderBudget"("BusinessProfile_ID", "ExternalProviderBudget_Provider", "ExternalProviderBudget_CycleStart", "ExternalProviderBudget_UnitType");

CREATE UNIQUE INDEX "ExternalProviderBudget_resource_cycle_key"
    ON "ExternalProviderBudget"(
        "ExternalProviderBudget_Provider",
        "ExternalProviderBudget_CycleStart",
        "ExternalProviderBudget_UnitType"
    )
    WHERE "BusinessProfile_ID" IS NULL;

CREATE UNIQUE INDEX "ExternalProviderBudget_business_cycle_key"
    ON "ExternalProviderBudget"(
        "ExternalProviderBudget_Provider",
        "ExternalProviderBudget_CycleStart",
        "ExternalProviderBudget_UnitType",
        "BusinessProfile_ID"
    )
    WHERE "BusinessProfile_ID" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ExternalProviderBudget_resource_relation_key" ON "ExternalProviderBudget"("ExternalProviderBudget_ID", "ExternalProviderBudget_Scope", "ExternalProviderBudget_Provider", "ExternalProviderBudget_CycleStart", "ExternalProviderBudget_UnitType");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalProviderBudget_business_relation_key" ON "ExternalProviderBudget"("ExternalProviderBudget_ID", "ExternalProviderBudget_Scope", "BusinessProfile_ID", "ExternalProviderBudget_Provider", "ExternalProviderBudget_CycleStart", "ExternalProviderBudget_UnitType");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalProviderDispatch_reservation_key" ON "ExternalProviderDispatch"("ExternalProviderDispatch_ReservationKeyHash");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_profile_created_idx" ON "ExternalProviderDispatch"("BusinessProfile_ID", "ExternalProviderDispatch_CreatedAt", "ExternalProviderDispatch_ID");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_profile_provider_input_idx" ON "ExternalProviderDispatch"("BusinessProfile_ID", "ExternalProviderDispatch_Provider", "ExternalProviderDispatch_InputHash");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_receipt_idx" ON "ExternalProviderDispatch"("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_consent_idx" ON "ExternalProviderDispatch"("ExternalProcessingConsent_ID", "BusinessProfile_ID", "ExternalProviderDispatch_Provider");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_status_created_idx" ON "ExternalProviderDispatch"("ExternalProviderDispatch_Status", "ExternalProviderDispatch_CreatedAt");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_resource_status_idx" ON "ExternalProviderDispatch"("ExternalProviderDispatch_ResourceBudget_ID", "ExternalProviderDispatch_Status");

-- CreateIndex
CREATE INDEX "ExternalProviderDispatch_business_status_idx" ON "ExternalProviderDispatch"("ExternalProviderDispatch_BusinessBudget_ID", "ExternalProviderDispatch_Status");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptPurgeJob_request_key" ON "ReceiptPurgeJob"("ReceiptPurgeJob_RequestKeyHash");

-- CreateIndex
CREATE INDEX "ReceiptPurgeJob_claim_idx" ON "ReceiptPurgeJob"("ReceiptPurgeJob_Status", "ReceiptPurgeJob_NextAttemptAt", "ReceiptPurgeJob_HeartbeatAt");

-- CreateIndex
CREATE INDEX "ReceiptPurgeJob_profile_status_requested_idx" ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptPurgeJob_Status", "ReceiptPurgeJob_RequestedAt");

-- CreateIndex
CREATE INDEX "ReceiptPurgeJob_expiry_idx" ON "ReceiptPurgeJob"("ReceiptPurgeJob_ExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptPurgeJob_profile_receipt_key" ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptScan_ID");

-- CreateIndex
CREATE INDEX "ReceiptPurgeJob_receipt_idx" ON "ReceiptPurgeJob"("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_ID_User_ID_key" ON "BusinessProfile"("BusinessProfile_ID", "User_ID");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptScan_ID_BusinessProfile_ID_key" ON "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID");

-- AddForeignKey
ALTER TABLE "ExternalProcessingConsent" ADD CONSTRAINT "ExternalProcessingConsent_BusinessProfile_ID_User_ID_fkey" FOREIGN KEY ("BusinessProfile_ID", "User_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderBudget" ADD CONSTRAINT "ExternalProviderBudget_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatch" ADD CONSTRAINT "ExternalProviderDispatch_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatch" ADD CONSTRAINT "ExternalProviderDispatch_ReceiptScan_ID_ReceiptScan_Busine_fkey" FOREIGN KEY ("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatch" ADD CONSTRAINT "ExternalProviderDispatch_ExternalProcessingConsent_ID_Busi_fkey" FOREIGN KEY ("ExternalProcessingConsent_ID", "BusinessProfile_ID", "ExternalProviderDispatch_Provider") REFERENCES "ExternalProcessingConsent"("ExternalProcessingConsent_ID", "BusinessProfile_ID", "ExternalProcessingConsent_Provider") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatch" ADD CONSTRAINT "ExternalProviderDispatch_ExternalProviderDispatch_Resource_fkey" FOREIGN KEY ("ExternalProviderDispatch_ResourceBudget_ID", "ExternalProviderDispatch_ResourceBudgetScope", "ExternalProviderDispatch_Provider", "ExternalProviderDispatch_CycleStart", "ExternalProviderDispatch_UnitType") REFERENCES "ExternalProviderBudget"("ExternalProviderBudget_ID", "ExternalProviderBudget_Scope", "ExternalProviderBudget_Provider", "ExternalProviderBudget_CycleStart", "ExternalProviderBudget_UnitType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProviderDispatch" ADD CONSTRAINT "ExternalProviderDispatch_ExternalProviderDispatch_Business_fkey" FOREIGN KEY ("ExternalProviderDispatch_BusinessBudget_ID", "ExternalProviderDispatch_BusinessBudgetScope", "ExternalProviderDispatch_BusinessBudgetProfile_ID", "ExternalProviderDispatch_Provider", "ExternalProviderDispatch_CycleStart", "ExternalProviderDispatch_UnitType") REFERENCES "ExternalProviderBudget"("ExternalProviderBudget_ID", "ExternalProviderBudget_Scope", "BusinessProfile_ID", "ExternalProviderBudget_Provider", "ExternalProviderBudget_CycleStart", "ExternalProviderBudget_UnitType") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptPurgeJob" ADD CONSTRAINT "ReceiptPurgeJob_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptPurgeJob" ADD CONSTRAINT "ReceiptPurgeJob_ReceiptScan_ID_ReceiptScan_BusinessProfile_fkey" FOREIGN KEY ("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExternalProcessingConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalProviderBudget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalProviderDispatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceiptPurgeJob" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
    "ExternalProcessingConsent",
    "ExternalProviderBudget",
    "ExternalProviderDispatch",
    "ReceiptPurgeJob"
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON SEQUENCE
    "ExternalProcessingConsent_ExternalProcessingConsent_ID_seq",
    "ExternalProviderBudget_ExternalProviderBudget_ID_seq",
    "ExternalProviderDispatch_ExternalProviderDispatch_ID_seq",
    "ReceiptPurgeJob_ReceiptPurgeJob_ID_seq"
FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE "ExternalProcessingConsent", "ExternalProviderBudget", "ExternalProviderDispatch", "ReceiptPurgeJob" FROM %I',
                api_role
            );
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE "ExternalProcessingConsent_ExternalProcessingConsent_ID_seq", "ExternalProviderBudget_ExternalProviderBudget_ID_seq", "ExternalProviderDispatch_ExternalProviderDispatch_ID_seq", "ReceiptPurgeJob_ReceiptPurgeJob_ID_seq" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
