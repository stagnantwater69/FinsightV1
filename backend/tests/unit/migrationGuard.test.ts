import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma } from "@prisma/client";

const queryRaw = vi.fn();
vi.mock("../../src/config/prisma", () => ({ prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));
vi.mock("../../src/config/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { assertMigrationsApplied, checkMigrationDrift, compareMigrations, readMigrationsOnDisk } from "../../src/config/migrationGuard";
import { logger } from "../../src/config/logger";

function row(name: string, over: { finished_at?: Date | null; rolled_back_at?: Date | null } = {}) {
  return { migration_name: name, finished_at: new Date(), rolled_back_at: null, ...over };
}

beforeEach(() => {
  queryRaw.mockReset();
  vi.mocked(logger.fatal).mockClear();
  vi.mocked(logger.warn).mockClear();
});

/*
 * The comparison that decides whether a process may serve traffic. Every case
 * below is a way the database and the build can disagree; the one that
 * actually happened is the first.
 */
describe("compareMigrations", () => {
  it("reports a migration that exists in the repo but was never applied", () => {
    const result = compareMigrations(
      ["20260101000000_a", "20260910152035_receipt_upload_idempotency"],
      [row("20260101000000_a")],
    );

    expect(result.status).toBe("drift");
    expect(result.pending).toEqual(["20260910152035_receipt_upload_idempotency"]);
    expect(result.failed).toEqual([]);
  });

  it("is clean when every migration on disk finished", () => {
    const result = compareMigrations(["a", "b"], [row("a"), row("b")]);
    expect(result).toEqual({ status: "ok", pending: [], failed: [] });
  });

  // A row Prisma wrote but never finished: the schema is part-way through a
  // migration, which `migrate deploy` refuses to move past until it is resolved.
  it("separates a half-applied migration from a merely missing one", () => {
    const result = compareMigrations(["a", "b"], [row("a", { finished_at: null })]);

    expect(result.status).toBe("drift");
    expect(result.failed).toEqual(["a"]);
    expect(result.pending).toEqual(["a", "b"]);
  });

  // Rolled back means the SQL is not in the database, whatever the row says.
  it("does not count a rolled-back migration as applied", () => {
    const result = compareMigrations(["a"], [row("a", { rolled_back_at: new Date() })]);
    expect(result.status).toBe("drift");
    expect(result.pending).toEqual(["a"]);
  });

  // A database ahead of the checkout is a different situation entirely — an
  // older build talking to a newer schema — and it is not this guard's business.
  it("ignores applied migrations that are not in this checkout", () => {
    const result = compareMigrations(["a"], [row("a"), row("z_from_a_newer_branch")]);
    expect(result.status).toBe("ok");
  });
});

describe("readMigrationsOnDisk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "finsight-migrations-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists migration directories in apply order and skips non-migrations", () => {
    for (const name of ["20260102000000_b", "20260101000000_a"]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "migration.sql"), "-- sql");
    }
    // No migration.sql — an editor leftover must not fail a boot on its own.
    mkdirSync(path.join(dir, "scratch"));
    writeFileSync(path.join(dir, "migration_lock.toml"), "provider = \"postgresql\"");

    expect(readMigrationsOnDisk(dir)).toEqual(["20260101000000_a", "20260102000000_b"]);
  });
});

describe("checkMigrationDrift", () => {
  /*
   * A database that cannot be reached has not told us anything about its
   * schema. Calling that "drift" would refuse to boot on a momentary network
   * blip — turning a condition the API already answers with a 503 into an
   * outage that needs a human — so it must stay distinguishable.
   */
  it("returns unknown, not drift, when the database is unreachable", async () => {
    queryRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: "P1001", clientVersion: "6.19.3" }),
    );

    const drift = await checkMigrationDrift();

    expect(drift.status).toBe("unknown");
    expect(drift.reason).toContain("reach database server");
  });

  // A database with no _prisma_migrations table has had nothing applied, which
  // is drift of the most complete kind — never an inability to check.
  it("treats a missing _prisma_migrations table as everything pending", async () => {
    queryRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('relation "_prisma_migrations" does not exist', {
        code: "P2010",
        clientVersion: "6.19.3",
        meta: { code: "42P01" },
      }),
    );

    const drift = await checkMigrationDrift();

    expect(drift.status).toBe("drift");
    expect(drift.pending.length).toBeGreaterThan(0);
  });

  // The real repository against the real migration list: proves the guard
  // agrees with itself when the database is up to date.
  it("passes when every migration in this repository is recorded as applied", async () => {
    queryRaw.mockResolvedValue(readMigrationsOnDisk().map((name) => row(name)));
    await expect(checkMigrationDrift()).resolves.toMatchObject({ status: "ok" });
  });
});

describe("assertMigrationsApplied", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });
  afterEach(() => exit.mockRestore());

  /*
   * The whole point. A process that starts here answers every request touching
   * the missing column with an opaque 500 while passing its health check — the
   * exact failure that reached a phone as "FinSight's server had a problem
   * with that" on a receipt scan that was never at fault.
   */
  it("exits non-zero rather than serving against a database that is behind", async () => {
    queryRaw.mockResolvedValue([]);

    await assertMigrationsApplied("api");

    expect(exit).toHaveBeenCalledWith(1);
    const [context, message] = vi.mocked(logger.fatal).mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain("REFUSING TO START");
    // Naming the migrations is what makes the log line actionable.
    expect((context.pending as string[]).length).toBeGreaterThan(0);
  });

  it("starts normally when the schema matches", async () => {
    queryRaw.mockResolvedValue(readMigrationsOnDisk().map((name) => row(name)));

    await assertMigrationsApplied("api");

    expect(exit).not.toHaveBeenCalled();
  });

  it("warns but still starts when the check itself could not run", async () => {
    queryRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Timed out fetching a connection", { code: "P1008", clientVersion: "6.19.3" }),
    );

    await assertMigrationsApplied("worker");

    expect(exit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
