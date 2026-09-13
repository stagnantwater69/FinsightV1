/**
 * Read-only connectivity check through the same Prisma client as the API.
 * Run from backend/: npm run db:check
 *
 * Do not print connection URLs, credentials, or Prisma's raw error message:
 * a connection error can contain the original URL or credential details.
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";

const CHECK_TIMEOUT_MS = 45_000;

export function describeDatabaseEndpoint(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("DATABASE_URL_INVALID");
  }

  const port = parsed.port || "5432";
  const sharedPooler = parsed.hostname.endsWith(".pooler.supabase.com");
  return {
    host: parsed.hostname,
    port,
    mode: sharedPooler
      ? port === "6543" ? "shared-transaction-pooler" : "shared-session-pooler"
      : "postgres",
  };
}

export function databaseErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "DATABASE_CHECK_FAILED";
  for (const key of ["code", "errorCode"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && /^P\d{4}$/.test(value)) return value;
  }
  return "DATABASE_CHECK_FAILED";
}

async function main() {
  const startedAt = performance.now();
  let endpoint: ReturnType<typeof describeDatabaseEndpoint>;
  try {
    endpoint = describeDatabaseEndpoint(process.env.DATABASE_URL);
  } catch {
    console.error(JSON.stringify({ status: "failed", errorCode: "DATABASE_URL_INVALID" }));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ check: "database", ...endpoint, timeoutMs: CHECK_TIMEOUT_MS }));
  // A broken handshake or disconnect must not leave an incident check hanging.
  // This is a CLI-only deadline; no server request or write is retried here.
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({
      status: "failed",
      errorCode: "DATABASE_CHECK_TIMEOUT",
      elapsedMs: Math.round(performance.now() - startedAt),
    }));
    process.exit(1);
  }, CHECK_TIMEOUT_MS);

  let disconnect: (() => Promise<void>) | undefined;
  let result: { status: string; errorCode?: string };
  try {
    const { prisma } = await import("../src/config/prisma");
    disconnect = () => prisma.$disconnect();
    await prisma.$queryRaw`SELECT 1`;
    result = { status: "ok" };
  } catch (error) {
    result = { status: "failed", errorCode: databaseErrorCode(error) };
    process.exitCode = 1;
  } finally {
    await disconnect?.().catch(() => undefined);
    clearTimeout(deadline);
  }

  console.log(JSON.stringify({ ...result, elapsedMs: Math.round(performance.now() - startedAt) }));
}

if (require.main === module) {
  void main();
}
