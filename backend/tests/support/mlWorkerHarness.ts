import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function workerEnvironment(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const strict = env.FINSIGHT_REQUIRE_ML_WORKER_CONTRACT;
  if (strict !== undefined && strict !== "0" && strict !== "1") {
    throw new Error("FINSIGHT_REQUIRE_ML_WORKER_CONTRACT must be 0 or 1");
  }
  const override = env.FINSIGHT_ML_CONTRACT_PYTHON?.trim();
  const python = override
    ? path.resolve(repoRoot, override)
    : path.join(repoRoot, "ml", ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const server = path.join(repoRoot, "ml/worker/server.py");
  const requirements = path.join(repoRoot, "ml/requirements.txt");
  const missing = [python, server, requirements].filter((file) => !existsSync(file));
  return { repoRoot, python, server, requirements, required: strict === "1", available: missing.length === 0 };
}

export function validateWorkerVersions(
  requirements: string,
  versions: { python: number[]; numpy: string; sklearn: string },
) {
  for (const [dependency, actual] of [["numpy", versions.numpy], ["scikit-learn", versions.sklearn]]) {
    const matches = [...requirements.matchAll(new RegExp(`^${dependency}==([^\\s#]+)\\s*(?:#.*)?$`, "gm"))];
    if (matches.length !== 1 || matches[0]?.[1] !== actual) {
      throw new Error(`ML contract requires the exact ${dependency} pin in ml/requirements.txt`);
    }
  }
  if (versions.python[0] !== 3 || versions.python[1] !== 14) {
    throw new Error("ML contract requires Python 3.14 (ml/README.md)");
  }
}

export function checkWorkerPrerequisites(config: ReturnType<typeof workerEnvironment>) {
  if (!config.available) {
    throw new Error("ML contract prerequisites unavailable: create the pinned ml/.venv or set FINSIGHT_ML_CONTRACT_PYTHON");
  }
  const probe = spawnSync(config.python, ["-c", [
    "import json,sys,numpy,sklearn",
    "print(json.dumps(dict(python=list(sys.version_info[:2]),numpy=numpy.__version__,sklearn=sklearn.__version__)))",
  ].join(";")], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (probe.error || probe.status !== 0) {
    throw new Error("ML contract interpreter could not import the pinned numpy/scikit-learn dependencies");
  }
  let versions: Parameters<typeof validateWorkerVersions>[1];
  try {
    versions = JSON.parse(probe.stdout.trim());
  } catch {
    throw new Error("ML contract interpreter returned invalid version metadata");
  }
  validateWorkerVersions(readFileSync(config.requirements, "utf8"), versions);
  return versions;
}

export async function withinWorkerStartupBudget<T>(
  check: () => void,
  start: (remainingMs: number) => Promise<T>,
  budgetMs = 15_000,
) {
  const deadline = Date.now() + budgetMs;
  check();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("ML contract prerequisites exhausted the startup budget");
  return start(remaining);
}

// The real worker main binds port zero; its owned constructor announces the assigned port.
export const WORKER_BOOTSTRAP = [
  "import http.server,json,runpy,sys",
  "server_path,nonce=sys.argv[1:3]",
  "OriginalServer=http.server.ThreadingHTTPServer",
  "class OwnedServer(OriginalServer):",
  "    def __init__(self,*args,**kwargs):",
  "        super().__init__(*args,**kwargs)",
  "        print(json.dumps(dict(nonce=nonce,host=self.server_address[0],port=self.server_address[1])),flush=True)",
  "http.server.ThreadingHTTPServer=OwnedServer",
  "sys.argv=[server_path,'--host','127.0.0.1','--port','0']",
  "runpy.run_path(server_path,run_name='__main__')",
].join("\n");

export function readinessAddress(line: string, nonce: string): string | null {
  try {
    const value = JSON.parse(line);
    if (value.nonce === nonce && value.host === "127.0.0.1"
      && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
      return `http://127.0.0.1:${value.port}`;
    }
  } catch {
    // Other worker output is not proof of an owned listener.
  }
  return null;
}

export async function startOwnedWorker(
  command: string,
  args: (nonce: string) => string[],
  timeoutMs = 15_000,
) {
  const nonce = randomUUID();
  const child = spawn(command, args(nonce), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let ended = false;
  let spawnError: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => { ended = true; resolve(); });
    child.once("error", (error) => { spawnError = error; });
  });
  const stop = async () => {
    if (ended) return;
    child.kill();
    const waitForExit = (ms: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void closed.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (!await waitForExit(2_000)) {
      child.kill("SIGKILL");
      if (!await waitForExit(2_000)) throw new Error("Owned ML contract worker did not exit after termination");
    }
  };
  let pending = "";
  let address: string | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    pending = (pending + chunk.toString("utf8")).slice(-16_384);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) address ??= readinessAddress(line, nonce);
  });
  child.stderr.resume();
  const deadline = Date.now() + timeoutMs;
  try {
    while (!address) {
      if (spawnError || ended) throw new Error("Owned ML contract worker exited before announcing its listener");
      if (Date.now() >= deadline) throw new Error("Owned ML contract worker startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (ended) throw new Error("Owned ML contract worker exited after announcing its listener");
    const response = await fetch(`${address}/health`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if (!response.ok || ended) throw new Error("Owned ML contract worker is not healthy");
    return { base: address, stop, pid: child.pid };
  } catch (error) {
    await stop();
    throw error;
  }
}
