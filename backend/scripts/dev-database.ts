import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { shouldUseDatabaseTlsRelay, startDatabaseTlsRelay, type DatabaseTlsRelay } from "./database-tls-relay";

const commands: Record<string, string[]> = {
  api: ["watch", "src/server.ts"],
  worker: ["watch", "src/worker.ts"],
  check: ["scripts/check-database.ts"],
};

async function main(): Promise<void> {
  const command = process.argv[2] ?? "api";
  const args = commands[command];
  if (!args) throw new Error("Use dev-database.ts api, worker, or check.");

  const childEnv = { ...process.env };
  childEnv.NODE_ENV ??= "development";
  let relay: DatabaseTlsRelay | undefined;
  if (
    childEnv.NODE_ENV === "development" &&
    childEnv.DATABASE_URL &&
    shouldUseDatabaseTlsRelay(childEnv.DATABASE_URL)
  ) {
    relay = await startDatabaseTlsRelay(childEnv.DATABASE_URL);
    childEnv.DATABASE_URL = relay.databaseUrl;
    console.info("[dev] Supabase connection uses a local TLS handshake relay; database traffic stays encrypted.");
  }

  const child = spawn(process.execPath, [require.resolve("tsx/cli"), ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: childEnv,
    stdio: "inherit",
  });
  let stopping = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    forceTimer = setTimeout(() => child.kill("SIGKILL"), command === "worker" ? 35_000 : 15_000);
    forceTimer.unref();
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1)));
    });
    process.exitCode = code;
  } finally {
    clearTimeout(forceTimer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    await relay?.close();
  }
}

void main().catch((error: unknown) => {
  // Never print connection strings or exception objects from a transport path.
  console.error(error instanceof Error && error.message.startsWith("Use dev-database.ts")
    ? error.message
    : "The local database launcher could not start. Check the development connection settings.");
  process.exitCode = 1;
});
