-- This migration supports exactly two revisions of the earlier Phase 2 migration.
-- The legacy revision is repaired only after its catalog shape is proven intact.
DO $reconcile$
DECLARE
    source_checksum TEXT;
    source_row_count INTEGER;
    actual_columns TEXT[];
    actual_labels TEXT[];
    api_role TEXT;
BEGIN
    SELECT count(*), min(checksum)
    INTO source_row_count, source_checksum
    FROM public."_prisma_migrations"
    WHERE migration_name = '20260913100918_receipt_capture_batches_and_scan_revision'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL;

    IF source_row_count <> 1 THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation requires exactly one completed, non-rolled-back 20260913100918 migration.';
    END IF;

    IF source_checksum = 'a0e4f79275cbb0e975f16d4675776ecf954395eaa6dd5900f15cd3f73030ca5b' THEN
        SELECT array_agg(e.enumlabel::TEXT ORDER BY e.enumsortorder)
        INTO actual_labels
        FROM pg_enum e
        WHERE e.enumtypid = to_regtype('public."ReceiptCaptureBatchStatus"');

        IF actual_labels IS DISTINCT FROM ARRAY[
            'COLLECTING',
            'PROCESSING',
            'READY_FOR_REVIEW',
            'PARTIAL_FAILURE',
            'FAILED',
            'COMPLETE',
            'CANCELLED'
        ]::TEXT[] THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: ReceiptCaptureBatchStatus labels differ.';
        END IF;

        IF to_regclass('public."ReceiptCaptureBatch"') IS NULL
           OR to_regclass('public."ReceiptScan"') IS NULL
           OR to_regclass('public."ReceiptPurgeJob"') IS NULL
           OR to_regclass('public."ExpenseRecord"') IS NULL THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: a required base table is missing.';
        END IF;

        SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
        INTO actual_columns
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptCaptureBatch';

        IF actual_columns IS DISTINCT FROM ARRAY[
            'ReceiptCaptureBatch_ID',
            'BusinessProfile_ID',
            'ReceiptCaptureBatch_ClientBatchKey',
            'ReceiptCaptureBatch_ExpectedReceiptCount',
            'ReceiptCaptureBatch_Status',
            'ReceiptCaptureBatch_CreatedAt',
            'ReceiptCaptureBatch_FinishedAt'
        ]::TEXT[] THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: ReceiptCaptureBatch columns differ.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM (
                VALUES
                    ('ReceiptCaptureBatch_ID', 'int4', 'NO', NULL::INTEGER),
                    ('BusinessProfile_ID', 'int4', 'NO', NULL::INTEGER),
                    ('ReceiptCaptureBatch_ClientBatchKey', 'varchar', 'NO', 100),
                    ('ReceiptCaptureBatch_ExpectedReceiptCount', 'int4', 'NO', NULL::INTEGER),
                    ('ReceiptCaptureBatch_Status', 'ReceiptCaptureBatchStatus', 'NO', NULL::INTEGER),
                    ('ReceiptCaptureBatch_CreatedAt', 'timestamp', 'NO', NULL::INTEGER),
                    ('ReceiptCaptureBatch_FinishedAt', 'timestamp', 'YES', NULL::INTEGER)
            ) AS expected(column_name, udt_name, is_nullable, maximum_length)
            LEFT JOIN information_schema.columns actual
              ON actual.table_schema = 'public'
             AND actual.table_name = 'ReceiptCaptureBatch'
             AND actual.column_name = expected.column_name
            WHERE actual.column_name IS NULL
               OR actual.udt_name <> expected.udt_name
               OR actual.is_nullable <> expected.is_nullable
               OR actual.character_maximum_length IS DISTINCT FROM expected.maximum_length
        )
        OR pg_get_serial_sequence('public."ReceiptCaptureBatch"', 'ReceiptCaptureBatch_ID')
            IS DISTINCT FROM 'public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'
        OR NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'ReceiptCaptureBatch'
              AND column_name = 'ReceiptCaptureBatch_Status'
              AND column_default LIKE '%COLLECTING%'
        )
        OR NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'ReceiptCaptureBatch'
              AND column_name = 'ReceiptCaptureBatch_CreatedAt'
              AND column_default = 'CURRENT_TIMESTAMP'
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: ReceiptCaptureBatch column metadata differs.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM (
                VALUES
                    ('ReceiptCaptureBatch_ID', 'int4', 'YES', NULL::INTEGER),
                    ('ReceiptScan_ReceiptOrdinal', 'int4', 'YES', NULL::INTEGER),
                    ('ReceiptScan_ScanRevision', 'int4', 'NO', NULL::INTEGER),
                    ('ReceiptScan_ImageFile', 'varchar', 'NO', 255)
            ) AS expected(column_name, udt_name, is_nullable, maximum_length)
            LEFT JOIN information_schema.columns actual
              ON actual.table_schema = 'public'
             AND actual.table_name = 'ReceiptScan'
             AND actual.column_name = expected.column_name
            WHERE actual.column_name IS NULL
               OR actual.udt_name <> expected.udt_name
               OR actual.is_nullable <> expected.is_nullable
               OR actual.character_maximum_length IS DISTINCT FROM expected.maximum_length
        )
        OR NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'ReceiptScan'
              AND column_name = 'ReceiptScan_ScanRevision'
              AND column_default = '0'
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: ReceiptScan legacy column metadata differs.';
        END IF;

        IF to_regtype('public."ReceiptPurgeMode"') IS NOT NULL
           OR to_regtype('public."ReceiptDuplicateScoreBand"') IS NOT NULL
           OR to_regtype('public."ReceiptDuplicateReviewStatus"') IS NOT NULL
           OR to_regclass('public."ReceiptDuplicateCandidate"') IS NOT NULL
           OR to_regclass('public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"') IS NOT NULL
           OR EXISTS (
               SELECT 1
               FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND (
                     (table_name = 'ReceiptScan' AND column_name IN (
                         'ReceiptScan_EvidenceDeletedAt',
                         'ReceiptScan_EvidenceDeletionRequestedAt',
                         'ReceiptScan_SemanticFingerprint'
                     ))
                     OR (table_name = 'ReceiptPurgeJob' AND column_name = 'ReceiptPurgeJob_Mode')
                 )
           ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: later Phase 2 objects are partially present.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM (
                VALUES
                    ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_pkey', 'p', '', ''),
                    ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_client_key_check', 'c', '', ''),
                    ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_expected_count_check', 'c', '', ''),
                    ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_finished_check', 'c', '', ''),
                    ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_timestamps_check', 'c', '', ''),
                    ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_BusinessProfile_ID_fkey', 'f', 'c', 'c'),
                    ('ReceiptScan', 'ReceiptScan_scan_revision_check', 'c', '', ''),
                    ('ReceiptScan', 'ReceiptScan_batch_link_check', 'c', '', ''),
                    ('ReceiptScan', 'ReceiptScan_ReceiptCaptureBatch_ID_BusinessProfile_ID_fkey', 'f', 'a', 'c')
            ) AS expected(table_name, constraint_name, constraint_type, delete_action, update_action)
            LEFT JOIN pg_class target
              ON target.relnamespace = 'public'::regnamespace
             AND target.relname = expected.table_name
            LEFT JOIN pg_constraint actual
              ON actual.conrelid = target.oid
             AND actual.conname = expected.constraint_name
            WHERE actual.oid IS NULL
               OR actual.contype::TEXT <> expected.constraint_type
               OR NOT actual.convalidated
               OR (
                   expected.constraint_type = 'c'
                   AND actual.connoinherit
               )
               OR (
                   expected.constraint_type IN ('p', 'f')
                   AND (actual.condeferrable OR actual.condeferred)
               )
               OR (
                   expected.constraint_type = 'f'
                   AND (
                       actual.confdeltype::TEXT <> expected.delete_action
                       OR actual.confupdtype::TEXT <> expected.update_action
                       OR actual.confmatchtype::TEXT <> 's'
                   )
               )
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: a legacy constraint differs.';
        END IF;

        IF (
            SELECT regexp_replace(
                pg_get_expr(actual.conbin, actual.conrelid),
                '[[:space:]]+',
                ' ',
                'g'
            )
            FROM pg_constraint actual
            WHERE actual.conrelid = 'public."ReceiptScan"'::regclass
              AND actual.conname = 'ReceiptScan_batch_link_check'
        ) IS DISTINCT FROM $expected$((("ReceiptCaptureBatch_ID" IS NULL) AND ("ReceiptScan_ReceiptOrdinal" IS NULL)) OR (("ReceiptCaptureBatch_ID" IS NOT NULL) AND ("ReceiptScan_ReceiptOrdinal" IS NOT NULL) AND ("BusinessProfile_ID" IS NOT NULL) AND (("ReceiptScan_ReceiptOrdinal" >= 1) AND ("ReceiptScan_ReceiptOrdinal" <= 8))))$expected$ THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: ReceiptScan_batch_link_check differs.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM (
                VALUES
                    ('ReceiptCaptureBatch_profile_created_idx', 'ReceiptCaptureBatch', FALSE),
                    ('ReceiptCaptureBatch_profile_client_key', 'ReceiptCaptureBatch', TRUE),
                    ('ReceiptCaptureBatch_ID_BusinessProfile_ID_key', 'ReceiptCaptureBatch', TRUE),
                    ('ReceiptScan_batch_ordinal_key', 'ReceiptScan', TRUE),
                    ('ReceiptScan_BusinessProfile_ID_idx', 'ReceiptScan', FALSE),
                    ('ReceiptPurgeJob_profile_receipt_key', 'ReceiptPurgeJob', TRUE)
            ) AS expected(index_name, table_name, is_unique)
            LEFT JOIN pg_class index_relation
              ON index_relation.relnamespace = 'public'::regnamespace
             AND index_relation.relname = expected.index_name
             AND index_relation.relkind = 'i'
            LEFT JOIN pg_index actual ON actual.indexrelid = index_relation.oid
            LEFT JOIN pg_class target ON target.oid = actual.indrelid
            WHERE actual.indexrelid IS NULL
               OR target.relname <> expected.table_name
               OR actual.indisunique <> expected.is_unique
               OR actual.indpred IS NOT NULL
               OR NOT actual.indisvalid
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: a legacy index differs.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM unnest(ARRAY[
                'ReceiptScan_history_status_created_idx',
                'ReceiptScan_history_created_idx',
                'ReceiptScan_profile_semantic_fingerprint_idx',
                'ExpenseRecord_ID_BusinessProfile_ID_key',
                'ReceiptDuplicateCandidate_source_review_idx',
                'ReceiptDuplicateCandidate_scan_target_idx',
                'ReceiptDuplicateCandidate_expense_target_idx',
                'ReceiptDuplicateCandidate_decision_owner_idx',
                'ReceiptDuplicateCandidate_source_scan_target_key',
                'ReceiptDuplicateCandidate_source_expense_target_key',
                'ReceiptPurgeJob_profile_receipt_idx',
                'ReceiptPurgeJob_active_profile_receipt_key'
            ]) AS expected(index_name)
            WHERE to_regclass(format('public.%I', expected.index_name)) IS NOT NULL
        )
        OR EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public."ReceiptPurgeJob"'::regclass
              AND conname = 'ReceiptPurgeJob_active_target_check'
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: replacement indexes or constraints are partially present.';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_class
            WHERE oid = 'public."ReceiptCaptureBatch"'::regclass
              AND relkind = 'r'
              AND relrowsecurity
        )
        OR EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = 'public."ReceiptCaptureBatch"'::regclass
        )
        OR EXISTS (
            SELECT 1
            FROM pg_class relation
            CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
            LEFT JOIN pg_roles role ON role.oid = privilege.grantee
            WHERE relation.oid IN (
                'public."ReceiptCaptureBatch"'::regclass,
                'public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'::regclass
            )
              AND (
                  privilege.grantee = 0
                  OR role.rolname IN ('anon', 'authenticated', 'service_role')
              )
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Unsupported legacy Phase 2 shape: ReceiptCaptureBatch security controls differ.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public."ReceiptPurgeJob"
            WHERE "ReceiptPurgeJob_Status"::TEXT IN ('PENDING', 'PROCESSING', 'RETRY')
              AND (
                  "ReceiptScan_ID" IS NULL
                  OR "ReceiptScan_BusinessProfile_ID" IS NULL
              )
        ) THEN
            RAISE EXCEPTION USING MESSAGE =
                'Cannot reconcile Phase 2: an active receipt purge job has no complete scan target.';
        END IF;

        EXECUTE $sql$
            CREATE TYPE "ReceiptPurgeMode" AS ENUM (
                'DELETE_SCAN',
                'DETACH_EVIDENCE'
            )
        $sql$;

        EXECUTE $sql$
            CREATE TYPE "ReceiptDuplicateScoreBand" AS ENUM (
                'EXACT',
                'LIKELY'
            )
        $sql$;

        EXECUTE $sql$
            CREATE TYPE "ReceiptDuplicateReviewStatus" AS ENUM (
                'PENDING',
                'SAVED_ANYWAY',
                'SUPERSEDED'
            )
        $sql$;

        EXECUTE $sql$
            CREATE TABLE "ReceiptDuplicateCandidate" (
                "ReceiptDuplicateCandidate_ID" SERIAL NOT NULL,
                "BusinessProfile_ID" INTEGER NOT NULL,
                "ReceiptDuplicateCandidate_SourceReceiptScan_ID" INTEGER NOT NULL,
                "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" INTEGER,
                "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" INTEGER,
                "ReceiptDuplicateCandidate_DetectorVersion" VARCHAR(64) NOT NULL,
                "ReceiptDuplicateCandidate_SourceFingerprint" CHAR(64) NOT NULL,
                "ReceiptDuplicateCandidate_ReasonCodes" JSONB NOT NULL,
                "ReceiptDuplicateCandidate_ScoreBand" "ReceiptDuplicateScoreBand" NOT NULL,
                "ReceiptDuplicateCandidate_ReviewStatus" "ReceiptDuplicateReviewStatus" NOT NULL DEFAULT 'PENDING',
                "ReceiptDuplicateCandidate_DecisionSetHash" CHAR(64),
                "ReceiptDuplicateCandidate_DecidedByUser_ID" INTEGER,
                "ReceiptDuplicateCandidate_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "ReceiptDuplicateCandidate_DecidedAt" TIMESTAMP(3),

                CONSTRAINT "ReceiptDuplicateCandidate_pkey"
                    PRIMARY KEY ("ReceiptDuplicateCandidate_ID"),
                CONSTRAINT "ReceiptDuplicateCandidate_target_check" CHECK (
                    (
                        "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL
                        AND "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NULL
                        AND "ReceiptDuplicateCandidate_CandidateReceiptScan_ID"
                            <> "ReceiptDuplicateCandidate_SourceReceiptScan_ID"
                    )
                    OR (
                        "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NULL
                        AND "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL
                    )
                ),
                CONSTRAINT "ReceiptDuplicateCandidate_detector_version_check" CHECK (
                    btrim("ReceiptDuplicateCandidate_DetectorVersion") <> ''
                ),
                CONSTRAINT "ReceiptDuplicateCandidate_source_fingerprint_check" CHECK (
                    "ReceiptDuplicateCandidate_SourceFingerprint" ~ '^[0-9a-f]{64}$'
                ),
                CONSTRAINT "ReceiptDuplicateCandidate_decision_set_hash_check" CHECK (
                    "ReceiptDuplicateCandidate_DecisionSetHash" IS NULL
                    OR "ReceiptDuplicateCandidate_DecisionSetHash" ~ '^[0-9a-f]{64}$'
                ),
                CONSTRAINT "ReceiptDuplicateCandidate_reason_codes_check" CHECK (
                    jsonb_typeof("ReceiptDuplicateCandidate_ReasonCodes") = 'array'
                    AND jsonb_array_length("ReceiptDuplicateCandidate_ReasonCodes") > 0
                ),
                CONSTRAINT "ReceiptDuplicateCandidate_decision_lifecycle_check" CHECK (
                    (
                        "ReceiptDuplicateCandidate_ReviewStatus" = 'SAVED_ANYWAY'
                        AND "ReceiptDuplicateCandidate_DecisionSetHash" IS NOT NULL
                        AND "ReceiptDuplicateCandidate_DecidedByUser_ID" IS NOT NULL
                        AND "ReceiptDuplicateCandidate_DecidedAt" IS NOT NULL
                    )
                    OR (
                        "ReceiptDuplicateCandidate_ReviewStatus" IN ('PENDING', 'SUPERSEDED')
                        AND "ReceiptDuplicateCandidate_DecisionSetHash" IS NULL
                        AND "ReceiptDuplicateCandidate_DecidedByUser_ID" IS NULL
                        AND "ReceiptDuplicateCandidate_DecidedAt" IS NULL
                    )
                ),
                CONSTRAINT "ReceiptDuplicateCandidate_decision_timestamp_check" CHECK (
                    "ReceiptDuplicateCandidate_DecidedAt" IS NULL
                    OR "ReceiptDuplicateCandidate_DecidedAt"
                        >= "ReceiptDuplicateCandidate_CreatedAt"
                )
            )
        $sql$;

        EXECUTE $sql$
            ALTER TABLE "ReceiptScan"
                ADD COLUMN "ReceiptScan_EvidenceDeletedAt" TIMESTAMP(3),
                ADD COLUMN "ReceiptScan_EvidenceDeletionRequestedAt" TIMESTAMP(3),
                ADD COLUMN "ReceiptScan_SemanticFingerprint" CHAR(64),
                ALTER COLUMN "ReceiptScan_ImageFile" DROP NOT NULL
        $sql$;

        EXECUTE $sql$
            ALTER TABLE "ReceiptScan"
                ADD CONSTRAINT "ReceiptScan_semantic_fingerprint_check" CHECK (
                    "ReceiptScan_SemanticFingerprint" IS NULL
                    OR "ReceiptScan_SemanticFingerprint" ~ '^[0-9a-f]{64}$'
                ),
                ADD CONSTRAINT "ReceiptScan_evidence_deletion_timestamps_check" CHECK (
                    "ReceiptScan_EvidenceDeletedAt" IS NULL
                    OR (
                        "ReceiptScan_EvidenceDeletionRequestedAt" IS NOT NULL
                        AND "ReceiptScan_EvidenceDeletedAt"
                            >= "ReceiptScan_EvidenceDeletionRequestedAt"
                    )
                )
        $sql$;

        EXECUTE $sql$
            ALTER TABLE "ReceiptPurgeJob"
                ADD COLUMN "ReceiptPurgeJob_Mode" "ReceiptPurgeMode"
                    NOT NULL DEFAULT 'DELETE_SCAN'
        $sql$;

        EXECUTE $sql$
            ALTER TABLE "ReceiptPurgeJob"
                ALTER COLUMN "ReceiptPurgeJob_Mode" DROP DEFAULT,
                ADD CONSTRAINT "ReceiptPurgeJob_active_target_check" CHECK (
                    "ReceiptPurgeJob_Status" NOT IN ('PENDING', 'PROCESSING', 'RETRY')
                    OR (
                        "ReceiptScan_ID" IS NOT NULL
                        AND "ReceiptScan_BusinessProfile_ID" IS NOT NULL
                    )
                )
        $sql$;

        EXECUTE 'DROP INDEX "ReceiptScan_BusinessProfile_ID_idx"';
        EXECUTE 'DROP INDEX "ReceiptPurgeJob_profile_receipt_key"';

        EXECUTE $sql$
            CREATE INDEX "ReceiptScan_history_status_created_idx"
                ON "ReceiptScan"(
                    "BusinessProfile_ID",
                    "ReceiptScan_ConfirmationStatus",
                    "ReceiptScan_ProcessingStatus",
                    "ReceiptScan_CreatedAt" DESC,
                    "ReceiptScan_ID" DESC
                )
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptScan_history_created_idx"
                ON "ReceiptScan"(
                    "BusinessProfile_ID",
                    "ReceiptScan_CreatedAt" DESC,
                    "ReceiptScan_ID" DESC
                )
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptScan_profile_semantic_fingerprint_idx"
                ON "ReceiptScan"("BusinessProfile_ID", "ReceiptScan_SemanticFingerprint")
        $sql$;

        EXECUTE $sql$
            CREATE UNIQUE INDEX "ExpenseRecord_ID_BusinessProfile_ID_key"
                ON "ExpenseRecord"("ExpenseRecord_ID", "BusinessProfile_ID")
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptDuplicateCandidate_source_review_idx"
                ON "ReceiptDuplicateCandidate"(
                    "BusinessProfile_ID",
                    "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
                    "ReceiptDuplicateCandidate_ReviewStatus",
                    "ReceiptDuplicateCandidate_ID"
                )
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptDuplicateCandidate_scan_target_idx"
                ON "ReceiptDuplicateCandidate"(
                    "ReceiptDuplicateCandidate_CandidateReceiptScan_ID",
                    "BusinessProfile_ID"
                )
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptDuplicateCandidate_expense_target_idx"
                ON "ReceiptDuplicateCandidate"(
                    "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID",
                    "BusinessProfile_ID"
                )
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptDuplicateCandidate_decision_owner_idx"
                ON "ReceiptDuplicateCandidate"(
                    "BusinessProfile_ID",
                    "ReceiptDuplicateCandidate_DecidedByUser_ID"
                )
        $sql$;

        EXECUTE $sql$
            CREATE UNIQUE INDEX "ReceiptDuplicateCandidate_source_scan_target_key"
                ON "ReceiptDuplicateCandidate"(
                    "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
                    "ReceiptDuplicateCandidate_CandidateReceiptScan_ID",
                    "ReceiptDuplicateCandidate_DetectorVersion"
                )
                WHERE "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL
        $sql$;

        EXECUTE $sql$
            CREATE UNIQUE INDEX "ReceiptDuplicateCandidate_source_expense_target_key"
                ON "ReceiptDuplicateCandidate"(
                    "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
                    "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID",
                    "ReceiptDuplicateCandidate_DetectorVersion"
                )
                WHERE "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL
        $sql$;

        EXECUTE $sql$
            CREATE INDEX "ReceiptPurgeJob_profile_receipt_idx"
                ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptScan_ID")
        $sql$;

        EXECUTE $sql$
            CREATE UNIQUE INDEX "ReceiptPurgeJob_active_profile_receipt_key"
                ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptScan_ID")
                WHERE "ReceiptPurgeJob_Status" IN ('PENDING', 'PROCESSING', 'RETRY')
        $sql$;

        EXECUTE $sql$
            ALTER TABLE "ReceiptDuplicateCandidate"
                ADD CONSTRAINT "ReceiptDuplicateCandidate_profile_fkey"
                    FOREIGN KEY ("BusinessProfile_ID")
                    REFERENCES "BusinessProfile"("BusinessProfile_ID")
                    ON DELETE CASCADE ON UPDATE CASCADE,
                ADD CONSTRAINT "ReceiptDuplicateCandidate_decision_owner_fkey"
                    FOREIGN KEY (
                        "BusinessProfile_ID",
                        "ReceiptDuplicateCandidate_DecidedByUser_ID"
                    )
                    REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID")
                    ON DELETE NO ACTION ON UPDATE CASCADE,
                ADD CONSTRAINT "ReceiptDuplicateCandidate_source_scan_fkey"
                    FOREIGN KEY (
                        "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
                        "BusinessProfile_ID"
                    )
                    REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID")
                    ON DELETE CASCADE ON UPDATE CASCADE,
                ADD CONSTRAINT "ReceiptDuplicateCandidate_scan_target_fkey"
                    FOREIGN KEY (
                        "ReceiptDuplicateCandidate_CandidateReceiptScan_ID",
                        "BusinessProfile_ID"
                    )
                    REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID")
                    ON DELETE CASCADE ON UPDATE CASCADE,
                ADD CONSTRAINT "ReceiptDuplicateCandidate_expense_target_fkey"
                    FOREIGN KEY (
                        "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID",
                        "BusinessProfile_ID"
                    )
                    REFERENCES "ExpenseRecord"("ExpenseRecord_ID", "BusinessProfile_ID")
                    ON DELETE CASCADE ON UPDATE CASCADE
        $sql$;

        EXECUTE 'ALTER TABLE "ReceiptDuplicateCandidate" ENABLE ROW LEVEL SECURITY';
        EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "ReceiptDuplicateCandidate" FROM PUBLIC';
        EXECUTE 'REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq" FROM PUBLIC';

        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
        LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
                EXECUTE format(
                    'REVOKE ALL PRIVILEGES ON TABLE "ReceiptDuplicateCandidate" FROM %I',
                    api_role
                );
                EXECUTE format(
                    'REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq" FROM %I',
                    api_role
                );
            END IF;
        END LOOP;
    ELSIF source_checksum = '8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b' THEN
        NULL;
    ELSE
        RAISE EXCEPTION USING MESSAGE = format(
            'Unsupported checksum for 20260913100918_receipt_capture_batches_and_scan_revision: %s.',
            source_checksum
        );
    END IF;

    SELECT array_agg(e.enumlabel::TEXT ORDER BY e.enumsortorder)
    INTO actual_labels
    FROM pg_enum e
    WHERE e.enumtypid = to_regtype('public."ReceiptCaptureBatchStatus"');

    IF actual_labels IS DISTINCT FROM ARRAY[
        'COLLECTING',
        'PROCESSING',
        'READY_FOR_REVIEW',
        'PARTIAL_FAILURE',
        'FAILED',
        'COMPLETE',
        'CANCELLED'
    ]::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptCaptureBatchStatus differs.';
    END IF;

    SELECT array_agg(e.enumlabel::TEXT ORDER BY e.enumsortorder)
    INTO actual_labels
    FROM pg_enum e
    WHERE e.enumtypid = to_regtype('public."ReceiptPurgeMode"');

    IF actual_labels IS DISTINCT FROM ARRAY['DELETE_SCAN', 'DETACH_EVIDENCE']::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptPurgeMode differs.';
    END IF;

    SELECT array_agg(e.enumlabel::TEXT ORDER BY e.enumsortorder)
    INTO actual_labels
    FROM pg_enum e
    WHERE e.enumtypid = to_regtype('public."ReceiptDuplicateScoreBand"');

    IF actual_labels IS DISTINCT FROM ARRAY['EXACT', 'LIKELY']::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptDuplicateScoreBand differs.';
    END IF;

    SELECT array_agg(e.enumlabel::TEXT ORDER BY e.enumsortorder)
    INTO actual_labels
    FROM pg_enum e
    WHERE e.enumtypid = to_regtype('public."ReceiptDuplicateReviewStatus"');

    IF actual_labels IS DISTINCT FROM ARRAY['PENDING', 'SAVED_ANYWAY', 'SUPERSEDED']::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptDuplicateReviewStatus differs.';
    END IF;

    SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
    INTO actual_columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ReceiptCaptureBatch';

    IF actual_columns IS DISTINCT FROM ARRAY[
        'ReceiptCaptureBatch_ID',
        'BusinessProfile_ID',
        'ReceiptCaptureBatch_ClientBatchKey',
        'ReceiptCaptureBatch_ExpectedReceiptCount',
        'ReceiptCaptureBatch_Status',
        'ReceiptCaptureBatch_CreatedAt',
        'ReceiptCaptureBatch_FinishedAt'
    ]::TEXT[]
    OR EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('ReceiptCaptureBatch_ID', 'int4', 'NO', NULL::INTEGER),
                ('BusinessProfile_ID', 'int4', 'NO', NULL::INTEGER),
                ('ReceiptCaptureBatch_ClientBatchKey', 'varchar', 'NO', 100),
                ('ReceiptCaptureBatch_ExpectedReceiptCount', 'int4', 'NO', NULL::INTEGER),
                ('ReceiptCaptureBatch_Status', 'ReceiptCaptureBatchStatus', 'NO', NULL::INTEGER),
                ('ReceiptCaptureBatch_CreatedAt', 'timestamp', 'NO', NULL::INTEGER),
                ('ReceiptCaptureBatch_FinishedAt', 'timestamp', 'YES', NULL::INTEGER)
        ) AS expected(column_name, udt_name, is_nullable, maximum_length)
        LEFT JOIN information_schema.columns actual
          ON actual.table_schema = 'public'
         AND actual.table_name = 'ReceiptCaptureBatch'
         AND actual.column_name = expected.column_name
        WHERE actual.column_name IS NULL
           OR actual.udt_name <> expected.udt_name
           OR actual.is_nullable <> expected.is_nullable
           OR actual.character_maximum_length IS DISTINCT FROM expected.maximum_length
    )
    OR pg_get_serial_sequence('public."ReceiptCaptureBatch"', 'ReceiptCaptureBatch_ID')
        IS DISTINCT FROM 'public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'
    OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptCaptureBatch'
          AND column_name = 'ReceiptCaptureBatch_Status'
          AND column_default LIKE '%COLLECTING%'
    )
    OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptCaptureBatch'
          AND column_name = 'ReceiptCaptureBatch_CreatedAt'
          AND column_default = 'CURRENT_TIMESTAMP'
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptCaptureBatch metadata differs.';
    END IF;

    SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
    INTO actual_columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ReceiptDuplicateCandidate';

    IF actual_columns IS DISTINCT FROM ARRAY[
        'ReceiptDuplicateCandidate_ID',
        'BusinessProfile_ID',
        'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
        'ReceiptDuplicateCandidate_CandidateReceiptScan_ID',
        'ReceiptDuplicateCandidate_CandidateExpenseRecord_ID',
        'ReceiptDuplicateCandidate_DetectorVersion',
        'ReceiptDuplicateCandidate_SourceFingerprint',
        'ReceiptDuplicateCandidate_ReasonCodes',
        'ReceiptDuplicateCandidate_ScoreBand',
        'ReceiptDuplicateCandidate_ReviewStatus',
        'ReceiptDuplicateCandidate_DecisionSetHash',
        'ReceiptDuplicateCandidate_DecidedByUser_ID',
        'ReceiptDuplicateCandidate_CreatedAt',
        'ReceiptDuplicateCandidate_DecidedAt'
    ]::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptDuplicateCandidate columns differ.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('ReceiptDuplicateCandidate_ID', 'int4', 'NO', NULL::INTEGER),
                ('BusinessProfile_ID', 'int4', 'NO', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_SourceReceiptScan_ID', 'int4', 'NO', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_CandidateReceiptScan_ID', 'int4', 'YES', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_CandidateExpenseRecord_ID', 'int4', 'YES', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_DetectorVersion', 'varchar', 'NO', 64),
                ('ReceiptDuplicateCandidate_SourceFingerprint', 'bpchar', 'NO', 64),
                ('ReceiptDuplicateCandidate_ReasonCodes', 'jsonb', 'NO', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_ScoreBand', 'ReceiptDuplicateScoreBand', 'NO', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_ReviewStatus', 'ReceiptDuplicateReviewStatus', 'NO', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_DecisionSetHash', 'bpchar', 'YES', 64),
                ('ReceiptDuplicateCandidate_DecidedByUser_ID', 'int4', 'YES', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_CreatedAt', 'timestamp', 'NO', NULL::INTEGER),
                ('ReceiptDuplicateCandidate_DecidedAt', 'timestamp', 'YES', NULL::INTEGER)
        ) AS expected(column_name, udt_name, is_nullable, maximum_length)
        LEFT JOIN information_schema.columns actual
          ON actual.table_schema = 'public'
         AND actual.table_name = 'ReceiptDuplicateCandidate'
         AND actual.column_name = expected.column_name
        WHERE actual.column_name IS NULL
           OR actual.udt_name <> expected.udt_name
           OR actual.is_nullable <> expected.is_nullable
           OR actual.character_maximum_length IS DISTINCT FROM expected.maximum_length
    )
    OR pg_get_serial_sequence(
        'public."ReceiptDuplicateCandidate"',
        'ReceiptDuplicateCandidate_ID'
    ) IS DISTINCT FROM 'public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"'
    OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptDuplicateCandidate'
          AND column_name = 'ReceiptDuplicateCandidate_ReviewStatus'
          AND column_default LIKE '%PENDING%'
    )
    OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptDuplicateCandidate'
          AND column_name = 'ReceiptDuplicateCandidate_CreatedAt'
          AND column_default = 'CURRENT_TIMESTAMP'
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: ReceiptDuplicateCandidate metadata differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('ReceiptCaptureBatch_ID', 'int4', 'YES', NULL::INTEGER),
                ('ReceiptScan_EvidenceDeletedAt', 'timestamp', 'YES', NULL::INTEGER),
                ('ReceiptScan_EvidenceDeletionRequestedAt', 'timestamp', 'YES', NULL::INTEGER),
                ('ReceiptScan_ReceiptOrdinal', 'int4', 'YES', NULL::INTEGER),
                ('ReceiptScan_ScanRevision', 'int4', 'NO', NULL::INTEGER),
                ('ReceiptScan_SemanticFingerprint', 'bpchar', 'YES', 64),
                ('ReceiptScan_SourceImageHash', 'bpchar', 'YES', 64),
                ('ReceiptScan_ImageFile', 'varchar', 'YES', 255)
        ) AS expected(column_name, udt_name, is_nullable, maximum_length)
        LEFT JOIN information_schema.columns actual
          ON actual.table_schema = 'public'
         AND actual.table_name = 'ReceiptScan'
         AND actual.column_name = expected.column_name
        WHERE actual.column_name IS NULL
           OR actual.udt_name <> expected.udt_name
           OR actual.is_nullable <> expected.is_nullable
           OR actual.character_maximum_length IS DISTINCT FROM expected.maximum_length
    )
    OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptScan'
          AND column_name = 'ReceiptScan_ScanRevision'
          AND column_default = '0'
    )
    OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReceiptPurgeJob'
          AND column_name = 'ReceiptPurgeJob_Mode'
          AND udt_name = 'ReceiptPurgeMode'
          AND is_nullable = 'NO'
          AND column_default IS NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: altered column metadata differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_pkey', 'p', '', ''),
                ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_client_key_check', 'c', '', ''),
                ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_expected_count_check', 'c', '', ''),
                ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_finished_check', 'c', '', ''),
                ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_timestamps_check', 'c', '', ''),
                ('ReceiptCaptureBatch', 'ReceiptCaptureBatch_BusinessProfile_ID_fkey', 'f', 'c', 'c'),
                ('ReceiptScan', 'ReceiptScan_scan_revision_check', 'c', '', ''),
                ('ReceiptScan', 'ReceiptScan_semantic_fingerprint_check', 'c', '', ''),
                ('ReceiptScan', 'ReceiptScan_evidence_deletion_timestamps_check', 'c', '', ''),
                ('ReceiptScan', 'ReceiptScan_batch_link_check', 'c', '', ''),
                ('ReceiptScan', 'ReceiptScan_source_image_hash_check', 'c', '', ''),
                ('ReceiptScan', 'ReceiptScan_ReceiptCaptureBatch_ID_BusinessProfile_ID_fkey', 'f', 'a', 'c'),
                ('ReceiptPurgeJob', 'ReceiptPurgeJob_active_target_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_pkey', 'p', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_target_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_detector_version_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_source_fingerprint_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_decision_set_hash_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_reason_codes_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_decision_lifecycle_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_decision_timestamp_check', 'c', '', ''),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_profile_fkey', 'f', 'c', 'c'),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_decision_owner_fkey', 'f', 'a', 'c'),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_source_scan_fkey', 'f', 'c', 'c'),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_scan_target_fkey', 'f', 'c', 'c'),
                ('ReceiptDuplicateCandidate', 'ReceiptDuplicateCandidate_expense_target_fkey', 'f', 'c', 'c')
        ) AS expected(table_name, constraint_name, constraint_type, delete_action, update_action)
        LEFT JOIN pg_class target
          ON target.relnamespace = 'public'::regnamespace
         AND target.relname = expected.table_name
        LEFT JOIN pg_constraint actual
          ON actual.conrelid = target.oid
         AND actual.conname = expected.constraint_name
        WHERE actual.oid IS NULL
           OR actual.contype::TEXT <> expected.constraint_type
           OR NOT actual.convalidated
           OR (
               expected.constraint_type IN ('p', 'f')
               AND (actual.condeferrable OR actual.condeferred)
           )
           OR (
               expected.constraint_type = 'f'
               AND (
                   actual.confdeltype::TEXT <> expected.delete_action
                   OR actual.confupdtype::TEXT <> expected.update_action
                   OR actual.confmatchtype::TEXT <> 's'
               )
           )
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: a required constraint differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                (
                    'ReceiptCaptureBatch',
                    'ReceiptCaptureBatch_client_key_check',
                    $expected$((char_length(("ReceiptCaptureBatch_ClientBatchKey")::text) >= 8) AND (char_length(("ReceiptCaptureBatch_ClientBatchKey")::text) <= 100))$expected$
                ),
                (
                    'ReceiptCaptureBatch',
                    'ReceiptCaptureBatch_expected_count_check',
                    $expected$(("ReceiptCaptureBatch_ExpectedReceiptCount" >= 2) AND ("ReceiptCaptureBatch_ExpectedReceiptCount" <= 8))$expected$
                ),
                (
                    'ReceiptCaptureBatch',
                    'ReceiptCaptureBatch_finished_check',
                    $expected$(((("ReceiptCaptureBatch_Status")::text = ANY (ARRAY['COMPLETE'::text, 'CANCELLED'::text])) AND ("ReceiptCaptureBatch_FinishedAt" IS NOT NULL)) OR ((("ReceiptCaptureBatch_Status")::text <> ALL (ARRAY['COMPLETE'::text, 'CANCELLED'::text])) AND ("ReceiptCaptureBatch_FinishedAt" IS NULL)))$expected$
                ),
                (
                    'ReceiptCaptureBatch',
                    'ReceiptCaptureBatch_timestamps_check',
                    $expected$(("ReceiptCaptureBatch_FinishedAt" IS NULL) OR ("ReceiptCaptureBatch_FinishedAt" >= "ReceiptCaptureBatch_CreatedAt"))$expected$
                ),
                (
                    'ReceiptScan',
                    'ReceiptScan_scan_revision_check',
                    $expected$("ReceiptScan_ScanRevision" >= 0)$expected$
                ),
                (
                    'ReceiptScan',
                    'ReceiptScan_semantic_fingerprint_check',
                    $expected$(("ReceiptScan_SemanticFingerprint" IS NULL) OR ("ReceiptScan_SemanticFingerprint" ~ '^[0-9a-f]{64}$'::text))$expected$
                ),
                (
                    'ReceiptScan',
                    'ReceiptScan_evidence_deletion_timestamps_check',
                    $expected$(("ReceiptScan_EvidenceDeletedAt" IS NULL) OR (("ReceiptScan_EvidenceDeletionRequestedAt" IS NOT NULL) AND ("ReceiptScan_EvidenceDeletedAt" >= "ReceiptScan_EvidenceDeletionRequestedAt")))$expected$
                ),
                (
                    'ReceiptScan',
                    'ReceiptScan_batch_link_check',
                    $expected$((("ReceiptCaptureBatch_ID" IS NULL) AND ("ReceiptScan_ReceiptOrdinal" IS NULL)) OR (("ReceiptCaptureBatch_ID" IS NOT NULL) AND ("ReceiptScan_ReceiptOrdinal" IS NOT NULL) AND ("BusinessProfile_ID" IS NOT NULL) AND (("ReceiptScan_ReceiptOrdinal" >= 1) AND ("ReceiptScan_ReceiptOrdinal" <= 8))))$expected$
                ),
                (
                    'ReceiptScan',
                    'ReceiptScan_source_image_hash_check',
                    $expected$(("ReceiptScan_SourceImageHash" IS NULL) OR ("ReceiptScan_SourceImageHash" ~ '^[0-9a-f]{64}$'::text))$expected$
                ),
                (
                    'ReceiptPurgeJob',
                    'ReceiptPurgeJob_active_target_check',
                    $expected$(("ReceiptPurgeJob_Status" <> ALL (ARRAY['PENDING'::"ReceiptPurgeStatus", 'PROCESSING'::"ReceiptPurgeStatus", 'RETRY'::"ReceiptPurgeStatus"])) OR (("ReceiptScan_ID" IS NOT NULL) AND ("ReceiptScan_BusinessProfile_ID" IS NOT NULL)))$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_target_check',
                    $expected$((("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL) AND ("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NULL) AND ("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" <> "ReceiptDuplicateCandidate_SourceReceiptScan_ID")) OR (("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NULL) AND ("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL)))$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_detector_version_check',
                    $expected$(btrim(("ReceiptDuplicateCandidate_DetectorVersion")::text) <> ''::text)$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_source_fingerprint_check',
                    $expected$("ReceiptDuplicateCandidate_SourceFingerprint" ~ '^[0-9a-f]{64}$'::text)$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_decision_set_hash_check',
                    $expected$(("ReceiptDuplicateCandidate_DecisionSetHash" IS NULL) OR ("ReceiptDuplicateCandidate_DecisionSetHash" ~ '^[0-9a-f]{64}$'::text))$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_reason_codes_check',
                    $expected$((jsonb_typeof("ReceiptDuplicateCandidate_ReasonCodes") = 'array'::text) AND (jsonb_array_length("ReceiptDuplicateCandidate_ReasonCodes") > 0))$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_decision_lifecycle_check',
                    $expected$((("ReceiptDuplicateCandidate_ReviewStatus" = 'SAVED_ANYWAY'::"ReceiptDuplicateReviewStatus") AND ("ReceiptDuplicateCandidate_DecisionSetHash" IS NOT NULL) AND ("ReceiptDuplicateCandidate_DecidedByUser_ID" IS NOT NULL) AND ("ReceiptDuplicateCandidate_DecidedAt" IS NOT NULL)) OR (("ReceiptDuplicateCandidate_ReviewStatus" = ANY (ARRAY['PENDING'::"ReceiptDuplicateReviewStatus", 'SUPERSEDED'::"ReceiptDuplicateReviewStatus"])) AND ("ReceiptDuplicateCandidate_DecisionSetHash" IS NULL) AND ("ReceiptDuplicateCandidate_DecidedByUser_ID" IS NULL) AND ("ReceiptDuplicateCandidate_DecidedAt" IS NULL)))$expected$
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_decision_timestamp_check',
                    $expected$(("ReceiptDuplicateCandidate_DecidedAt" IS NULL) OR ("ReceiptDuplicateCandidate_DecidedAt" >= "ReceiptDuplicateCandidate_CreatedAt"))$expected$
                )
        ) AS expected(table_name, constraint_name, expression)
        LEFT JOIN pg_class target
          ON target.relnamespace = 'public'::regnamespace
         AND target.relname = expected.table_name
        LEFT JOIN pg_constraint actual
          ON actual.conrelid = target.oid
         AND actual.conname = expected.constraint_name
        WHERE actual.oid IS NULL
           OR actual.contype <> 'c'
           OR NOT actual.convalidated
           OR actual.connoinherit
           OR regexp_replace(
               pg_get_expr(actual.conbin, actual.conrelid, false),
               '[[:space:]]+',
               ' ',
               'g'
           ) IS DISTINCT FROM expected.expression
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: a required check definition differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                (
                    'ReceiptCaptureBatch',
                    'ReceiptCaptureBatch_BusinessProfile_ID_fkey',
                    ARRAY['BusinessProfile_ID']::TEXT[],
                    'BusinessProfile',
                    ARRAY['BusinessProfile_ID']::TEXT[]
                ),
                (
                    'ReceiptScan',
                    'ReceiptScan_ReceiptCaptureBatch_ID_BusinessProfile_ID_fkey',
                    ARRAY['ReceiptCaptureBatch_ID', 'BusinessProfile_ID'],
                    'ReceiptCaptureBatch',
                    ARRAY['ReceiptCaptureBatch_ID', 'BusinessProfile_ID']
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_profile_fkey',
                    ARRAY['BusinessProfile_ID'],
                    'BusinessProfile',
                    ARRAY['BusinessProfile_ID']
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_decision_owner_fkey',
                    ARRAY['BusinessProfile_ID', 'ReceiptDuplicateCandidate_DecidedByUser_ID'],
                    'BusinessProfile',
                    ARRAY['BusinessProfile_ID', 'User_ID']
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_source_scan_fkey',
                    ARRAY[
                        'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
                        'BusinessProfile_ID'
                    ],
                    'ReceiptScan',
                    ARRAY['ReceiptScan_ID', 'BusinessProfile_ID']
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_scan_target_fkey',
                    ARRAY[
                        'ReceiptDuplicateCandidate_CandidateReceiptScan_ID',
                        'BusinessProfile_ID'
                    ],
                    'ReceiptScan',
                    ARRAY['ReceiptScan_ID', 'BusinessProfile_ID']
                ),
                (
                    'ReceiptDuplicateCandidate',
                    'ReceiptDuplicateCandidate_expense_target_fkey',
                    ARRAY[
                        'ReceiptDuplicateCandidate_CandidateExpenseRecord_ID',
                        'BusinessProfile_ID'
                    ],
                    'ExpenseRecord',
                    ARRAY['ExpenseRecord_ID', 'BusinessProfile_ID']
                )
        ) AS expected(
            source_table,
            constraint_name,
            source_columns,
            target_table,
            target_columns
        )
        LEFT JOIN pg_class source_relation
          ON source_relation.relnamespace = 'public'::regnamespace
         AND source_relation.relname = expected.source_table
        LEFT JOIN pg_constraint constraint_metadata
          ON constraint_metadata.conrelid = source_relation.oid
         AND constraint_metadata.conname = expected.constraint_name
         AND constraint_metadata.contype = 'f'
        LEFT JOIN pg_class target_relation
          ON target_relation.oid = constraint_metadata.confrelid
        LEFT JOIN LATERAL (
            SELECT array_agg(attribute.attname::TEXT ORDER BY key_position.ordinality)
                AS column_names
            FROM unnest(constraint_metadata.conkey::SMALLINT[])
                WITH ORDINALITY key_position(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = source_relation.oid
             AND attribute.attnum = key_position.attnum
        ) source_key ON TRUE
        LEFT JOIN LATERAL (
            SELECT array_agg(attribute.attname::TEXT ORDER BY key_position.ordinality)
                AS column_names
            FROM unnest(constraint_metadata.confkey::SMALLINT[])
                WITH ORDINALITY key_position(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = target_relation.oid
             AND attribute.attnum = key_position.attnum
        ) target_key ON TRUE
        WHERE target_relation.relname IS DISTINCT FROM expected.target_table
           OR target_relation.relnamespace IS DISTINCT FROM 'public'::regnamespace
           OR source_key.column_names IS DISTINCT FROM expected.source_columns
           OR target_key.column_names IS DISTINCT FROM expected.target_columns
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: a foreign-key definition differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('ReceiptCaptureBatch_profile_created_idx', 'ReceiptCaptureBatch', FALSE, FALSE),
                ('ReceiptCaptureBatch_pkey', 'ReceiptCaptureBatch', TRUE, FALSE),
                ('ReceiptCaptureBatch_profile_client_key', 'ReceiptCaptureBatch', TRUE, FALSE),
                ('ReceiptCaptureBatch_ID_BusinessProfile_ID_key', 'ReceiptCaptureBatch', TRUE, FALSE),
                ('ReceiptScan_batch_ordinal_key', 'ReceiptScan', TRUE, FALSE),
                ('ReceiptScan_profile_source_image_hash_idx', 'ReceiptScan', FALSE, FALSE),
                ('ReceiptScan_history_status_created_idx', 'ReceiptScan', FALSE, FALSE),
                ('ReceiptScan_history_created_idx', 'ReceiptScan', FALSE, FALSE),
                ('ReceiptScan_profile_semantic_fingerprint_idx', 'ReceiptScan', FALSE, FALSE),
                ('ExpenseRecord_ID_BusinessProfile_ID_key', 'ExpenseRecord', TRUE, FALSE),
                ('ReceiptDuplicateCandidate_source_review_idx', 'ReceiptDuplicateCandidate', FALSE, FALSE),
                ('ReceiptDuplicateCandidate_pkey', 'ReceiptDuplicateCandidate', TRUE, FALSE),
                ('ReceiptDuplicateCandidate_scan_target_idx', 'ReceiptDuplicateCandidate', FALSE, FALSE),
                ('ReceiptDuplicateCandidate_expense_target_idx', 'ReceiptDuplicateCandidate', FALSE, FALSE),
                ('ReceiptDuplicateCandidate_decision_owner_idx', 'ReceiptDuplicateCandidate', FALSE, FALSE),
                ('ReceiptDuplicateCandidate_source_scan_target_key', 'ReceiptDuplicateCandidate', TRUE, TRUE),
                ('ReceiptDuplicateCandidate_source_expense_target_key', 'ReceiptDuplicateCandidate', TRUE, TRUE),
                ('ReceiptPurgeJob_profile_receipt_idx', 'ReceiptPurgeJob', FALSE, FALSE),
                ('ReceiptPurgeJob_active_profile_receipt_key', 'ReceiptPurgeJob', TRUE, TRUE)
        ) AS expected(index_name, table_name, is_unique, is_partial)
        LEFT JOIN pg_class index_relation
          ON index_relation.relnamespace = 'public'::regnamespace
         AND index_relation.relname = expected.index_name
         AND index_relation.relkind = 'i'
        LEFT JOIN pg_index actual ON actual.indexrelid = index_relation.oid
        LEFT JOIN pg_class target ON target.oid = actual.indrelid
        LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
        WHERE actual.indexrelid IS NULL
           OR target.relname <> expected.table_name
           OR actual.indisunique <> expected.is_unique
           OR actual.indisprimary <> (
               expected.index_name IN (
                   'ReceiptCaptureBatch_pkey',
                   'ReceiptDuplicateCandidate_pkey'
               )
           )
           OR actual.indisexclusion
           OR NOT actual.indimmediate
           OR (actual.indpred IS NOT NULL) <> expected.is_partial
           OR NOT actual.indisvalid
           OR NOT actual.indisready
           OR NOT actual.indislive
           OR actual.indnullsnotdistinct
           OR actual.indnatts <> actual.indnkeyatts
           OR access_method.amname <> 'btree'
    )
    OR to_regclass('public."ReceiptScan_BusinessProfile_ID_idx"') IS NOT NULL
    OR to_regclass('public."ReceiptPurgeJob_profile_receipt_key"') IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: a required index differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                (
                    'ReceiptCaptureBatch_profile_created_idx',
                    ARRAY[
                        'BusinessProfile_ID',
                        'ReceiptCaptureBatch_CreatedAt',
                        'ReceiptCaptureBatch_ID'
                    ]::TEXT[],
                    ARRAY[0, 0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL, NULL]::TEXT[],
                    ARRAY[
                        'pg_catalog.int4_ops',
                        'pg_catalog.timestamp_ops',
                        'pg_catalog.int4_ops'
                    ]::TEXT[]
                ),
                (
                    'ReceiptCaptureBatch_pkey',
                    ARRAY['ReceiptCaptureBatch_ID'],
                    ARRAY[0]::SMALLINT[],
                    ARRAY[NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptCaptureBatch_profile_client_key',
                    ARRAY['BusinessProfile_ID', 'ReceiptCaptureBatch_ClientBatchKey'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, 'pg_catalog.default']::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.text_ops']::TEXT[]
                ),
                (
                    'ReceiptCaptureBatch_ID_BusinessProfile_ID_key',
                    ARRAY['ReceiptCaptureBatch_ID', 'BusinessProfile_ID'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptScan_batch_ordinal_key',
                    ARRAY['ReceiptCaptureBatch_ID', 'ReceiptScan_ReceiptOrdinal'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptScan_profile_source_image_hash_idx',
                    ARRAY['BusinessProfile_ID', 'ReceiptScan_SourceImageHash'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, 'pg_catalog.default']::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.bpchar_ops']::TEXT[]
                ),
                (
                    'ReceiptScan_history_status_created_idx',
                    ARRAY[
                        'BusinessProfile_ID',
                        'ReceiptScan_ConfirmationStatus',
                        'ReceiptScan_ProcessingStatus',
                        'ReceiptScan_CreatedAt',
                        'ReceiptScan_ID'
                    ],
                    ARRAY[0, 0, 0, 3, 3]::SMALLINT[],
                    ARRAY[NULL, 'pg_catalog.default', 'pg_catalog.default', NULL, NULL]::TEXT[],
                    ARRAY[
                        'pg_catalog.int4_ops',
                        'pg_catalog.text_ops',
                        'pg_catalog.text_ops',
                        'pg_catalog.timestamp_ops',
                        'pg_catalog.int4_ops'
                    ]::TEXT[]
                ),
                (
                    'ReceiptScan_history_created_idx',
                    ARRAY['BusinessProfile_ID', 'ReceiptScan_CreatedAt', 'ReceiptScan_ID'],
                    ARRAY[0, 3, 3]::SMALLINT[],
                    ARRAY[NULL, NULL, NULL]::TEXT[],
                    ARRAY[
                        'pg_catalog.int4_ops',
                        'pg_catalog.timestamp_ops',
                        'pg_catalog.int4_ops'
                    ]::TEXT[]
                ),
                (
                    'ReceiptScan_profile_semantic_fingerprint_idx',
                    ARRAY['BusinessProfile_ID', 'ReceiptScan_SemanticFingerprint'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, 'pg_catalog.default']::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.bpchar_ops']::TEXT[]
                ),
                (
                    'ExpenseRecord_ID_BusinessProfile_ID_key',
                    ARRAY['ExpenseRecord_ID', 'BusinessProfile_ID'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_source_review_idx',
                    ARRAY[
                        'BusinessProfile_ID',
                        'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
                        'ReceiptDuplicateCandidate_ReviewStatus',
                        'ReceiptDuplicateCandidate_ID'
                    ],
                    ARRAY[0, 0, 0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL, NULL, NULL]::TEXT[],
                    ARRAY[
                        'pg_catalog.int4_ops',
                        'pg_catalog.int4_ops',
                        'pg_catalog.enum_ops',
                        'pg_catalog.int4_ops'
                    ]::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_pkey',
                    ARRAY['ReceiptDuplicateCandidate_ID'],
                    ARRAY[0]::SMALLINT[],
                    ARRAY[NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_scan_target_idx',
                    ARRAY[
                        'ReceiptDuplicateCandidate_CandidateReceiptScan_ID',
                        'BusinessProfile_ID'
                    ],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_expense_target_idx',
                    ARRAY[
                        'ReceiptDuplicateCandidate_CandidateExpenseRecord_ID',
                        'BusinessProfile_ID'
                    ],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_decision_owner_idx',
                    ARRAY['BusinessProfile_ID', 'ReceiptDuplicateCandidate_DecidedByUser_ID'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_source_scan_target_key',
                    ARRAY[
                        'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
                        'ReceiptDuplicateCandidate_CandidateReceiptScan_ID',
                        'ReceiptDuplicateCandidate_DetectorVersion'
                    ],
                    ARRAY[0, 0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL, 'pg_catalog.default']::TEXT[],
                    ARRAY[
                        'pg_catalog.int4_ops',
                        'pg_catalog.int4_ops',
                        'pg_catalog.text_ops'
                    ]::TEXT[]
                ),
                (
                    'ReceiptDuplicateCandidate_source_expense_target_key',
                    ARRAY[
                        'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
                        'ReceiptDuplicateCandidate_CandidateExpenseRecord_ID',
                        'ReceiptDuplicateCandidate_DetectorVersion'
                    ],
                    ARRAY[0, 0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL, 'pg_catalog.default']::TEXT[],
                    ARRAY[
                        'pg_catalog.int4_ops',
                        'pg_catalog.int4_ops',
                        'pg_catalog.text_ops'
                    ]::TEXT[]
                ),
                (
                    'ReceiptPurgeJob_profile_receipt_idx',
                    ARRAY['BusinessProfile_ID', 'ReceiptScan_ID'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                ),
                (
                    'ReceiptPurgeJob_active_profile_receipt_key',
                    ARRAY['BusinessProfile_ID', 'ReceiptScan_ID'],
                    ARRAY[0, 0]::SMALLINT[],
                    ARRAY[NULL, NULL]::TEXT[],
                    ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::TEXT[]
                )
        ) AS expected(index_name, column_names, options, collations, operator_classes)
        LEFT JOIN pg_class index_relation
          ON index_relation.relnamespace = 'public'::regnamespace
         AND index_relation.relname = expected.index_name
         AND index_relation.relkind = 'i'
        LEFT JOIN pg_index index_metadata
          ON index_metadata.indexrelid = index_relation.oid
        LEFT JOIN LATERAL (
            SELECT
                array_agg(attribute.attname::TEXT ORDER BY key_position.ordinality)
                    AS column_names,
                array_agg(index_option.option ORDER BY key_position.ordinality) AS options,
                array_agg(
                    CASE
                        WHEN collation_position.collation_oid = 0 THEN NULL
                        ELSE collation_namespace.nspname || '.' || index_collation.collname
                    END
                    ORDER BY key_position.ordinality
                ) AS collations,
                array_agg(
                    operator_namespace.nspname || '.' || operator_class.opcname
                    ORDER BY key_position.ordinality
                ) AS operator_classes
            FROM unnest(index_metadata.indkey::SMALLINT[])
                WITH ORDINALITY key_position(attnum, ordinality)
            JOIN LATERAL unnest(index_metadata.indoption::SMALLINT[])
                WITH ORDINALITY index_option(option, ordinality)
              ON index_option.ordinality = key_position.ordinality
            JOIN LATERAL unnest(index_metadata.indcollation::OID[])
                WITH ORDINALITY collation_position(collation_oid, ordinality)
              ON collation_position.ordinality = key_position.ordinality
            JOIN LATERAL unnest(index_metadata.indclass::OID[])
                WITH ORDINALITY operator_position(operator_class_oid, ordinality)
              ON operator_position.ordinality = key_position.ordinality
            JOIN pg_attribute attribute
              ON attribute.attrelid = index_metadata.indrelid
             AND attribute.attnum = key_position.attnum
            LEFT JOIN pg_collation index_collation
              ON index_collation.oid = collation_position.collation_oid
            LEFT JOIN pg_namespace collation_namespace
              ON collation_namespace.oid = index_collation.collnamespace
            JOIN pg_opclass operator_class
              ON operator_class.oid = operator_position.operator_class_oid
            JOIN pg_namespace operator_namespace
              ON operator_namespace.oid = operator_class.opcnamespace
            WHERE key_position.ordinality <= index_metadata.indnkeyatts
        ) actual ON TRUE
        WHERE actual.column_names IS DISTINCT FROM expected.column_names
           OR actual.options IS DISTINCT FROM expected.options
           OR actual.collations IS DISTINCT FROM expected.collations
           OR actual.operator_classes IS DISTINCT FROM expected.operator_classes
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: an index key definition differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                (
                    'ReceiptDuplicateCandidate_source_scan_target_key',
                    $predicate$("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL)$predicate$
                ),
                (
                    'ReceiptDuplicateCandidate_source_expense_target_key',
                    $predicate$("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL)$predicate$
                ),
                (
                    'ReceiptPurgeJob_active_profile_receipt_key',
                    $predicate$("ReceiptPurgeJob_Status" = ANY (ARRAY['PENDING'::"ReceiptPurgeStatus", 'PROCESSING'::"ReceiptPurgeStatus", 'RETRY'::"ReceiptPurgeStatus"]))$predicate$
                )
        ) AS expected(index_name, predicate)
        JOIN pg_class index_relation
          ON index_relation.relnamespace = 'public'::regnamespace
         AND index_relation.relname = expected.index_name
        JOIN pg_index actual ON actual.indexrelid = index_relation.oid
        WHERE pg_get_expr(actual.indpred, actual.indrelid, false)
            IS DISTINCT FROM expected.predicate
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: a partial-index predicate differs.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class target
        WHERE target.oid IN (
            'public."ReceiptCaptureBatch"'::regclass,
            'public."ReceiptDuplicateCandidate"'::regclass,
            'public."ReceiptScan"'::regclass,
            'public."ReceiptPurgeJob"'::regclass,
            'public."ExpenseRecord"'::regclass
        )
          AND (target.relkind <> 'r' OR NOT target.relrowsecurity)
    )
    OR EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid IN (
            'public."ReceiptCaptureBatch"'::regclass,
            'public."ReceiptDuplicateCandidate"'::regclass,
            'public."ReceiptScan"'::regclass,
            'public."ReceiptPurgeJob"'::regclass,
            'public."ExpenseRecord"'::regclass
        )
    )
    OR EXISTS (
        SELECT 1
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
        LEFT JOIN pg_roles role ON role.oid = privilege.grantee
        WHERE relation.oid IN (
            'public."ReceiptCaptureBatch"'::regclass,
            'public."ReceiptDuplicateCandidate"'::regclass,
            'public."ReceiptScan"'::regclass,
            'public."ReceiptPurgeJob"'::regclass,
            'public."ExpenseRecord"'::regclass,
            'public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'::regclass,
            'public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"'::regclass,
            'public."ReceiptScan_ReceiptScan_ID_seq"'::regclass,
            'public."ReceiptPurgeJob_ReceiptPurgeJob_ID_seq"'::regclass,
            'public."ExpenseRecord_ExpenseRecord_ID_seq"'::regclass
        )
          AND (
              privilege.grantee = 0
              OR role.rolname IN ('anon', 'authenticated')
          )
    )
    OR EXISTS (
        SELECT 1
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
        JOIN pg_roles role ON role.oid = privilege.grantee
        WHERE relation.oid IN (
            'public."ReceiptCaptureBatch"'::regclass,
            'public."ReceiptDuplicateCandidate"'::regclass,
            'public."ReceiptPurgeJob"'::regclass,
            'public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'::regclass,
            'public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"'::regclass,
            'public."ReceiptPurgeJob_ReceiptPurgeJob_ID_seq"'::regclass
          )
          AND role.rolname = 'service_role'
    ) THEN
        RAISE EXCEPTION USING MESSAGE =
            'Phase 2 reconciliation postcondition failed: deny-all table security differs.';
    END IF;
END
$reconcile$;
