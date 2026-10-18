// Run the backend suite against a Postgres container that belongs to this run.
//
//   npm run test:isolated                      # the whole suite
//   npm run test:isolated -- tests/integration/csvImport.test.ts
//
// The shared finsight-test-db is one database on one fixed port, and the
// integration tests truncate it between files, so two developers or agents
// running at once wipe each other's fixtures mid-test. Each run here gets its
// own container on a free loopback port, and removes only that container when
// it finishes, fails or is interrupted. The shared container is never touched.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import { backendTestCommand } from "./migrate-workflow/installedCli";

const BACKEND_ROOT = path.resolve(__dirname, "..");
const NAME_PREFIX = "finsight-test-run-";
const RUN_LABEL = "finsight.test-run";
const PID_LABEL = "finsight.test-run.pid";
// A process id only means something on the host and platform that recorded
// it: WSL and Windows can share one Docker daemon with separate process tables.
const HOST_LABEL = "finsight.test-run.host";
const THIS_HOST = `${hostname()}/${process.platform}`;
const DB = { user: "testuser", password: "testpass", name: "finsight_test" } as const;

export function containerNameFor(runId: string): string {
  return `${NAME_PREFIX}${runId}`;
}

export function databaseUrlFor(port: number): string {
  return `postgresql://${DB.user}:${DB.password}@127.0.0.1:${port}/${DB.name}`;
}

/** The arguments that create this run's container, bound to loopback only. */
export function containerRunArgs(runId: string, port: number, pid = process.pid): string[] {
  return [
    "run", "-d",
    "--name", containerNameFor(runId),
    "--label", `${RUN_LABEL}=${runId}`,
    "--label", `${PID_LABEL}=${pid}`,
    "--label", `${HOST_LABEL}=${THIS_HOST}`,
    "-e", `POSTGRES_USER=${DB.user}`,
    "-e", `POSTGRES_PASSWORD=${DB.password}`,
    "-e", `POSTGRES_DB=${DB.name}`,
    "-p", `127.0.0.1:${port}:5432`,
    "postgres:16-alpine",
  ];
}

/**
 * Removes the container only if its name and label both say this run made it.
 * A name alone could be reused by hand; the label is set at creation.
 */
export function removeOwnedContainer(runId: string, inspect = inspectLabel, remove = removeContainer): boolean {
  const name = containerNameFor(runId);
  if (inspect(name) !== runId) return false;
  remove(name);
  return true;
}

/**
 * A run killed outright (a closed window, Task Manager) never reaches its
 * cleanup. The next run removes those leftovers: containers this runner made
 * whose recorded process is gone. A live run's container is left alone.
 */
export function abandonedRuns(
  containers: { runId: string; pid: number; host: string }[],
  isAlive: (pid: number) => boolean = processIsAlive,
  host: string = THIS_HOST,
): string[] {
  return containers
    .filter((container) => container.host === host && !isAlive(container.pid))
    .map((container) => container.runId);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function listRunContainers(): { runId: string; pid: number; host: string }[] {
  const output = execFileSync(
    "docker",
    [
      "ps", "-a", "--filter", `label=${RUN_LABEL}`,
      "--format", `{{.Label "${RUN_LABEL}"}}\t{{.Label "${PID_LABEL}"}}\t{{.Label "${HOST_LABEL}"}}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return output.split(/\r?\n/).flatMap((line) => {
    const [runId, pid, host] = line.trim().split("\t");
    return runId && host && Number.isInteger(Number(pid)) && Number(pid) > 0 ? [{ runId, pid: Number(pid), host }] : [];
  });
}

function inspectLabel(name: string): string | null {
  try {
    return execFileSync("docker", ["inspect", "--format", `{{ index .Config.Labels "${RUN_LABEL}" }}`, name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function removeContainer(name: string): void {
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("No free port"))));
    });
  });
}

/** Ready over TCP, not just the socket: the image restarts once while initialising. */
async function waitForReady(name: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", DB.user, "-d", DB.name], { stdio: "ignore" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Test database ${name} was not ready within ${timeoutMs / 1000}s.`);
}

async function main(): Promise<number> {
  for (const staleRunId of abandonedRuns(listRunContainers())) {
    if (removeOwnedContainer(staleRunId)) console.log(`[test:isolated] removed abandoned ${containerNameFor(staleRunId)}`);
  }

  const runId =`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const name = containerNameFor(runId);
  const port = await findFreePort();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (removeOwnedContainer(runId)) console.log(`[test:isolated] removed ${name}`);
  };
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    execFileSync("docker", containerRunArgs(runId, port), { stdio: "ignore" });
    console.log(`[test:isolated] ${name} on 127.0.0.1:${port}`);
    await waitForReady(name);

    const url = databaseUrlFor(port);
    const [file, args] = backendTestCommand();
    return await new Promise<number>((resolve) => {
      const child = spawn(file, [...args, ...process.argv.slice(2)], {
        cwd: BACKEND_ROOT,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      });
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`[test:isolated] ${error.message}`);
      process.exit(1);
    },
  );
}
