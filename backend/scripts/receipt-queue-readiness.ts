import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_AFTER_SECONDS = 300;
const MIN_STALE_AFTER_SECONDS = 60;
const MAX_STALE_AFTER_SECONDS = 3_600;
export const PROVIDER_DISPATCH_RECONCILIATION_AFTER_SECONDS = 10 * 60;
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "prisma", "migrations");

const HELP = `Usage: npm run ops:receipt-queue:readiness

Required environment:
  DATABASE_URL

Optional environment:
  RECEIPT_QUEUE_STALE_AFTER_SECONDS (60..3600, default 300)

This command is read-only. It emits database, migration, queue, cleanup, and
provider-budget counts without receipt text, object names, identifiers, or
financial values.`;

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

interface MigrationTableEvidence {
  exists: boolean;
}

interface TransactionEvidence {
  transaction_read_only: string;
}

export interface QueueEvidence {
  receiptQueueDepth: number;
  activeReceiptLeaseCount: number;
  claimableReceiptCount: number;
  oldestClaimableReceiptAgeSeconds: number;
  failedReceiptCount: number;
  pendingReceiptPurgeCount: number;
  staleReceiptPurgeCount: number;
  exhaustedProviderBudgetCount: number;
  unsafeProviderBudgetCount: number;
  providerDispatchCount: number;
  submittedProviderDispatchCount: number;
  staleProviderReservationCount: number;
  staleSubmittedProviderDispatchCount: number;
  ambiguousProviderDispatchCount: number;
}

export type ReceiptQueueReadinessOutput = {
  check: "receipt-queue-readiness";
  status: "ok" | "attention";
  database: "ok";
  databaseTransaction: "read-only";
  migrations: "ok";
  pendingMigrationCount: 0;
  failedMigrationCount: 0;
  workerQueue: "idle" | "working" | "scheduled" | "claimable" | "stale";
  receiptQueueDepth: number;
  activeReceiptLeaseCount: number;
  claimableReceiptCount: number;
  oldestClaimableReceiptAgeSeconds: number;
  queueStaleAfterSeconds: number;
  failedReceiptCount: number;
  pendingReceiptPurgeCount: number;
  staleReceiptPurgeCount: number;
  providerBudget: "bounded" | "unsafe";
  providerDispatchReview: "ok" | "attention";
  providerDispatchReconciliationAfterSeconds: number;
  exhaustedProviderBudgetCount: number;
  unsafeProviderBudgetCount: number;
  providerDispatchCount: number;
  submittedProviderDispatchCount: number;
  staleProviderReservationCount: number;
  staleSubmittedProviderDispatchCount: number;
  ambiguousProviderDispatchCount: number;
};

interface DatabaseEvidence {
  migrationRows: MigrationRow[];
  queue: QueueEvidence | null;
}

const QUEUE_EVIDENCE_SQL = `
SELECT
  (
    SELECT count(*)::int
    FROM "ReceiptScan"
    WHERE "ReceiptScan_ProcessingStatus" = 'Processing'
  ) AS "receiptQueueDepth",
  (
    SELECT count(*)::int
    FROM "ReceiptScan"
    WHERE "ReceiptScan_ProcessingStatus" = 'Processing'
      AND "ReceiptScan_ProcessingWorkerID" IS NOT NULL
      AND "ReceiptScan_ProcessingHeartbeatAt" >= CURRENT_TIMESTAMP - INTERVAL '2 minutes'
  ) AS "activeReceiptLeaseCount",
  (
    SELECT count(*)::int
    FROM "ReceiptScan"
    WHERE "ReceiptScan_ProcessingStatus" = 'Processing'
      AND "ReceiptScan_NextProcessingAttemptAt" <= CURRENT_TIMESTAMP
      AND (
        "ReceiptScan_ProcessingWorkerID" IS NULL
        OR "ReceiptScan_ProcessingHeartbeatAt" IS NULL
        OR "ReceiptScan_ProcessingHeartbeatAt" < CURRENT_TIMESTAMP - INTERVAL '2 minutes'
      )
  ) AS "claimableReceiptCount",
  GREATEST(0, COALESCE((
    SELECT floor(extract(epoch FROM CURRENT_TIMESTAMP - min("ReceiptScan_CreatedAt")))::int
    FROM "ReceiptScan"
    WHERE "ReceiptScan_ProcessingStatus" = 'Processing'
      AND "ReceiptScan_NextProcessingAttemptAt" <= CURRENT_TIMESTAMP
      AND (
        "ReceiptScan_ProcessingWorkerID" IS NULL
        OR "ReceiptScan_ProcessingHeartbeatAt" IS NULL
        OR "ReceiptScan_ProcessingHeartbeatAt" < CURRENT_TIMESTAMP - INTERVAL '2 minutes'
      )
  ), 0)) AS "oldestClaimableReceiptAgeSeconds",
  (
    SELECT count(*)::int
    FROM "ReceiptScan"
    WHERE "ReceiptScan_ProcessingStatus" = 'Failed'
  ) AS "failedReceiptCount",
  (
    SELECT count(*)::int
    FROM "ReceiptPurgeJob"
    WHERE "ReceiptPurgeJob_Status" IN ('PENDING', 'RETRY', 'PROCESSING')
  ) AS "pendingReceiptPurgeCount",
  (
    SELECT count(*)::int
    FROM "ReceiptPurgeJob"
    WHERE "ReceiptPurgeJob_Status" = 'PROCESSING'
      AND (
        "ReceiptPurgeJob_HeartbeatAt" IS NULL
        OR "ReceiptPurgeJob_HeartbeatAt" < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
      )
  ) AS "staleReceiptPurgeCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderBudget"
    WHERE "ExternalProviderBudget_ReservedUnits" + "ExternalProviderBudget_UsedUnits"
          >= "ExternalProviderBudget_LimitUnits"
  ) AS "exhaustedProviderBudgetCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderBudget"
    WHERE "ExternalProviderBudget_LimitUnits" < 0
       OR "ExternalProviderBudget_LimitUnits" > 100
       OR "ExternalProviderBudget_ReservedUnits" < 0
       OR "ExternalProviderBudget_UsedUnits" < 0
       OR "ExternalProviderBudget_ReservedUnits" + "ExternalProviderBudget_UsedUnits"
          > "ExternalProviderBudget_LimitUnits"
  ) AS "unsafeProviderBudgetCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderDispatch"
  ) AS "providerDispatchCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderDispatch"
    WHERE "ExternalProviderDispatch_SubmittedAt" IS NOT NULL
  ) AS "submittedProviderDispatchCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderDispatch"
    WHERE "ExternalProviderDispatch_Status" = 'RESERVED'
      AND "ExternalProviderDispatch_CreatedAt"
          < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 second')
  ) AS "staleProviderReservationCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderDispatch"
    WHERE "ExternalProviderDispatch_Status" = 'SUBMITTED'
      AND "ExternalProviderDispatch_SubmittedAt"
          < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 second')
  ) AS "staleSubmittedProviderDispatchCount",
  (
    SELECT count(*)::int
    FROM "ExternalProviderDispatch"
    WHERE "ExternalProviderDispatch_Status" = 'AMBIGUOUS'
  ) AS "ambiguousProviderDispatchCount"
`;

function safeDatabaseUrl(value: string | undefined): string {
  if (!value || value.trim() === "" || value !== value.trim()) throw new Error("DATABASE_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.hash !== ""
  ) {
    throw new Error("DATABASE_URL_INVALID");
  }
  if (!parsed.searchParams.has("connect_timeout")) parsed.searchParams.set("connect_timeout", "10");
  if (!parsed.searchParams.has("pool_timeout")) parsed.searchParams.set("pool_timeout", "10");
  if (!parsed.searchParams.has("connection_limit")) parsed.searchParams.set("connection_limit", "1");
  return parsed.toString();
}

function staleAfterSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_STALE_AFTER_SECONDS;
  if (!/^\d+$/.test(value)) throw new Error("QUEUE_STALE_THRESHOLD_INVALID");
  const parsed = Number(value);
  if (parsed < MIN_STALE_AFTER_SECONDS || parsed > MAX_STALE_AFTER_SECONDS) {
    throw new Error("QUEUE_STALE_THRESHOLD_INVALID");
  }
  return parsed;
}

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(MIGRATIONS_DIR, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) return error.message;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^P\d{4}$/.test(code)) return code;
  }
  return "READINESS_CHECK_FAILED";
}

export function buildReceiptQueueReadinessOutput(
  queue: QueueEvidence,
  queueStaleAfter: number,
): ReceiptQueueReadinessOutput {
  const queueFresh =
    queue.claimableReceiptCount === 0 ||
    queue.oldestClaimableReceiptAgeSeconds <= queueStaleAfter;
  const paidOverageGuardReady = queue.unsafeProviderBudgetCount === 0;
  const providerAuditNeedsReview =
    queue.staleProviderReservationCount > 0 ||
    queue.staleSubmittedProviderDispatchCount > 0 ||
    queue.ambiguousProviderDispatchCount > 0;
  const status = queueFresh && paidOverageGuardReady && !providerAuditNeedsReview
    ? "ok"
    : "attention";
  const queueState = queue.receiptQueueDepth === 0
    ? "idle"
    : queue.activeReceiptLeaseCount > 0
      ? "working"
      : queue.claimableReceiptCount === 0
        ? "scheduled"
        : queueFresh ? "claimable" : "stale";

  return {
    check: "receipt-queue-readiness",
    status,
    database: "ok",
    databaseTransaction: "read-only",
    migrations: "ok",
    pendingMigrationCount: 0,
    failedMigrationCount: 0,
    workerQueue: queueState,
    receiptQueueDepth: queue.receiptQueueDepth,
    activeReceiptLeaseCount: queue.activeReceiptLeaseCount,
    claimableReceiptCount: queue.claimableReceiptCount,
    oldestClaimableReceiptAgeSeconds: queue.oldestClaimableReceiptAgeSeconds,
    queueStaleAfterSeconds: queueStaleAfter,
    failedReceiptCount: queue.failedReceiptCount,
    pendingReceiptPurgeCount: queue.pendingReceiptPurgeCount,
    staleReceiptPurgeCount: queue.staleReceiptPurgeCount,
    providerBudget: paidOverageGuardReady ? "bounded" : "unsafe",
    providerDispatchReview: providerAuditNeedsReview ? "attention" : "ok",
    providerDispatchReconciliationAfterSeconds: PROVIDER_DISPATCH_RECONCILIATION_AFTER_SECONDS,
    exhaustedProviderBudgetCount: queue.exhaustedProviderBudgetCount,
    unsafeProviderBudgetCount: queue.unsafeProviderBudgetCount,
    providerDispatchCount: queue.providerDispatchCount,
    submittedProviderDispatchCount: queue.submittedProviderDispatchCount,
    staleProviderReservationCount: queue.staleProviderReservationCount,
    staleSubmittedProviderDispatchCount: queue.staleSubmittedProviderDispatchCount,
    ambiguousProviderDispatchCount: queue.ambiguousProviderDispatchCount,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(HELP);
    return;
  }
  if (args.length !== 0) throw new Error("INVALID_ARGUMENT");

  const explicitEnvironment = { ...process.env };
  const databaseUrl = safeDatabaseUrl(explicitEnvironment.DATABASE_URL);
  const queueStaleAfter = staleAfterSeconds(explicitEnvironment.RECEIPT_QUEUE_STALE_AFTER_SECONDS);
  const expectedMigrations = migrationDirectories();
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  const timeout = setTimeout(() => {
    console.error(JSON.stringify({
      check: "receipt-queue-readiness",
      status: "failed",
      database: "unavailable",
      errorCode: "READINESS_CHECK_TIMEOUT",
    }));
    process.exit(1);
  }, CHECK_TIMEOUT_MS);

  try {
    const evidence = await client.$transaction<DatabaseEvidence>(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const transactionMode = await transaction.$queryRaw<TransactionEvidence[]>`
        SHOW transaction_read_only
      `;
      if (transactionMode[0]?.transaction_read_only !== "on") {
        throw new Error("READ_ONLY_TRANSACTION_REQUIRED");
      }
      const migrationTable = await transaction.$queryRaw<MigrationTableEvidence[]>`
        SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS "exists"
      `;
      const migrationRows = migrationTable[0]?.exists
        ? await transaction.$queryRaw<MigrationRow[]>`
            SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
          `
        : [];
      const applied = new Set(
        migrationRows
          .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
          .map((row) => row.migration_name),
      );
      const failed = migrationRows.some(
        (row) => row.finished_at === null && row.rolled_back_at === null,
      );
      if (failed || expectedMigrations.some((name) => !applied.has(name))) {
        return { migrationRows, queue: null };
      }
      const queueRows = await transaction.$queryRawUnsafe<QueueEvidence[]>(
        QUEUE_EVIDENCE_SQL,
        PROVIDER_DISPATCH_RECONCILIATION_AFTER_SECONDS,
      );
      return { migrationRows, queue: queueRows[0] ?? null };
    }, { maxWait: 10_000, timeout: 25_000 });

    const migrationRows = evidence.migrationRows;
    const appliedMigrations = new Set(
      migrationRows
        .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
        .map((row) => row.migration_name),
    );
    const pendingMigrationCount = expectedMigrations.filter((name) => !appliedMigrations.has(name)).length;
    const failedMigrationCount = migrationRows.filter(
      (row) => row.finished_at === null && row.rolled_back_at === null,
    ).length;
    const migrationsReady = pendingMigrationCount === 0 && failedMigrationCount === 0;
    if (!migrationsReady) {
      console.log(JSON.stringify({
        check: "receipt-queue-readiness",
        status: "attention",
        database: "ok",
        databaseTransaction: "read-only",
        migrations: "drift",
        pendingMigrationCount,
        failedMigrationCount,
        workerQueue: "not-checked",
      }));
      process.exitCode = 1;
      return;
    }

    const queue = evidence.queue;
    if (!queue) throw new Error("QUEUE_EVIDENCE_MISSING");
    const output = buildReceiptQueueReadinessOutput(queue, queueStaleAfter);
    console.log(JSON.stringify(output));
    process.exitCode = output.status === "ok" ? 0 : 1;
  } finally {
    clearTimeout(timeout);
    await client.$disconnect().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const code = errorCode(error);
    const database = ["INVALID_ARGUMENT", "DATABASE_URL_INVALID", "QUEUE_STALE_THRESHOLD_INVALID"]
      .includes(code)
      ? "not-checked"
      : "unavailable";
    console.error(JSON.stringify({
      check: "receipt-queue-readiness",
      status: "failed",
      database,
      errorCode: code,
    }));
    process.exitCode = 1;
  });
}
