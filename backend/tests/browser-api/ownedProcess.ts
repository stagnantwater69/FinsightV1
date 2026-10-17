import { execFileSync, spawn } from "node:child_process";

export async function runOwnedProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; graceMs?: number;
}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  let ended = false;
  let spawnError: Error | undefined;
  const capture = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-65_536); };
  child.stdout!.on("data", capture); child.stderr!.on("data", capture);
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => { ended = true; resolve(code); });
  });
  const wait = (ms: number) => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void closed.then(() => { clearTimeout(timer); resolve(true); });
  });
  const timedOut = !await wait(options.timeoutMs);
  if (timedOut && !ended) {
    if (child.connected) child.send({ finsightFixtureShutdown: true }, () => {});
    if (!await wait(options.graceMs ?? 2_000) && child.pid) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
        } else { process.kill(-child.pid, "SIGKILL"); }
      } catch (error) { if (!ended) throw error; }
      if (!await wait(2_000)) throw new Error("Owned browser process tree did not terminate");
      // The group leader closing does not mean its descendants are reaped yet.
      if (process.platform !== "win32" && !await groupGone(child.pid, 2_000)) {
        throw new Error("Owned browser process tree did not terminate");
      }
    }
  }
  const exit = await closed;
  if (spawnError) throw spawnError;
  return { exit, output, timedOut };
}

async function groupGone(pgid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(-pgid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function cleanOwnedResources(steps: (() => Promise<unknown>)[]) {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Owned fixture cleanup failed");
}
