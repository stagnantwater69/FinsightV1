import { readdirSync, existsSync } from "node:fs";
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

export type MigrationDriftStatus = "ok" | "drift" | "unknown";

export interface MigrationDrift {
  status: MigrationDriftStatus;
  /** On disk, never recorded as finished against this database. */
  pending: string[];
  /** Started against this database and never finished — a half-applied schema. */
  failed: string[];
  /** Why the check could not reach a verdict. Only set when status is "unknown". */
  reason?: string;
}

interface MigrationRow {
  migration_name: string;
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
export function compareMigrations(onDisk: string[], rows: MigrationRow[]): Omit<MigrationDrift, "reason"> {
  const applied = new Set<string>();
  const failed: string[] = [];
  for (const row of rows) {
    if (row.rolled_back_at !== null) continue;
    if (row.finished_at !== null) applied.add(row.migration_name);
    else failed.push(row.migration_name);
  }
  const pending = onDisk.filter((name) => !applied.has(name));
  return { status: pending.length > 0 || failed.length > 0 ? "drift" : "ok", pending, failed };
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

/**
 * Compares the migrations in the repository against those recorded in the
 * database.
 *
 * A database this process cannot reach yields "unknown", never "drift". The
 * distinction matters: a momentary connection problem must not stop a process
 * from starting — the API already answers 503 while the database is away, and
 * refusing to boot would turn a blip into an outage that needs a human.
 */
export async function checkMigrationDrift(): Promise<MigrationDrift> {
  let onDisk: string[];
  try {
    onDisk = readMigrationsOnDisk();
  } catch (err) {
    return { status: "unknown", pending: [], failed: [], reason: `migrations directory unreadable: ${(err as Error).message}` };
  }

  let rows: MigrationRow[];
  try {
    rows = await prisma.$queryRaw<MigrationRow[]>(
      Prisma.sql`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
    );
  } catch (err) {
    if (isMissingMigrationsTable(err)) rows = [];
    else return { status: "unknown", pending: [], failed: [], reason: (err as Error).message };
  }

  return compareMigrations(onDisk, rows);
}

/**
 * Boot gate for `server.ts` and `worker.ts`. Exits the process on drift.
 *
 * Deliberately NOT wired into `app.ts`: the tests build the Express app
 * directly, and an integration suite running against its own throwaway
 * database has already applied its schema by other means.
 */
export async function assertMigrationsApplied(processName: string): Promise<void> {
  const drift = await checkMigrationDrift();

  if (drift.status === "unknown") {
    logger.warn(
      { processName, reason: drift.reason },
      "could not verify database migrations at startup; continuing",
    );
    return;
  }

  if (drift.status === "ok") {
    logger.info({ processName }, "database migrations verified");
    return;
  }

  logger.fatal(
    { processName, pending: drift.pending, failed: drift.failed },
    "REFUSING TO START: the database is not at the schema this build expects. " +
      "Requests touching the missing columns or tables would fail as opaque 500s. " +
      "Apply the migrations (`npx prisma migrate deploy`) and start again." +
      (drift.failed.length > 0
        ? " A migration is also recorded as started but never finished; that must be resolved first."
        : ""),
  );
  process.exit(1);
}
