import { createHash } from "node:crypto";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";

/*
 * WHY THIS EXISTS.
 *
 * A receipt scan failed on a real phone with "FinSight's server had a problem
 * with that", and nothing about that message was true: the photo was fine,
 * the request was fine, and retrying could never have worked. The process was
 * running code that writes `ReceiptScan_UploadKey` against a database where
 * two migrations had never been applied, so every scan died on a Prisma P2022
 * — "the column does not exist" — which fell through the error handler as a
 * generic 500.
 *
 * The defect was not in the scan path. It was that a process is allowed to
 * start, pass its health check and accept traffic while the schema it was
 * compiled against and the schema it is talking to are different things. Every
 * feature that touches a missing column is broken from the first request, and
 * the only symptom is an opaque 500 somewhere far from the cause.
 *
 * So the divergence is caught at boot, where it is one line in a log instead
 * of a mystery in production, and the process refuses to serve rather than
 * serving something broken. A deploy that forgets its migration now fails
 * loudly and immediately, which is the outcome that was wanted all along.
 */

/**
 * `prisma/migrations` relative to this file, which resolves correctly from
 * both `src/config` (dev, via tsx) and `dist/config` (the built image, whose
 * Dockerfile copies `prisma/` beside `dist/` for exactly this reason).
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "prisma", "migrations");
const PHASE2_SCANNER_MIGRATION = "20260913100918_receipt_capture_batches_and_scan_revision";
const PHASE2_SCANNER_LEGACY_CHECKSUM = "a0e4f79275cbb0e975f16d4675776ecf954395eaa6dd5900f15cd3f73030ca5b";
const PHASE2_SCANNER_RECONCILIATION = "20260913230000_reconcile_phase2_scanner_migration_drift";

export type MigrationDriftStatus = "ok" | "drift" | "unknown";
export type MigrationVerificationFailure =
  | "database_unavailable"
  | "migration_files_unreadable"
  | "migration_history_unverifiable"
  | "schema_shape_unverifiable";

export interface MigrationDrift {
  status: MigrationDriftStatus;
  /** On disk, never recorded as finished against this database. */
  pending: string[];
  /** Started against this database and never finished — a half-applied schema. */
  failed: string[];
  /** Applied migrations whose recorded SQL no longer matches this build. */
  checksumMismatches?: MigrationChecksumMismatch[];
  /** Required Phase 2 objects or database security controls that are absent. */
  schemaIssues?: string[];
  /** Stable classification used by the boot gate when status is "unknown". */
  verificationFailure?: MigrationVerificationFailure;
  /** Why the check could not reach a verdict. Only set when status is "unknown". */
  reason?: string;
}

export interface MigrationChecksumMismatch {
  migration: string;
  expectedChecksum: string;
  actualChecksum: string | null;
}

interface MigrationRow {
  migration_name: string;
  checksum?: string | null;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/**
 * The comparison itself, kept pure so it can be tested without a database.
 *
 * A migration counts as applied only when it finished and was not rolled back.
 * Anything Prisma recorded but never finished is reported separately as
 * `failed`: that database is not merely behind, it is half-way through a
 * migration, and `migrate deploy` will refuse to move until it is resolved.
 */
export function compareMigrations(
  onDisk: string[],
  rows: MigrationRow[],
  expectedChecksums?: ReadonlyMap<string, string>,
): Omit<MigrationDrift, "reason"> {
  const applied = new Set<string>();
  const appliedRows = new Map<string, MigrationRow>();
  const failed: string[] = [];
  for (const row of rows) {
    if (row.rolled_back_at !== null) continue;
    if (row.finished_at !== null) {
      applied.add(row.migration_name);
      appliedRows.set(row.migration_name, row);
    }
    else failed.push(row.migration_name);
  }
  const pending = onDisk.filter((name) => !applied.has(name));
  if (!expectedChecksums) {
    return { status: pending.length > 0 || failed.length > 0 ? "drift" : "ok", pending, failed };
  }

  const reconciliation = appliedRows.get(PHASE2_SCANNER_RECONCILIATION);
  const reconciliationChecksum = expectedChecksums.get(PHASE2_SCANNER_RECONCILIATION);
  const legacyPhase2Reconciled = Boolean(
    reconciliation &&
    reconciliationChecksum &&
    reconciliation.checksum === reconciliationChecksum,
  );
  const checksumMismatches: MigrationChecksumMismatch[] = [];
  for (const [name, row] of appliedRows) {
    const expectedChecksum = expectedChecksums.get(name);
    if (!expectedChecksum || row.checksum === expectedChecksum) continue;
    if (
      name === PHASE2_SCANNER_MIGRATION &&
      row.checksum === PHASE2_SCANNER_LEGACY_CHECKSUM &&
      legacyPhase2Reconciled
    ) {
      continue;
    }
    checksumMismatches.push({
      migration: name,
      expectedChecksum,
      actualChecksum: typeof row.checksum === "string" ? row.checksum : null,
    });
  }
  return {
    status: pending.length > 0 || failed.length > 0 || checksumMismatches.length > 0 ? "drift" : "ok",
    pending,
    failed,
    checksumMismatches,
  };
}

/**
 * Migration directory names, in the lexicographic order Prisma applies them.
 * A directory only counts if it actually holds a `migration.sql`, so an
 * editor's leftover folder cannot fail a boot on its own.
 */
export function readMigrationsOnDisk(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

export function readMigrationChecksums(dir: string = MIGRATIONS_DIR): Map<string, string> {
  return new Map(readMigrationsOnDisk(dir).map((name) => {
    const contents = readFileSync(path.join(dir, name, "migration.sql"));
    return [name, createHash("sha256").update(contents).digest("hex")];
  }));
}

interface SchemaIssueRow {
  issue: string;
}

export async function checkPhase2SchemaShape(): Promise<string[]> {
  const rows = await prisma.$queryRaw<SchemaIssueRow[]>(Prisma.sql`
    WITH expected_check_constraints(issue, table_name, constraint_name, expression) AS (
      VALUES
        (
          'constraint.receipt_capture_batch_client_key',
          'ReceiptCaptureBatch',
          'ReceiptCaptureBatch_client_key_check',
          $expression$((char_length(("ReceiptCaptureBatch_ClientBatchKey")::text) >= 8) AND (char_length(("ReceiptCaptureBatch_ClientBatchKey")::text) <= 100))$expression$
        ),
        (
          'constraint.receipt_capture_batch_expected_count',
          'ReceiptCaptureBatch',
          'ReceiptCaptureBatch_expected_count_check',
          $expression$(("ReceiptCaptureBatch_ExpectedReceiptCount" >= 2) AND ("ReceiptCaptureBatch_ExpectedReceiptCount" <= 8))$expression$
        ),
        (
          'constraint.receipt_capture_batch_finished',
          'ReceiptCaptureBatch',
          'ReceiptCaptureBatch_finished_check',
          $expression$(((("ReceiptCaptureBatch_Status")::text = ANY (ARRAY['COMPLETE'::text, 'CANCELLED'::text])) AND ("ReceiptCaptureBatch_FinishedAt" IS NOT NULL)) OR ((("ReceiptCaptureBatch_Status")::text <> ALL (ARRAY['COMPLETE'::text, 'CANCELLED'::text])) AND ("ReceiptCaptureBatch_FinishedAt" IS NULL)))$expression$
        ),
        (
          'constraint.receipt_capture_batch_timestamps',
          'ReceiptCaptureBatch',
          'ReceiptCaptureBatch_timestamps_check',
          $expression$(("ReceiptCaptureBatch_FinishedAt" IS NULL) OR ("ReceiptCaptureBatch_FinishedAt" >= "ReceiptCaptureBatch_CreatedAt"))$expression$
        ),
        (
          'constraint.receipt_scan_revision',
          'ReceiptScan',
          'ReceiptScan_scan_revision_check',
          $expression$("ReceiptScan_ScanRevision" >= 0)$expression$
        ),
        (
          'constraint.receipt_scan_semantic_fingerprint',
          'ReceiptScan',
          'ReceiptScan_semantic_fingerprint_check',
          $expression$(("ReceiptScan_SemanticFingerprint" IS NULL) OR ("ReceiptScan_SemanticFingerprint" ~ '^[0-9a-f]{64}$'::text))$expression$
        ),
        (
          'constraint.receipt_scan_evidence_timestamps',
          'ReceiptScan',
          'ReceiptScan_evidence_deletion_timestamps_check',
          $expression$(("ReceiptScan_EvidenceDeletedAt" IS NULL) OR (("ReceiptScan_EvidenceDeletionRequestedAt" IS NOT NULL) AND ("ReceiptScan_EvidenceDeletedAt" >= "ReceiptScan_EvidenceDeletionRequestedAt")))$expression$
        ),
        (
          'constraint.receipt_scan_batch_link',
          'ReceiptScan',
          'ReceiptScan_batch_link_check',
          $expression$((("ReceiptCaptureBatch_ID" IS NULL) AND ("ReceiptScan_ReceiptOrdinal" IS NULL)) OR (("ReceiptCaptureBatch_ID" IS NOT NULL) AND ("ReceiptScan_ReceiptOrdinal" IS NOT NULL) AND ("BusinessProfile_ID" IS NOT NULL) AND (("ReceiptScan_ReceiptOrdinal" >= 1) AND ("ReceiptScan_ReceiptOrdinal" <= 8))))$expression$
        ),
        (
          'constraint.receipt_scan_source_image_hash',
          'ReceiptScan',
          'ReceiptScan_source_image_hash_check',
          $expression$(("ReceiptScan_SourceImageHash" IS NULL) OR ("ReceiptScan_SourceImageHash" ~ '^[0-9a-f]{64}$'::text))$expression$
        ),
        (
          'constraint.receipt_purge_active_target',
          'ReceiptPurgeJob',
          'ReceiptPurgeJob_active_target_check',
          $expression$(("ReceiptPurgeJob_Status" <> ALL (ARRAY['PENDING'::"ReceiptPurgeStatus", 'PROCESSING'::"ReceiptPurgeStatus", 'RETRY'::"ReceiptPurgeStatus"])) OR (("ReceiptScan_ID" IS NOT NULL) AND ("ReceiptScan_BusinessProfile_ID" IS NOT NULL)))$expression$
        ),
        (
          'constraint.receipt_duplicate_target',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_target_check',
          $expression$((("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL) AND ("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NULL) AND ("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" <> "ReceiptDuplicateCandidate_SourceReceiptScan_ID")) OR (("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NULL) AND ("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL)))$expression$
        ),
        (
          'constraint.receipt_duplicate_detector_version',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_detector_version_check',
          $expression$(btrim(("ReceiptDuplicateCandidate_DetectorVersion")::text) <> ''::text)$expression$
        ),
        (
          'constraint.receipt_duplicate_source_fingerprint',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_source_fingerprint_check',
          $expression$("ReceiptDuplicateCandidate_SourceFingerprint" ~ '^[0-9a-f]{64}$'::text)$expression$
        ),
        (
          'constraint.receipt_duplicate_decision_set_hash',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_decision_set_hash_check',
          $expression$(("ReceiptDuplicateCandidate_DecisionSetHash" IS NULL) OR ("ReceiptDuplicateCandidate_DecisionSetHash" ~ '^[0-9a-f]{64}$'::text))$expression$
        ),
        (
          'constraint.receipt_duplicate_reason_codes',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_reason_codes_check',
          $expression$((jsonb_typeof("ReceiptDuplicateCandidate_ReasonCodes") = 'array'::text) AND (jsonb_array_length("ReceiptDuplicateCandidate_ReasonCodes") > 0))$expression$
        ),
        (
          'constraint.receipt_duplicate_decision_lifecycle',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_decision_lifecycle_check',
          $expression$((("ReceiptDuplicateCandidate_ReviewStatus" = 'SAVED_ANYWAY'::"ReceiptDuplicateReviewStatus") AND ("ReceiptDuplicateCandidate_DecisionSetHash" IS NOT NULL) AND ("ReceiptDuplicateCandidate_DecidedByUser_ID" IS NOT NULL) AND ("ReceiptDuplicateCandidate_DecidedAt" IS NOT NULL)) OR (("ReceiptDuplicateCandidate_ReviewStatus" = ANY (ARRAY['PENDING'::"ReceiptDuplicateReviewStatus", 'SUPERSEDED'::"ReceiptDuplicateReviewStatus"])) AND ("ReceiptDuplicateCandidate_DecisionSetHash" IS NULL) AND ("ReceiptDuplicateCandidate_DecidedByUser_ID" IS NULL) AND ("ReceiptDuplicateCandidate_DecidedAt" IS NULL)))$expression$
        ),
        (
          'constraint.receipt_duplicate_decision_timestamp',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_decision_timestamp_check',
          $expression$(("ReceiptDuplicateCandidate_DecidedAt" IS NULL) OR ("ReceiptDuplicateCandidate_DecidedAt" >= "ReceiptDuplicateCandidate_CreatedAt"))$expression$
        )
    ),
    expected_foreign_keys(
      issue,
      source_table,
      constraint_name,
      source_columns,
      target_table,
      target_columns,
      delete_action,
      update_action
    ) AS (
      VALUES
        (
          'foreign_key.receipt_capture_batch_profile',
          'ReceiptCaptureBatch',
          'ReceiptCaptureBatch_BusinessProfile_ID_fkey',
          ARRAY['BusinessProfile_ID']::text[],
          'BusinessProfile',
          ARRAY['BusinessProfile_ID']::text[],
          'c',
          'c'
        ),
        (
          'foreign_key.receipt_scan_capture_batch_profile',
          'ReceiptScan',
          'ReceiptScan_ReceiptCaptureBatch_ID_BusinessProfile_ID_fkey',
          ARRAY['ReceiptCaptureBatch_ID', 'BusinessProfile_ID']::text[],
          'ReceiptCaptureBatch',
          ARRAY['ReceiptCaptureBatch_ID', 'BusinessProfile_ID']::text[],
          'a',
          'c'
        ),
        (
          'foreign_key.receipt_duplicate_profile',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_profile_fkey',
          ARRAY['BusinessProfile_ID']::text[],
          'BusinessProfile',
          ARRAY['BusinessProfile_ID']::text[],
          'c',
          'c'
        ),
        (
          'foreign_key.receipt_duplicate_decision_owner',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_decision_owner_fkey',
          ARRAY['BusinessProfile_ID', 'ReceiptDuplicateCandidate_DecidedByUser_ID']::text[],
          'BusinessProfile',
          ARRAY['BusinessProfile_ID', 'User_ID']::text[],
          'a',
          'c'
        ),
        (
          'foreign_key.receipt_duplicate_source_profile',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_source_scan_fkey',
          ARRAY['ReceiptDuplicateCandidate_SourceReceiptScan_ID', 'BusinessProfile_ID']::text[],
          'ReceiptScan',
          ARRAY['ReceiptScan_ID', 'BusinessProfile_ID']::text[],
          'c',
          'c'
        ),
        (
          'foreign_key.receipt_duplicate_scan_target',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_scan_target_fkey',
          ARRAY['ReceiptDuplicateCandidate_CandidateReceiptScan_ID', 'BusinessProfile_ID']::text[],
          'ReceiptScan',
          ARRAY['ReceiptScan_ID', 'BusinessProfile_ID']::text[],
          'c',
          'c'
        ),
        (
          'foreign_key.receipt_duplicate_expense_target',
          'ReceiptDuplicateCandidate',
          'ReceiptDuplicateCandidate_expense_target_fkey',
          ARRAY['ReceiptDuplicateCandidate_CandidateExpenseRecord_ID', 'BusinessProfile_ID']::text[],
          'ExpenseRecord',
          ARRAY['ExpenseRecord_ID', 'BusinessProfile_ID']::text[],
          'c',
          'c'
        )
    ),
    expected_indexes(
      issue,
      index_name,
      table_name,
      is_unique,
      predicate,
      column_names,
      options,
      collations,
      operator_classes
    ) AS (
      VALUES
        (
          'index.receipt_capture_batch_profile_created',
          'ReceiptCaptureBatch_profile_created_idx',
          'ReceiptCaptureBatch',
          false,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptCaptureBatch_CreatedAt', 'ReceiptCaptureBatch_ID']::text[],
          ARRAY[0, 0, 0]::smallint[],
          ARRAY[NULL, NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.timestamp_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_capture_batch_primary',
          'ReceiptCaptureBatch_pkey',
          'ReceiptCaptureBatch',
          true,
          NULL::text,
          ARRAY['ReceiptCaptureBatch_ID']::text[],
          ARRAY[0]::smallint[],
          ARRAY[NULL]::text[],
          ARRAY['pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_capture_batch_profile_client',
          'ReceiptCaptureBatch_profile_client_key',
          'ReceiptCaptureBatch',
          true,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptCaptureBatch_ClientBatchKey']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, 'pg_catalog.default']::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.text_ops']::text[]
        ),
        (
          'index.receipt_capture_batch_profile_identity',
          'ReceiptCaptureBatch_ID_BusinessProfile_ID_key',
          'ReceiptCaptureBatch',
          true,
          NULL::text,
          ARRAY['ReceiptCaptureBatch_ID', 'BusinessProfile_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_scan_batch_ordinal',
          'ReceiptScan_batch_ordinal_key',
          'ReceiptScan',
          true,
          NULL::text,
          ARRAY['ReceiptCaptureBatch_ID', 'ReceiptScan_ReceiptOrdinal']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_scan_source_image_hash',
          'ReceiptScan_profile_source_image_hash_idx',
          'ReceiptScan',
          false,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptScan_SourceImageHash']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, 'pg_catalog.default']::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.bpchar_ops']::text[]
        ),
        (
          'index.receipt_scan_abandoned_sweep',
          'ReceiptScan_abandoned_sweep_idx',
          'ReceiptScan',
          false,
          NULL::text,
          ARRAY[
            'ReceiptScan_ConfirmationStatus',
            'ReceiptScan_ProcessingStatus',
            'ReceiptScan_LastActivityAt',
            'ReceiptScan_ID'
          ]::text[],
          ARRAY[0, 0, 0, 0]::smallint[],
          ARRAY['pg_catalog.default', 'pg_catalog.default', NULL, NULL]::text[],
          ARRAY[
            'pg_catalog.text_ops',
            'pg_catalog.text_ops',
            'pg_catalog.timestamp_ops',
            'pg_catalog.int4_ops'
          ]::text[]
        ),
        (
          'index.receipt_scan_history_status',
          'ReceiptScan_history_status_created_idx',
          'ReceiptScan',
          false,
          NULL::text,
          ARRAY[
            'BusinessProfile_ID',
            'ReceiptScan_ConfirmationStatus',
            'ReceiptScan_ProcessingStatus',
            'ReceiptScan_CreatedAt',
            'ReceiptScan_ID'
          ]::text[],
          ARRAY[0, 0, 0, 3, 3]::smallint[],
          ARRAY[NULL, 'pg_catalog.default', 'pg_catalog.default', NULL, NULL]::text[],
          ARRAY[
            'pg_catalog.int4_ops',
            'pg_catalog.text_ops',
            'pg_catalog.text_ops',
            'pg_catalog.timestamp_ops',
            'pg_catalog.int4_ops'
          ]::text[]
        ),
        (
          'index.receipt_scan_history',
          'ReceiptScan_history_created_idx',
          'ReceiptScan',
          false,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptScan_CreatedAt', 'ReceiptScan_ID']::text[],
          ARRAY[0, 3, 3]::smallint[],
          ARRAY[NULL, NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.timestamp_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_scan_semantic_fingerprint',
          'ReceiptScan_profile_semantic_fingerprint_idx',
          'ReceiptScan',
          false,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptScan_SemanticFingerprint']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, 'pg_catalog.default']::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.bpchar_ops']::text[]
        ),
        (
          'index.expense_record_profile_identity',
          'ExpenseRecord_ID_BusinessProfile_ID_key',
          'ExpenseRecord',
          true,
          NULL::text,
          ARRAY['ExpenseRecord_ID', 'BusinessProfile_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_duplicate_source_review',
          'ReceiptDuplicateCandidate_source_review_idx',
          'ReceiptDuplicateCandidate',
          false,
          NULL::text,
          ARRAY[
            'BusinessProfile_ID',
            'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
            'ReceiptDuplicateCandidate_ReviewStatus',
            'ReceiptDuplicateCandidate_ID'
          ]::text[],
          ARRAY[0, 0, 0, 0]::smallint[],
          ARRAY[NULL, NULL, NULL, NULL]::text[],
          ARRAY[
            'pg_catalog.int4_ops',
            'pg_catalog.int4_ops',
            'pg_catalog.enum_ops',
            'pg_catalog.int4_ops'
          ]::text[]
        ),
        (
          'index.receipt_duplicate_primary',
          'ReceiptDuplicateCandidate_pkey',
          'ReceiptDuplicateCandidate',
          true,
          NULL::text,
          ARRAY['ReceiptDuplicateCandidate_ID']::text[],
          ARRAY[0]::smallint[],
          ARRAY[NULL]::text[],
          ARRAY['pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_duplicate_scan_target',
          'ReceiptDuplicateCandidate_scan_target_idx',
          'ReceiptDuplicateCandidate',
          false,
          NULL::text,
          ARRAY['ReceiptDuplicateCandidate_CandidateReceiptScan_ID', 'BusinessProfile_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_duplicate_expense_target',
          'ReceiptDuplicateCandidate_expense_target_idx',
          'ReceiptDuplicateCandidate',
          false,
          NULL::text,
          ARRAY['ReceiptDuplicateCandidate_CandidateExpenseRecord_ID', 'BusinessProfile_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_duplicate_decision_owner',
          'ReceiptDuplicateCandidate_decision_owner_idx',
          'ReceiptDuplicateCandidate',
          false,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptDuplicateCandidate_DecidedByUser_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_duplicate_scan_partial_unique',
          'ReceiptDuplicateCandidate_source_scan_target_key',
          'ReceiptDuplicateCandidate',
          true,
          $predicate$("ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL)$predicate$,
          ARRAY[
            'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
            'ReceiptDuplicateCandidate_CandidateReceiptScan_ID',
            'ReceiptDuplicateCandidate_DetectorVersion'
          ]::text[],
          ARRAY[0, 0, 0]::smallint[],
          ARRAY[NULL, NULL, 'pg_catalog.default']::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops', 'pg_catalog.text_ops']::text[]
        ),
        (
          'index.receipt_duplicate_expense_partial_unique',
          'ReceiptDuplicateCandidate_source_expense_target_key',
          'ReceiptDuplicateCandidate',
          true,
          $predicate$("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL)$predicate$,
          ARRAY[
            'ReceiptDuplicateCandidate_SourceReceiptScan_ID',
            'ReceiptDuplicateCandidate_CandidateExpenseRecord_ID',
            'ReceiptDuplicateCandidate_DetectorVersion'
          ]::text[],
          ARRAY[0, 0, 0]::smallint[],
          ARRAY[NULL, NULL, 'pg_catalog.default']::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops', 'pg_catalog.text_ops']::text[]
        ),
        (
          'index.receipt_purge_profile_receipt',
          'ReceiptPurgeJob_profile_receipt_idx',
          'ReceiptPurgeJob',
          false,
          NULL::text,
          ARRAY['BusinessProfile_ID', 'ReceiptScan_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        ),
        (
          'index.receipt_purge_active_partial_unique',
          'ReceiptPurgeJob_active_profile_receipt_key',
          'ReceiptPurgeJob',
          true,
          $predicate$("ReceiptPurgeJob_Status" = ANY (ARRAY['PENDING'::"ReceiptPurgeStatus", 'PROCESSING'::"ReceiptPurgeStatus", 'RETRY'::"ReceiptPurgeStatus"]))$predicate$,
          ARRAY['BusinessProfile_ID', 'ReceiptScan_ID']::text[],
          ARRAY[0, 0]::smallint[],
          ARRAY[NULL, NULL]::text[],
          ARRAY['pg_catalog.int4_ops', 'pg_catalog.int4_ops']::text[]
        )
    ),
    check_constraint_checks(issue, ok) AS (
      SELECT
        expected.issue,
        actual.oid IS NOT NULL
          AND actual.contype = 'c'
          AND actual.convalidated
          AND NOT actual.connoinherit
          AND regexp_replace(
            pg_get_expr(actual.conbin, actual.conrelid, false),
            '[[:space:]]+',
            ' ',
            'g'
          ) IS NOT DISTINCT FROM expected.expression
      FROM expected_check_constraints expected
      LEFT JOIN pg_class source_relation
        ON source_relation.relnamespace = 'public'::regnamespace
       AND source_relation.relname = expected.table_name
      LEFT JOIN pg_constraint actual
        ON actual.conrelid = source_relation.oid
       AND actual.conname = expected.constraint_name
    ),
    foreign_key_checks(issue, ok) AS (
      SELECT
        expected.issue,
        actual.oid IS NOT NULL
          AND actual.contype = 'f'
          AND actual.convalidated
          AND NOT actual.condeferrable
          AND NOT actual.condeferred
          AND actual.confmatchtype = 's'
          AND source_key.column_names IS NOT DISTINCT FROM expected.source_columns
          AND target_relation.relname IS NOT DISTINCT FROM expected.target_table
          AND target_relation.relnamespace = 'public'::regnamespace
          AND target_key.column_names IS NOT DISTINCT FROM expected.target_columns
          AND actual.confdeltype::text = expected.delete_action
          AND actual.confupdtype::text = expected.update_action
      FROM expected_foreign_keys expected
      LEFT JOIN pg_class source_relation
        ON source_relation.relnamespace = 'public'::regnamespace
       AND source_relation.relname = expected.source_table
      LEFT JOIN pg_constraint actual
        ON actual.conrelid = source_relation.oid
       AND actual.conname = expected.constraint_name
      LEFT JOIN pg_class target_relation ON target_relation.oid = actual.confrelid
      LEFT JOIN LATERAL (
        SELECT array_agg(attribute.attname::text ORDER BY key_position.ordinality) AS column_names
        FROM unnest(actual.conkey::smallint[]) WITH ORDINALITY key_position(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = source_relation.oid
         AND attribute.attnum = key_position.attnum
      ) source_key ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(attribute.attname::text ORDER BY key_position.ordinality) AS column_names
        FROM unnest(actual.confkey::smallint[]) WITH ORDINALITY key_position(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = target_relation.oid
         AND attribute.attnum = key_position.attnum
      ) target_key ON true
    ),
    index_checks(issue, ok) AS (
      SELECT
        expected.issue,
        index_relation.oid IS NOT NULL
          AND target_relation.relname IS NOT DISTINCT FROM expected.table_name
          AND index_metadata.indisunique = expected.is_unique
          AND index_metadata.indisprimary = (
            expected.index_name IN ('ReceiptCaptureBatch_pkey', 'ReceiptDuplicateCandidate_pkey')
          )
          AND NOT index_metadata.indisexclusion
          AND index_metadata.indimmediate
          AND index_metadata.indisvalid
          AND index_metadata.indisready
          AND index_metadata.indislive
          AND NOT index_metadata.indnullsnotdistinct
          AND index_metadata.indnatts = index_metadata.indnkeyatts
          AND access_method.amname = 'btree'
          AND actual.column_names IS NOT DISTINCT FROM expected.column_names
          AND actual.options IS NOT DISTINCT FROM expected.options
          AND actual.collations IS NOT DISTINCT FROM expected.collations
          AND actual.operator_classes IS NOT DISTINCT FROM expected.operator_classes
          AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid, false)
            IS NOT DISTINCT FROM expected.predicate
      FROM expected_indexes expected
      LEFT JOIN pg_class index_relation
        ON index_relation.relnamespace = 'public'::regnamespace
       AND index_relation.relname = expected.index_name
       AND index_relation.relkind = 'i'
      LEFT JOIN pg_index index_metadata ON index_metadata.indexrelid = index_relation.oid
      LEFT JOIN pg_class target_relation ON target_relation.oid = index_metadata.indrelid
      LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
      LEFT JOIN LATERAL (
        SELECT
          array_agg(attribute.attname::text ORDER BY key_position.ordinality) AS column_names,
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
        FROM unnest(index_metadata.indkey::smallint[])
          WITH ORDINALITY key_position(attnum, ordinality)
        JOIN LATERAL unnest(index_metadata.indoption::smallint[])
          WITH ORDINALITY index_option(option, ordinality)
          ON index_option.ordinality = key_position.ordinality
        JOIN LATERAL unnest(index_metadata.indcollation::oid[])
          WITH ORDINALITY collation_position(collation_oid, ordinality)
          ON collation_position.ordinality = key_position.ordinality
        JOIN LATERAL unnest(index_metadata.indclass::oid[])
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
      ) actual ON true
    ),
    checks(issue, ok) AS (
      SELECT issue, ok FROM check_constraint_checks
      UNION ALL
      SELECT issue, ok FROM foreign_key_checks
      UNION ALL
      SELECT issue, ok FROM index_checks
      UNION ALL
      SELECT issue, ok
      FROM (VALUES
        ('enum.receipt_capture_batch_status', ARRAY(
          SELECT enum_value.enumlabel::text
          FROM pg_type enum_type
          INNER JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
          INNER JOIN pg_enum enum_value ON enum_value.enumtypid = enum_type.oid
          WHERE namespace.nspname = 'public'
            AND enum_type.typname = 'ReceiptCaptureBatchStatus'
          ORDER BY enum_value.enumsortorder
        ) = ARRAY['COLLECTING', 'PROCESSING', 'READY_FOR_REVIEW', 'PARTIAL_FAILURE', 'FAILED', 'COMPLETE', 'CANCELLED']::text[]),
        ('enum.receipt_purge_mode', ARRAY(
          SELECT enum_value.enumlabel::text
          FROM pg_type enum_type
          INNER JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
          INNER JOIN pg_enum enum_value ON enum_value.enumtypid = enum_type.oid
          WHERE namespace.nspname = 'public'
            AND enum_type.typname = 'ReceiptPurgeMode'
          ORDER BY enum_value.enumsortorder
        ) = ARRAY['DELETE_SCAN', 'DETACH_EVIDENCE']::text[]),
        ('enum.receipt_duplicate_score_band', ARRAY(
          SELECT enum_value.enumlabel::text
          FROM pg_type enum_type
          INNER JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
          INNER JOIN pg_enum enum_value ON enum_value.enumtypid = enum_type.oid
          WHERE namespace.nspname = 'public'
            AND enum_type.typname = 'ReceiptDuplicateScoreBand'
          ORDER BY enum_value.enumsortorder
        ) = ARRAY['EXACT', 'LIKELY']::text[]),
        ('enum.receipt_duplicate_review_status', ARRAY(
          SELECT enum_value.enumlabel::text
          FROM pg_type enum_type
          INNER JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
          INNER JOIN pg_enum enum_value ON enum_value.enumtypid = enum_type.oid
          WHERE namespace.nspname = 'public'
            AND enum_type.typname = 'ReceiptDuplicateReviewStatus'
          ORDER BY enum_value.enumsortorder
        ) = ARRAY['PENDING', 'SAVED_ANYWAY', 'SUPERSEDED']::text[]),
        ('table.receipt_capture_batch', to_regclass('public."ReceiptCaptureBatch"') IS NOT NULL),
        ('table.receipt_duplicate_candidate', to_regclass('public."ReceiptDuplicateCandidate"') IS NOT NULL),
        ('table.external_provider_dispatch_outcome', to_regclass('public."ExternalProviderDispatchOutcome"') IS NOT NULL),
        ('table.external_processing_consent', to_regclass('public."ExternalProcessingConsent"') IS NOT NULL),
        ('table.external_provider_budget', to_regclass('public."ExternalProviderBudget"') IS NOT NULL),
        ('table.external_provider_dispatch', to_regclass('public."ExternalProviderDispatch"') IS NOT NULL),
        ('sequence.receipt_capture_batch', to_regclass(
          'public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'
        ) IS NOT NULL),
        ('sequence.receipt_duplicate_candidate', to_regclass(
          'public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"'
        ) IS NOT NULL),
        ('column.receipt_scan_capture_batch', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptCaptureBatch_ID' AND NOT attisdropped
        )),
        ('column.receipt_scan_ordinal', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_ReceiptOrdinal' AND NOT attisdropped
        )),
        ('column.receipt_scan_evidence_deletion_requested', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_EvidenceDeletionRequestedAt' AND NOT attisdropped
        )),
        ('column.receipt_scan_evidence_deleted', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_EvidenceDeletedAt' AND NOT attisdropped
        )),
        ('column.receipt_scan_revision', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_ScanRevision' AND NOT attisdropped
        )),
        ('column.receipt_scan_semantic_fingerprint', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_SemanticFingerprint' AND NOT attisdropped
        )),
        ('column.receipt_scan_source_image_hash', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_SourceImageHash' AND NOT attisdropped
        )),
        ('column.receipt_scan_last_activity', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptScan"') AND attname = 'ReceiptScan_LastActivityAt' AND NOT attisdropped
        )),
        ('column.receipt_purge_mode', EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public."ReceiptPurgeJob"') AND attname = 'ReceiptPurgeJob_Mode' AND NOT attisdropped
        )),
        ('security.receipt_capture_batch_rls', COALESCE((
          SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."ReceiptCaptureBatch"')
        ), FALSE)),
        ('security.receipt_duplicate_candidate_rls', COALESCE((
          SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."ReceiptDuplicateCandidate"')
        ), FALSE)),
        ('security.external_provider_dispatch_outcome_rls', COALESCE((
          SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."ExternalProviderDispatchOutcome"')
        ), FALSE)),
        ('security.external_processing_consent_rls', COALESCE((
          SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."ExternalProcessingConsent"')
        ), FALSE)),
        ('security.external_provider_budget_rls', COALESCE((
          SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."ExternalProviderBudget"')
        ), FALSE)),
        ('security.external_provider_dispatch_rls', COALESCE((
          SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."ExternalProviderDispatch"')
        ), FALSE)),
        ('security.receipt_capture_batch_no_policies', NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public."ReceiptCaptureBatch"')
        )),
        ('security.receipt_duplicate_candidate_no_policies', NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public."ReceiptDuplicateCandidate"')
        )),
        ('security.external_provider_dispatch_outcome_no_policies', NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public."ExternalProviderDispatchOutcome"')
        )),
        ('security.external_processing_consent_no_policies', NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public."ExternalProcessingConsent"')
        )),
        ('security.external_provider_budget_no_policies', NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public."ExternalProviderBudget"')
        )),
        ('security.external_provider_dispatch_no_policies', NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public."ExternalProviderDispatch"')
        )),
        ('security.receipt_tables_no_direct_api_grants', NOT EXISTS (
          SELECT 1
          FROM pg_roles api_role
          CROSS JOIN pg_class table_object
          WHERE api_role.rolname IN ('anon', 'authenticated', 'service_role')
            AND table_object.oid IN (
              to_regclass('public."ReceiptCaptureBatch"'),
              to_regclass('public."ReceiptDuplicateCandidate"')
            )
            AND has_table_privilege(
              api_role.oid,
              table_object.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
        )),
        ('security.receipt_tables_no_public_grants', NOT EXISTS (
          SELECT 1
          FROM pg_class table_object
          CROSS JOIN LATERAL aclexplode(COALESCE(table_object.relacl, '{}'::aclitem[])) grant_entry
          WHERE table_object.oid IN (
              to_regclass('public."ReceiptCaptureBatch"'),
              to_regclass('public."ReceiptDuplicateCandidate"')
            )
            AND grant_entry.grantee = 0
        )),
        ('security.receipt_sequences_no_direct_api_grants', NOT EXISTS (
          SELECT 1
          FROM pg_roles api_role
          CROSS JOIN pg_class sequence_object
          WHERE api_role.rolname IN ('anon', 'authenticated', 'service_role')
            AND sequence_object.oid IN (
              to_regclass('public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'),
              to_regclass('public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"')
            )
            AND has_sequence_privilege(api_role.oid, sequence_object.oid, 'USAGE,SELECT,UPDATE')
        )),
        ('security.receipt_sequences_no_public_grants', NOT EXISTS (
          SELECT 1
          FROM pg_class sequence_object
          CROSS JOIN LATERAL aclexplode(COALESCE(sequence_object.relacl, '{}'::aclitem[])) grant_entry
          WHERE sequence_object.oid IN (
              to_regclass('public."ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq"'),
              to_regclass('public."ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq"')
            )
            AND grant_entry.grantee = 0
        ))
      ) AS static_checks(issue, ok)
    )
    SELECT issue FROM checks WHERE NOT ok ORDER BY issue
  `);
  return rows.map((row) => row.issue);
}

/**
 * True for "that table isn't there", which is what a database that has never
 * had a migration applied answers. That is drift of the most complete kind —
 * nothing is applied — so it must NOT be confused with the check failing.
 */
function isMissingMigrationsTable(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const pgCode = (err.meta as { code?: unknown } | undefined)?.code;
  return pgCode === "42P01" || /_prisma_migrations.*does not exist/is.test(err.message);
}

function isDatabaseUnavailable(err: unknown): boolean {
  const code = err instanceof Prisma.PrismaClientKnownRequestError
    ? err.code
    : err instanceof Prisma.PrismaClientInitializationError
      ? err.errorCode
      : undefined;
  return code !== undefined && ["P1001", "P1002", "P1008", "P1017"].includes(code);
}

/**
 * Compares the migrations in the repository against those recorded in the
 * database.
 *
 * A database this process cannot reach yields "unknown", never "drift". The
 * distinction matters: a momentary connection problem must not stop a process
 * from starting — the API already answers 503 while the database is away, and
 * refusing to boot would turn a blip into an outage that needs a human.
 */
export async function checkMigrationDrift(migrationsDir: string = MIGRATIONS_DIR): Promise<MigrationDrift> {
  let onDisk: string[];
  let expectedChecksums: Map<string, string>;
  try {
    onDisk = readMigrationsOnDisk(migrationsDir);
    expectedChecksums = readMigrationChecksums(migrationsDir);
  } catch (err) {
    return {
      status: "unknown",
      pending: [],
      failed: [],
      verificationFailure: "migration_files_unreadable",
      reason: `migrations directory unreadable: ${(err as Error).message}`,
    };
  }

  let rows: MigrationRow[];
  try {
    rows = await prisma.$queryRaw<MigrationRow[]>(
      Prisma.sql`SELECT migration_name, checksum, finished_at, rolled_back_at FROM public."_prisma_migrations"`,
    );
  } catch (err) {
    if (isMissingMigrationsTable(err)) rows = [];
    else {
      return {
        status: "unknown",
        pending: [],
        failed: [],
        verificationFailure: isDatabaseUnavailable(err)
          ? "database_unavailable"
          : "migration_history_unverifiable",
        reason: (err as Error).message,
      };
    }
  }

  const comparison = compareMigrations(onDisk, rows, expectedChecksums);
  if (comparison.status === "drift") return comparison;

  try {
    const schemaIssues = await checkPhase2SchemaShape();
    return {
      ...comparison,
      status: schemaIssues.length > 0 ? "drift" : "ok",
      schemaIssues,
    };
  } catch (err) {
    return {
      ...comparison,
      status: "unknown",
      verificationFailure: isDatabaseUnavailable(err)
        ? "database_unavailable"
        : "schema_shape_unverifiable",
      reason: `schema shape check failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Boot gate for `server.ts` and `worker.ts`. Exits the process on drift.
 *
 * Deliberately NOT wired into `app.ts`: the tests build the Express app
 * directly, and an integration suite running against its own throwaway
 * database has already applied its schema by other means.
 */
export async function assertMigrationsApplied(
  processName: string,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<void> {
  const drift = await checkMigrationDrift(migrationsDir);

  if (drift.status === "unknown" && drift.verificationFailure === "database_unavailable") {
    logger.warn(
      { processName, verificationFailure: drift.verificationFailure, reason: drift.reason },
      "could not verify database migrations at startup; continuing",
    );
    return;
  }

  if (drift.status === "ok") {
    logger.info({ processName }, "database migrations verified");
    return;
  }

  if (drift.status === "unknown") {
    logger.fatal(
      {
        processName,
        verificationFailure: drift.verificationFailure,
        reason: drift.reason,
      },
      "REFUSING TO START: database schema verification could not prove this build's migration state. " +
        "Fix the migration files, database permissions, or catalog query before starting again.",
    );
    process.exit(1);
    return;
  }

  logger.fatal(
    {
      processName,
      pending: drift.pending,
      failed: drift.failed,
      checksumMismatches: drift.checksumMismatches ?? [],
      schemaIssues: drift.schemaIssues ?? [],
    },
    "REFUSING TO START: the database is not at the schema this build expects. " +
      "Requests touching missing or changed database objects would fail or bypass required controls. " +
      "Apply pending migrations or an approved forward-only reconciliation, then start again." +
      (drift.failed.length > 0
        ? " A migration is also recorded as started but never finished; that must be resolved first."
        : "") +
      ((drift.checksumMismatches?.length ?? 0) > 0
        ? " Do not rewrite an applied migration or its ledger row to hide a checksum mismatch."
        : ""),
  );
  process.exit(1);
}
