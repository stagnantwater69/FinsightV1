/**
 * One command that says which layer is broken.
 *
 * Run from backend/: npm run doctor
 *
 * Every incident in this project's history has been slow to attribute rather
 * than slow to notice: "couldn't reach FinSight" on a phone, a stalled
 * PostgreSQL handshake, a worker that was simply not running. Each needed a
 * different check, and finding the right one took longer than fixing it. This
 * runs all of them and prints a line per layer, so the first FAIL names the
 * thing to go and look at.
 *
 * Rules this obeys:
 *   - read-only, always: nothing here writes, migrates, or retries;
 *   - never print a credential — URLs are reduced to host and port, and env
 *     files are reported by key NAME only;
 *   - one slow check never hides the others: each has its own deadline and its
 *     own line, and a failure is reported rather than thrown.
 */
import "dotenv/config";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describeDatabaseEndpoint, databaseErrorCode } from "./check-database";
import { workerHeartbeatPath } from "../src/lib/workerHeartbeat";

export type State = "OK" | "WARN" | "FAIL" | "SKIP";
export interface Check {
  name: string;
  state: State;
  summary: string;
  hint?: string;
}

const REPO = resolve(__dirname, "../..");
/** A round trip slower than this is usually the network, not the query. */
const SLOW_DB_MS = 250;
/** The probe's own ceiling: long enough for a cold pooler, short enough to move on. */
const PROBE_MS = 10_000;

async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? error.message;
  }
  return String(error);
}

/** Host:port only — a Supabase URL carries credentials in some forms. */
function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return "(unparseable)";
  }
}

export function checkNode(): Check {
  const wanted = 22;
  const major = Number(process.versions.node.split(".")[0]);
  if (major === wanted) return { name: "node", state: "OK", summary: process.version };
  return {
    name: "node",
    state: "WARN",
    summary: `${process.version}, project expects ${wanted}`,
    hint: "source ~/.nvm/nvm.sh && nvm use 22 — results on another major are not comparable to CI",
  };
}

/** Presence and key NAMES only. Values are never read into the output. */
function checkEnvFile(): Check {
  const file = join(REPO, "backend/.env");
  if (!existsSync(file)) {
    return {
      name: "env",
      state: "FAIL",
      summary: "backend/.env is missing",
      hint: "Copy from ~/.finsight-env-backup/ — this file holds live credentials with no copy in the repo",
    };
  }
  const names = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")));
  const required = ["DATABASE_URL", "DIRECT_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((key) => !names.includes(key));
  if (missing.length > 0) {
    return { name: "env", state: "FAIL", summary: `missing ${missing.join(", ")}`, hint: "See backend/.env.example" };
  }
  return { name: "env", state: "OK", summary: `backend/.env, ${names.length} keys` };
}

async function checkDatabase(): Promise<{ check: Check; reachable: boolean }> {
  let endpoint: ReturnType<typeof describeDatabaseEndpoint>;
  try {
    endpoint = describeDatabaseEndpoint(process.env.DATABASE_URL);
  } catch (error) {
    return {
      check: { name: "database", state: "FAIL", summary: reason(error), hint: "DATABASE_URL is missing or malformed" },
      reachable: false,
    };
  }
  const where = `${endpoint.host.replace(/\..*/, "…")}:${endpoint.port}`;
  const startedAt = performance.now();
  try {
    const { prisma } = await import("../src/config/prisma");
    await withTimeout(PROBE_MS, async () => prisma.$queryRaw`SELECT 1`);
    const ms = Math.round(performance.now() - startedAt);
    await prisma.$disconnect().catch(() => undefined);
    if (ms > SLOW_DB_MS) {
      return {
        check: {
          name: "database",
          state: "WARN",
          summary: `${where} reachable, ${ms}ms round trip`,
          hint: "Every scan makes tens of round trips; this is the distance to the database, not a bug",
        },
        reachable: true,
      };
    }
    return { check: { name: "database", state: "OK", summary: `${where}, ${ms}ms` }, reachable: true };
  } catch (error) {
    return {
      check: {
        name: "database",
        state: "FAIL",
        summary: `${where} — ${databaseErrorCode(error)}`,
        hint: "Compare with docs/database-connection-incident-2026-09-11.md before assuming the provider is down",
      },
      reachable: false,
    };
  }
}

/** Applied rows against migration directories on disk; pending is the useful number. */
async function checkMigrations(databaseReachable: boolean): Promise<Check> {
  if (!databaseReachable) return { name: "migrations", state: "SKIP", summary: "database unreachable" };
  const dir = join(REPO, "backend/prisma/migrations");
  const onDisk = existsSync(dir)
    ? readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory()).length
    : 0;
  try {
    const { prisma } = await import("../src/config/prisma");
    const rows = await withTimeout(PROBE_MS, async () =>
      prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`);
    await prisma.$disconnect().catch(() => undefined);
    const applied = Number(rows[0]?.count ?? 0);
    if (applied < onDisk) {
      return {
        name: "migrations",
        state: "FAIL",
        summary: `${applied} applied, ${onDisk - applied} pending`,
        hint: "The API and worker both refuse to start until these are applied",
      };
    }
    return { name: "migrations", state: "OK", summary: `${applied} applied` };
  } catch (error) {
    return { name: "migrations", state: "WARN", summary: reason(error) };
  }
}

export interface Readiness {
  status?: string;
  queuedReceiptScans?: number;
  oldestQueuedReceiptScanAgeSeconds?: number | null;
  failedAnalysisJobs?: number;
  queuedCsvImports?: number;
  queuedAnalysisJobs?: number;
  stalledAccountDeletions?: number;
}

async function probeApi(): Promise<{ check: Check; readiness: Readiness | null }> {
  const port = process.env.PORT ?? "4000";
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    // The token is what unlocks queue detail in production; harmless without it.
    const headers = process.env.HEALTH_DETAIL_TOKEN
      ? { "x-health-token": process.env.HEALTH_DETAIL_TOKEN }
      : undefined;
    const res = await withTimeout(PROBE_MS, () => fetch(`${base}/health/ready`, { headers }));
    const body = (await res.json().catch(() => ({}))) as Readiness;
    if (!res.ok) {
      return {
        check: {
          name: "api",
          state: "FAIL",
          summary: `:${port} answered ${res.status}`,
          hint: body.status ? `reported "${body.status}"` : "check the API log",
        },
        readiness: body,
      };
    }
    return { check: { name: "api", state: "OK", summary: `:${port} ready` }, readiness: body };
  } catch (error) {
    return {
      check: {
        name: "api",
        state: "FAIL",
        summary: `:${port} — ${reason(error)}`,
        hint: "Start it: npm run dev --prefix backend",
      },
      readiness: null,
    };
  }
}

/**
 * The worker writes this file from its own timer, so a fresh mtime means its
 * event loop is still turning. Absent locally is normal — the health directory
 * only exists in the container — so the queue ages below are what actually
 * tell you whether work is moving.
 */
function checkWorkerHeartbeat(): Check {
  const file = workerHeartbeatPath();
  if (!existsSync(file)) {
    return { name: "worker", state: "SKIP", summary: "no heartbeat file (normal outside the container)" };
  }
  const age = Math.round((Date.now() - statSync(file).mtimeMs) / 1000);
  if (age > 45) {
    return {
      name: "worker",
      state: "FAIL",
      summary: `heartbeat ${age}s old`,
      hint: "The probe's ceiling is 45s; the worker is wedged or stopped",
    };
  }
  return { name: "worker", state: "OK", summary: `heartbeat ${age}s ago` };
}

/**
 * The signal that actually catches a stopped worker in development: work
 * waiting with nothing picking it up. A worker that is running claims within a
 * second or two, so anything older than a minute means nobody is consuming.
 */
export function checkQueues(readiness: Readiness | null): Check {
  if (!readiness || readiness.queuedReceiptScans === undefined) {
    return {
      name: "queues",
      state: "SKIP",
      summary: readiness ? "API withheld queue detail" : "needs the API",
      ...(readiness ? { hint: "Set HEALTH_DETAIL_TOKEN to match the API's" } : {}),
    };
  }
  const scans = readiness.queuedReceiptScans ?? 0;
  const csv = readiness.queuedCsvImports ?? 0;
  const analysis = readiness.queuedAnalysisJobs ?? 0;
  const oldest = readiness.oldestQueuedReceiptScanAgeSeconds ?? null;
  const summary = `receipts ${scans}, csv ${csv}, analysis ${analysis}`;
  if (oldest !== null && oldest > 60) {
    return {
      name: "queues",
      state: "FAIL",
      summary: `${summary} — oldest receipt waiting ${oldest}s`,
      hint: "Nothing is consuming. Start the worker: npm run worker:dev --prefix backend",
    };
  }
  if ((readiness.stalledAccountDeletions ?? 0) > 0) {
    return {
      name: "queues",
      state: "WARN",
      summary: `${summary} — ${readiness.stalledAccountDeletions} stalled account deletion(s)`,
      hint: "A deletion past its retries is a data obligation nobody is working on",
    };
  }
  return { name: "queues", state: "OK", summary: oldest === null ? summary : `${summary}, oldest ${oldest}s` };
}

async function checkStorage(): Promise<Check> {
  const url = process.env.SUPABASE_URL;
  if (!url) return { name: "storage", state: "FAIL", summary: "SUPABASE_URL is not set" };
  try {
    const res = await withTimeout(PROBE_MS, () => fetch(`${url.replace(/\/$/, "")}/storage/v1/version`));
    if (!res.ok) return { name: "storage", state: "WARN", summary: `${endpointOf(url)} answered ${res.status}` };
    return { name: "storage", state: "OK", summary: endpointOf(url) };
  } catch (error) {
    return { name: "storage", state: "FAIL", summary: `${endpointOf(url)} — ${reason(error)}` };
  }
}

/**
 * The address the phone was built to call.
 *
 * "Couldn't reach FinSight" is almost always this line: the app is pointed at
 * a host that is correct from the laptop and unreachable from the device (a
 * tailnet address with the phone off the tailnet, or a LAN IP the router has
 * since reassigned). Reachability from HERE does not prove the phone can get
 * there, and the line says so.
 */
async function checkMobileTarget(): Promise<Check> {
  const file = join(REPO, "mobile/.env");
  if (!existsSync(file)) return { name: "mobile", state: "SKIP", summary: "no mobile/.env" };
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith("EXPO_PUBLIC_API_BASE_URL="));
  if (!line) return { name: "mobile", state: "SKIP", summary: "EXPO_PUBLIC_API_BASE_URL is not set" };
  const target = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  const where = endpointOf(target);
  try {
    const res = await withTimeout(PROBE_MS, () => fetch(`${target.replace(/\/$/, "")}/health/live`));
    if (!res.ok) return { name: "mobile", state: "WARN", summary: `${where} answered ${res.status}` };
    return { name: "mobile", state: "OK", summary: `${where} reachable from this host` };
  } catch (error) {
    return {
      name: "mobile",
      state: "FAIL",
      summary: `${where} — ${reason(error)}`,
      hint: "The device needs this exact address. On a tailnet address, check the phone is still on the tailnet",
    };
  }
}

const MARK: Record<State, string> = { OK: "OK  ", WARN: "WARN", FAIL: "FAIL", SKIP: "--  " };

async function main(): Promise<void> {
  const checks: Check[] = [checkNode(), checkEnvFile()];

  const database = await checkDatabase();
  checks.push(database.check);
  checks.push(await checkMigrations(database.reachable));

  const api = await probeApi();
  checks.push(api.check);
  checks.push(checkWorkerHeartbeat());
  checks.push(checkQueues(api.readiness));
  checks.push(await checkStorage());
  checks.push(await checkMobileTarget());

  const width = Math.max(...checks.map((check) => check.name.length));
  console.log(`\nFinSight doctor — ${new Date().toISOString()}\n`);
  for (const check of checks) {
    console.log(`  ${MARK[check.state]}  ${check.name.padEnd(width)}  ${check.summary}`);
    if (check.hint && check.state !== "OK") console.log(`        ${" ".repeat(width)}  ↳ ${check.hint}`);
  }

  const failed = checks.filter((check) => check.state === "FAIL");
  const warned = checks.filter((check) => check.state === "WARN");
  console.log("");
  if (failed.length > 0) {
    console.log(`${failed.length} failing. Start with "${failed[0]!.name}" — the layers below it may fail because of it.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(warned.length > 0 ? `No failures, ${warned.length} warning(s).\n` : "All checks passed.\n");
}

if (require.main === module) {
  void main();
}
