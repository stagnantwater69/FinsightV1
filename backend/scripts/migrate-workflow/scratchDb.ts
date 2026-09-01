// Disposable migration-authoring database support.
//
// Spins up a uniquely-named, throwaway Postgres container
// ("finsight-migration-scratch-<runId>"), applies the FULL existing
// migration history to it via `prisma migrate deploy`, and tears it down
// afterward. This is intentionally separate from `finsight-test-db`
// (npm run test:db:up), which stays reserved for backend integration tests
// only — this module never touches that container or the `finsight_test`
// database.
//
// Every host this module ever connects to is 127.0.0.1 on a locally bound
// docker port. It never reads backend/.env and never accepts a hosted URL.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const SCRATCH_DB_USER = "scratch";
const SCRATCH_DB_PASSWORD = "scratch";
const SCRATCH_DB_NAME = "postgres";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export interface ScratchDatabase {
  runId: string;
  containerName: string;
  host: "127.0.0.1";
  port: number;
  databaseUrl: string;
  directUrl: string;
}

function generateRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Finds a free TCP port on loopback by briefly binding to port 0. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Could not determine a free port."));
      }
    });
  });
}

function connectionUrl(port: number): string {
  return `postgresql://${SCRATCH_DB_USER}:${SCRATCH_DB_PASSWORD}@127.0.0.1:${port}/${SCRATCH_DB_NAME}`;
}

async function waitForReady(containerName: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execFileSync("docker", ["exec", containerName, "pg_isready", "-U", SCRATCH_DB_USER], {
        stdio: "ignore",
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Scratch database container ${containerName} did not become ready within ${timeoutMs}ms.`);
}

/**
 * Creates and starts a disposable Postgres container, waits for it to
 * accept connections, then applies the repo's full migration history to it
 * with `prisma migrate deploy`. Returns connection info for the caller to
 * use (e.g. as the `--from-url` of a `prisma migrate diff`).
 */
export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const runId = generateRunId();
  const containerName = `finsight-migration-scratch-${runId}`;
  const port = await findFreePort();

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${SCRATCH_DB_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${SCRATCH_DB_PASSWORD}`,
      "-e",
      `POSTGRES_DB=${SCRATCH_DB_NAME}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      "postgres:16-alpine",
    ],
    { stdio: "inherit" }
  );

  try {
    await waitForReady(containerName);

    const url = connectionUrl(port);
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    });
  } catch (err) {
    // Best-effort cleanup if setup failed partway through.
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // Ignore teardown failures while already handling a setup failure.
    }
    throw err;
  }

  const url = connectionUrl(port);
  return { runId, containerName, host: "127.0.0.1", port, databaseUrl: url, directUrl: url };
}

export function teardownScratchDatabase(containerName: string): void {
  if (!containerName.startsWith("finsight-migration-scratch-")) {
    throw new Error(
      `Refusing to tear down "${containerName}" — does not look like a scratch migration container.`
    );
  }
  execFileSync("docker", ["rm", "-f", containerName], { stdio: "inherit" });
}
