import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const CHECK_NAME = "record-integrity" as const;
const REPORT_VERSION = 1 as const;
export const AUDIT_STATEMENT_TIMEOUT_MS = 30_000;
export const AUDIT_LOCK_TIMEOUT_MS = 2_000;
export const MAX_DUPLICATE_TRAVERSAL_DEPTH = 64;

export type AuditArguments = {
  allowRemoteReadOnly: boolean;
  help: boolean;
};

export type RecordIntegrityAuditConnection = {
  databaseUrl?: string;
  allowRemoteReadOnly?: boolean;
  expectedHostname?: string;
  expectedDatabase?: string;
  expectedFingerprint?: string;
};

type FindingCounts = {
  expense: {
    invalidDuplicateStatus: number;
    flaggedWithoutPointer: number;
    unflaggedWithPointer: number;
    selfLinks: number;
    crossProfileLinks: number;
    missingTargets: number;
    invalidEdgeIdentity: number;
    sameReceiptLinks: number;
    cycleAffectedRecords: number;
    traversalLimitReached: number;
    categoryOwnershipMismatches: number;
    receiptOwnershipMismatches: number;
    importBatchOwnershipMismatches: number;
  };
  sales: {
    invalidDuplicateStatus: number;
    flaggedWithoutPointer: number;
    unflaggedWithPointer: number;
    selfLinks: number;
    crossProfileLinks: number;
    missingTargets: number;
    invalidEdgeIdentity: number;
    cycleAffectedRecords: number;
    traversalLimitReached: number;
    followerTargetsNonCanonicalRoot: number;
    importBatchOwnershipMismatches: number;
  };
};

export type RecordIntegrityAuditReport = {
  check: typeof CHECK_NAME;
  version: typeof REPORT_VERSION;
  status: "ok" | "findings";
  readOnlyVerified: true;
  safetySettingsVerified: true;
  totalViolations: number;
  findings: FindingCounts;
};

type CountRow = {
  expense_invalid_duplicate_status: number;
  expense_flagged_without_pointer: number;
  expense_unflagged_with_pointer: number;
  expense_self_links: number;
  expense_cross_profile_links: number;
  expense_missing_targets: number;
  expense_invalid_edge_identity: number;
  expense_same_receipt_links: number;
  expense_cycle_affected_records: number;
  expense_traversal_limit_reached: number;
  expense_category_ownership_mismatches: number;
  expense_receipt_ownership_mismatches: number;
  expense_import_batch_ownership_mismatches: number;
  sales_invalid_duplicate_status: number;
  sales_flagged_without_pointer: number;
  sales_unflagged_with_pointer: number;
  sales_self_links: number;
  sales_cross_profile_links: number;
  sales_missing_targets: number;
  sales_invalid_edge_identity: number;
  sales_cycle_affected_records: number;
  sales_traversal_limit_reached: number;
  sales_follower_targets_non_canonical_root: number;
  sales_import_batch_ownership_mismatches: number;
};

export class RecordIntegrityAuditError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "RecordIntegrityAuditError";
  }
}

export const HELP_TEXT = `Usage: npm run audit:record-integrity -- [--allow-remote-read-only]

Runs an aggregate-only, read-only integrity audit of financial record links.

Required environment:
  RECORD_INTEGRITY_DATABASE_URL  PostgreSQL connection URL used only by this audit.
  RECORD_INTEGRITY_EXPECTED_HOST Required for remote audits; exact expected hostname.
  RECORD_INTEGRITY_EXPECTED_DATABASE
                                Required for remote audits; exact expected database.
  RECORD_INTEGRITY_EXPECTED_FINGERPRINT
                                Required for remote audits; lowercase SHA-256 of
                                protocol|hostname|port|database|decoded-username.

Options:
  --allow-remote-read-only  Permit a non-loopback database host. The transaction is
                            still forced to READ ONLY and the URL must match all
                            expected target variables before any connection is opened.
  --help                    Show this help and exit.

Exit codes:
  0  No findings
  1  Integrity findings detected
  2  Configuration, safety, connection, or query failure

Safety limits:
  Statement timeout: ${AUDIT_STATEMENT_TIMEOUT_MS}ms; lock timeout: ${AUDIT_LOCK_TIMEOUT_MS}ms;
  duplicate-link traversal: ${MAX_DUPLICATE_TRAVERSAL_DEPTH} edges per starting record.
  totalViolations sums overlapping invariant violations, not unique records.`;

export function parseAuditArguments(argv: string[]): AuditArguments {
  let allowRemoteReadOnly = false;
  let help = false;
  for (const argument of argv) {
    if (argument === "--allow-remote-read-only") allowRemoteReadOnly = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else throw new RecordIntegrityAuditError("UNKNOWN_ARGUMENT");
  }
  return { allowRemoteReadOnly, help };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255) && octets[0] === 127;
}

function isSanitizedExpectedHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isSanitizedExpectedDatabase(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,63}$/.test(value);
}

function decodeTargetPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RecordIntegrityAuditError("DATABASE_URL_INVALID");
  }
}

export function databaseTargetFingerprint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RecordIntegrityAuditError("DATABASE_URL_INVALID");
  }
  const database = decodeTargetPart(url.pathname.slice(1));
  const username = decodeTargetPart(url.username);
  const canonical = [
    url.protocol.slice(0, -1).toLowerCase(),
    url.hostname.toLowerCase(),
    url.port || "5432",
    database,
    username,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function validateAuditDatabaseUrl(
  raw: string | undefined,
  allowRemoteReadOnly: boolean,
  expectedHostname?: string,
  expectedDatabase?: string,
  expectedFingerprint?: string,
): string {
  if (!raw) throw new RecordIntegrityAuditError("DATABASE_URL_MISSING");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RecordIntegrityAuditError("DATABASE_URL_INVALID");
  }
  if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:") || !url.hostname || !url.pathname.slice(1)) {
    throw new RecordIntegrityAuditError("DATABASE_URL_INVALID");
  }
  if (!isLoopbackHostname(url.hostname) && !allowRemoteReadOnly) {
    throw new RecordIntegrityAuditError("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG");
  }
  if (!isLoopbackHostname(url.hostname)) {
    if (!expectedHostname || !expectedDatabase || !expectedFingerprint) {
      throw new RecordIntegrityAuditError("REMOTE_DATABASE_TARGET_BINDING_MISSING");
    }
    if (
      !isSanitizedExpectedHostname(expectedHostname)
      || !isSanitizedExpectedDatabase(expectedDatabase)
      || !/^[a-f0-9]{64}$/.test(expectedFingerprint)
    ) {
      throw new RecordIntegrityAuditError("REMOTE_DATABASE_TARGET_BINDING_INVALID");
    }
    const database = decodeTargetPart(url.pathname.slice(1));
    if (url.hostname.toLowerCase() !== expectedHostname.toLowerCase() || database !== expectedDatabase) {
      throw new RecordIntegrityAuditError("REMOTE_DATABASE_TARGET_MISMATCH");
    }
    const actualFingerprint = databaseTargetFingerprint(raw);
    if (!timingSafeEqual(Buffer.from(actualFingerprint, "hex"), Buffer.from(expectedFingerprint, "hex"))) {
      throw new RecordIntegrityAuditError("REMOTE_DATABASE_FINGERPRINT_MISMATCH");
    }
  }
  return raw;
}

function mapCounts(row: CountRow): FindingCounts {
  return {
    expense: {
      invalidDuplicateStatus: row.expense_invalid_duplicate_status,
      flaggedWithoutPointer: row.expense_flagged_without_pointer,
      unflaggedWithPointer: row.expense_unflagged_with_pointer,
      selfLinks: row.expense_self_links,
      crossProfileLinks: row.expense_cross_profile_links,
      missingTargets: row.expense_missing_targets,
      invalidEdgeIdentity: row.expense_invalid_edge_identity,
      sameReceiptLinks: row.expense_same_receipt_links,
      cycleAffectedRecords: row.expense_cycle_affected_records,
      traversalLimitReached: row.expense_traversal_limit_reached,
      categoryOwnershipMismatches: row.expense_category_ownership_mismatches,
      receiptOwnershipMismatches: row.expense_receipt_ownership_mismatches,
      importBatchOwnershipMismatches: row.expense_import_batch_ownership_mismatches,
    },
    sales: {
      invalidDuplicateStatus: row.sales_invalid_duplicate_status,
      flaggedWithoutPointer: row.sales_flagged_without_pointer,
      unflaggedWithPointer: row.sales_unflagged_with_pointer,
      selfLinks: row.sales_self_links,
      crossProfileLinks: row.sales_cross_profile_links,
      missingTargets: row.sales_missing_targets,
      invalidEdgeIdentity: row.sales_invalid_edge_identity,
      cycleAffectedRecords: row.sales_cycle_affected_records,
      traversalLimitReached: row.sales_traversal_limit_reached,
      followerTargetsNonCanonicalRoot: row.sales_follower_targets_non_canonical_root,
      importBatchOwnershipMismatches: row.sales_import_batch_ownership_mismatches,
    },
  };
}

function sumCounts(value: unknown): number {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((sum, child) => sum + sumCounts(child), 0);
}

async function queryFindingCounts(tx: Prisma.TransactionClient): Promise<CountRow> {
  const rows = await tx.$queryRaw<CountRow[]>`
    WITH RECURSIVE
    expense_walk(start_id, current_id, path, cycle, depth) AS (
      SELECT e."ExpenseRecord_ID", e."ExpenseRecord_ID", ARRAY[e."ExpenseRecord_ID"], false, 0
      FROM "ExpenseRecord" e
      WHERE e."DuplicateOf_RecordID" IS NOT NULL
      UNION ALL
      SELECT w.start_id, target."ExpenseRecord_ID",
             w.path || target."ExpenseRecord_ID",
             target."ExpenseRecord_ID" = ANY(w.path),
             w.depth + 1
      FROM expense_walk w
      JOIN "ExpenseRecord" current_record ON current_record."ExpenseRecord_ID" = w.current_id
      JOIN "ExpenseRecord" target ON target."ExpenseRecord_ID" = current_record."DuplicateOf_RecordID"
      WHERE NOT w.cycle AND w.depth < ${MAX_DUPLICATE_TRAVERSAL_DEPTH}
    ),
    sales_walk(start_id, current_id, path, cycle, depth) AS (
      SELECT s."SalesReferenceRecord_ID", s."SalesReferenceRecord_ID",
             ARRAY[s."SalesReferenceRecord_ID"], false, 0
      FROM "SalesReferenceRecord" s
      WHERE s."DuplicateOf_RecordID" IS NOT NULL
      UNION ALL
      SELECT w.start_id, target."SalesReferenceRecord_ID",
             w.path || target."SalesReferenceRecord_ID",
             target."SalesReferenceRecord_ID" = ANY(w.path),
             w.depth + 1
      FROM sales_walk w
      JOIN "SalesReferenceRecord" current_record
        ON current_record."SalesReferenceRecord_ID" = w.current_id
      JOIN "SalesReferenceRecord" target
        ON target."SalesReferenceRecord_ID" = current_record."DuplicateOf_RecordID"
      WHERE NOT w.cycle AND w.depth < ${MAX_DUPLICATE_TRAVERSAL_DEPTH}
    )
    SELECT
      (SELECT COUNT(*)::int FROM "ExpenseRecord"
        WHERE "ExpenseRecord_DuplicateStatus" NOT IN ('Not a Duplicate', 'Flagged'))
        AS expense_invalid_duplicate_status,
      (SELECT COUNT(*)::int FROM "ExpenseRecord"
        WHERE "ExpenseRecord_DuplicateStatus" = 'Flagged' AND "DuplicateOf_RecordID" IS NULL)
        AS expense_flagged_without_pointer,
      (SELECT COUNT(*)::int FROM "ExpenseRecord"
        WHERE "ExpenseRecord_DuplicateStatus" <> 'Flagged' AND "DuplicateOf_RecordID" IS NOT NULL)
        AS expense_unflagged_with_pointer,
      (SELECT COUNT(*)::int FROM "ExpenseRecord"
        WHERE "DuplicateOf_RecordID" = "ExpenseRecord_ID") AS expense_self_links,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" source
        JOIN "ExpenseRecord" target ON target."ExpenseRecord_ID" = source."DuplicateOf_RecordID"
        WHERE target."BusinessProfile_ID" <> source."BusinessProfile_ID") AS expense_cross_profile_links,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" source
        LEFT JOIN "ExpenseRecord" target ON target."ExpenseRecord_ID" = source."DuplicateOf_RecordID"
        WHERE source."DuplicateOf_RecordID" IS NOT NULL AND target."ExpenseRecord_ID" IS NULL)
        AS expense_missing_targets,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" source
        JOIN "ExpenseRecord" target ON target."ExpenseRecord_ID" = source."DuplicateOf_RecordID"
        WHERE source."ExpenseRecord_ID" <> target."ExpenseRecord_ID"
          AND source."BusinessProfile_ID" = target."BusinessProfile_ID"
          AND (
            source."ExpenseRecord_Date" IS DISTINCT FROM target."ExpenseRecord_Date"
            OR source."ExpenseRecord_Amount" IS DISTINCT FROM target."ExpenseRecord_Amount"
            OR NOT (
              (
                NULLIF(btrim(regexp_replace(lower(normalize(COALESCE(source."ExpenseRecord_Vendor", ''), NFKC)), '[^[:alnum:]]+', ' ', 'g')), '') IS NOT NULL
                AND btrim(regexp_replace(lower(normalize(COALESCE(source."ExpenseRecord_Vendor", ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'))
                  = btrim(regexp_replace(lower(normalize(COALESCE(target."ExpenseRecord_Vendor", ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'))
              ) OR (
                NULLIF(btrim(regexp_replace(lower(normalize(COALESCE(source."ExpenseRecord_Description", ''), NFKC)), '[^[:alnum:]]+', ' ', 'g')), '') IS NOT NULL
                AND btrim(regexp_replace(lower(normalize(COALESCE(source."ExpenseRecord_Description", ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'))
                  = btrim(regexp_replace(lower(normalize(COALESCE(target."ExpenseRecord_Description", ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'))
              )
            )
          )) AS expense_invalid_edge_identity,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" source
        JOIN "ExpenseRecord" target ON target."ExpenseRecord_ID" = source."DuplicateOf_RecordID"
        WHERE source."ReceiptScan_ID" IS NOT NULL
          AND source."ReceiptScan_ID" = target."ReceiptScan_ID") AS expense_same_receipt_links,
      (SELECT COUNT(DISTINCT cycle_start)::int
        FROM (
          SELECT start_id AS cycle_start
          FROM expense_walk
          WHERE cycle
          UNION
          SELECT walk.start_id AS cycle_start
          FROM expense_walk walk
          JOIN "ExpenseRecord" current_record
            ON current_record."ExpenseRecord_ID" = walk.current_id
          JOIN "ExpenseRecord" target
            ON target."ExpenseRecord_ID" = current_record."DuplicateOf_RecordID"
          WHERE walk.depth = ${MAX_DUPLICATE_TRAVERSAL_DEPTH}
            AND NOT walk.cycle
            AND target."ExpenseRecord_ID" = ANY(walk.path)
        ) expense_cycles) AS expense_cycle_affected_records,
      (SELECT COUNT(DISTINCT walk.start_id)::int
        FROM expense_walk walk
        JOIN "ExpenseRecord" current_record ON current_record."ExpenseRecord_ID" = walk.current_id
        JOIN "ExpenseRecord" target ON target."ExpenseRecord_ID" = current_record."DuplicateOf_RecordID"
        WHERE walk.depth = ${MAX_DUPLICATE_TRAVERSAL_DEPTH}
          AND NOT walk.cycle) AS expense_traversal_limit_reached,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" record
        LEFT JOIN "ExpenseCategory" category ON category."Category_ID" = record."Category_ID"
        WHERE category."Category_ID" IS NULL
          OR category."BusinessProfile_ID" <> record."BusinessProfile_ID")
        AS expense_category_ownership_mismatches,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" record
        LEFT JOIN "ReceiptScan" receipt ON receipt."ReceiptScan_ID" = record."ReceiptScan_ID"
        WHERE record."ReceiptScan_ID" IS NOT NULL
          AND (receipt."ReceiptScan_ID" IS NULL
            OR receipt."BusinessProfile_ID" IS DISTINCT FROM record."BusinessProfile_ID"))
        AS expense_receipt_ownership_mismatches,
      (SELECT COUNT(*)::int FROM "ExpenseRecord" record
        LEFT JOIN "CSVImportBatch" batch ON batch."ImportBatch_ID" = record."ImportBatch_ID"
        WHERE record."ImportBatch_ID" IS NOT NULL
          AND (batch."ImportBatch_ID" IS NULL
            OR batch."BusinessProfile_ID" <> record."BusinessProfile_ID"))
        AS expense_import_batch_ownership_mismatches,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord"
        WHERE "SalesReferenceRecord_DuplicateStatus" NOT IN ('Not a Duplicate', 'Flagged'))
        AS sales_invalid_duplicate_status,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord"
        WHERE "SalesReferenceRecord_DuplicateStatus" = 'Flagged' AND "DuplicateOf_RecordID" IS NULL)
        AS sales_flagged_without_pointer,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord"
        WHERE "SalesReferenceRecord_DuplicateStatus" <> 'Flagged' AND "DuplicateOf_RecordID" IS NOT NULL)
        AS sales_unflagged_with_pointer,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord"
        WHERE "DuplicateOf_RecordID" = "SalesReferenceRecord_ID") AS sales_self_links,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord" source
        JOIN "SalesReferenceRecord" target
          ON target."SalesReferenceRecord_ID" = source."DuplicateOf_RecordID"
        WHERE target."BusinessProfile_ID" <> source."BusinessProfile_ID") AS sales_cross_profile_links,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord" source
        LEFT JOIN "SalesReferenceRecord" target
          ON target."SalesReferenceRecord_ID" = source."DuplicateOf_RecordID"
        WHERE source."DuplicateOf_RecordID" IS NOT NULL
          AND target."SalesReferenceRecord_ID" IS NULL) AS sales_missing_targets,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord" source
        JOIN "SalesReferenceRecord" target
          ON target."SalesReferenceRecord_ID" = source."DuplicateOf_RecordID"
        WHERE source."SalesReferenceRecord_ID" <> target."SalesReferenceRecord_ID"
          AND source."BusinessProfile_ID" = target."BusinessProfile_ID"
          AND (
            source."SalesReferenceRecord_Date" IS DISTINCT FROM target."SalesReferenceRecord_Date"
            OR source."SalesReferenceRecord_Amount" IS DISTINCT FROM target."SalesReferenceRecord_Amount"
            OR lower(source."SalesReferenceRecord_Description")
              <> lower(target."SalesReferenceRecord_Description")
          )) AS sales_invalid_edge_identity,
      (SELECT COUNT(DISTINCT cycle_start)::int
        FROM (
          SELECT start_id AS cycle_start
          FROM sales_walk
          WHERE cycle
          UNION
          SELECT walk.start_id AS cycle_start
          FROM sales_walk walk
          JOIN "SalesReferenceRecord" current_record
            ON current_record."SalesReferenceRecord_ID" = walk.current_id
          JOIN "SalesReferenceRecord" target
            ON target."SalesReferenceRecord_ID" = current_record."DuplicateOf_RecordID"
          WHERE walk.depth = ${MAX_DUPLICATE_TRAVERSAL_DEPTH}
            AND NOT walk.cycle
            AND target."SalesReferenceRecord_ID" = ANY(walk.path)
        ) sales_cycles) AS sales_cycle_affected_records,
      (SELECT COUNT(DISTINCT walk.start_id)::int
        FROM sales_walk walk
        JOIN "SalesReferenceRecord" current_record
          ON current_record."SalesReferenceRecord_ID" = walk.current_id
        JOIN "SalesReferenceRecord" target
          ON target."SalesReferenceRecord_ID" = current_record."DuplicateOf_RecordID"
        WHERE walk.depth = ${MAX_DUPLICATE_TRAVERSAL_DEPTH}
          AND NOT walk.cycle) AS sales_traversal_limit_reached,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord" source
        JOIN "SalesReferenceRecord" target
          ON target."SalesReferenceRecord_ID" = source."DuplicateOf_RecordID"
        WHERE source."SalesReferenceRecord_DuplicateStatus" = 'Flagged'
          AND (
            target."BusinessProfile_ID" <> source."BusinessProfile_ID"
            OR target."SalesReferenceRecord_DuplicateStatus" <> 'Not a Duplicate'
            OR target."DuplicateOf_RecordID" IS NOT NULL
          )) AS sales_follower_targets_non_canonical_root,
      (SELECT COUNT(*)::int FROM "SalesReferenceRecord" record
        LEFT JOIN "CSVImportBatch" batch ON batch."ImportBatch_ID" = record."ImportBatch_ID"
        WHERE record."ImportBatch_ID" IS NOT NULL
          AND (batch."ImportBatch_ID" IS NULL
            OR batch."BusinessProfile_ID" <> record."BusinessProfile_ID"))
        AS sales_import_batch_ownership_mismatches
  `;
  const row = rows[0];
  if (!row) throw new RecordIntegrityAuditError("AUDIT_QUERY_EMPTY");
  return row;
}

export async function runRecordIntegrityAudit(
  connection: RecordIntegrityAuditConnection,
): Promise<RecordIntegrityAuditReport> {
  const databaseUrl = validateAuditDatabaseUrl(
    connection.databaseUrl,
    connection.allowRemoteReadOnly ?? false,
    connection.expectedHostname,
    connection.expectedDatabase,
    connection.expectedFingerprint,
  );
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET default_transaction_read_only = on`;
      await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx.$queryRaw`
        SELECT
          set_config('statement_timeout', ${`${AUDIT_STATEMENT_TIMEOUT_MS}ms`}, true),
          set_config('lock_timeout', ${`${AUDIT_LOCK_TIMEOUT_MS}ms`}, true)
      `;
      const verification = await tx.$queryRaw<Array<{
        default_transaction_read_only: string;
        transaction_read_only: string;
        statement_timeout_ms: number;
        lock_timeout_ms: number;
      }>>`
        SELECT
          current_setting('default_transaction_read_only') AS default_transaction_read_only,
          current_setting('transaction_read_only') AS transaction_read_only,
          (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::int
            AS statement_timeout_ms,
          (extract(epoch FROM current_setting('lock_timeout')::interval) * 1000)::int
            AS lock_timeout_ms
      `;
      if (
        verification[0]?.default_transaction_read_only !== "on"
        || verification[0]?.transaction_read_only !== "on"
        || verification[0]?.statement_timeout_ms !== AUDIT_STATEMENT_TIMEOUT_MS
        || verification[0]?.lock_timeout_ms !== AUDIT_LOCK_TIMEOUT_MS
      ) {
        throw new RecordIntegrityAuditError("DATABASE_SAFETY_VERIFICATION_FAILED");
      }
      const findings = mapCounts(await queryFindingCounts(tx));
      const totalViolations = sumCounts(findings);
      return {
        check: CHECK_NAME,
        version: REPORT_VERSION,
        status: totalViolations === 0 ? "ok" : "findings",
        readOnlyVerified: true,
        safetySettingsVerified: true,
        totalViolations,
        findings,
      };
    }, { maxWait: 5_000, timeout: 60_000 });
  } finally {
    await client.$disconnect();
  }
}

export async function main(
  argv = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const args = parseAuditArguments(argv);
    if (args.help) {
      console.log(HELP_TEXT);
      return 0;
    }
    const report = await runRecordIntegrityAudit({
      databaseUrl: environment.RECORD_INTEGRITY_DATABASE_URL,
      allowRemoteReadOnly: args.allowRemoteReadOnly,
      expectedHostname: environment.RECORD_INTEGRITY_EXPECTED_HOST,
      expectedDatabase: environment.RECORD_INTEGRITY_EXPECTED_DATABASE,
      expectedFingerprint: environment.RECORD_INTEGRITY_EXPECTED_FINGERPRINT,
    });
    console.log(JSON.stringify(report));
    return report.status === "ok" ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({
      check: CHECK_NAME,
      version: REPORT_VERSION,
      status: "failed",
      code: error instanceof RecordIntegrityAuditError ? error.code : "AUDIT_FAILED",
    }));
    return 2;
  }
}

if (require.main === module) {
  void main().then((exitCode) => { process.exitCode = exitCode; });
}
