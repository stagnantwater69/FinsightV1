import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const backendRoot = resolve(__dirname, "../..");
const runner = join(backendRoot, "tests/load/run-stage.sh");
const resultRoot = join(backendRoot, "tests/load/results");
const temporaryPaths: string[] = [];
const stageNames: string[] = [];

function executable(path: string, body: string) {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function makeHarness(exitCode: number, delaySeconds = "0.1", longRunning = false) {
  const root = mkdtempSync(join(tmpdir(), "finsight-load-stage-"));
  temporaryPaths.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const samplerPidFile = join(root, "sampler.pid");
  const k6PidFile = join(root, "k6.pid");

  executable(
    join(bin, "k6"),
    `#!/usr/bin/env bash
${longRunning ? "sleep 0.05\n" : ""}printf '%s\n' "$$" > "$K6_PID_FILE"
${longRunning ? `exec sleep "${delaySeconds}"` : `sleep "${delaySeconds}"\nexit "${exitCode}"`}
`,
  );
  executable(
    join(bin, "pgrep"),
    `#!/usr/bin/env bash
exit 1
`,
  );
  executable(
    join(bin, "docker"),
    `#!/usr/bin/env bash
if [ "$1" = "stats" ]; then
  printf '0%% 0MiB / 0MiB\n'
else
  printf '0\n'
fi
`,
  );

  return {
    env: {
      ...process.env,
      K6: join(bin, "k6"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      LOAD_TEST_SAMPLER_PID_FILE: samplerPidFile,
      K6_PID_FILE: k6PidFile,
    },
    samplerPidFile,
    k6PidFile,
  };
}

function uniqueStage(label: string) {
  const name = `unit-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  stageNames.push(name);
  return name;
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const name of stageNames.splice(0)) rmSync(join(resultRoot, name), { recursive: true, force: true });
});

describe("load stage runner", () => {
  for (const exitCode of [0, 1, 99]) {
    it(`returns k6 exit code ${exitCode} and stops its sampler`, () => {
      const harness = makeHarness(exitCode);
      const result = spawnSync("bash", [runner, uniqueStage(String(exitCode)), "1", "1s", "1s"], {
        cwd: backendRoot,
        env: harness.env,
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exitCode);
      const samplerPid = Number(readFileSync(harness.samplerPidFile, "utf8").trim());
      expect(samplerPid).toBeGreaterThan(0);
      expect(processExists(samplerPid)).toBe(false);
    });
  }

  it("forwards TERM to k6, stops its sampler, and exits promptly", async () => {
    const harness = makeHarness(0, "30", true);
    const child = spawn("bash", [runner, uniqueStage("term"), "1", "1s", "1s"], {
      cwd: backendRoot,
      env: harness.env,
      stdio: "ignore",
    });

    await new Promise<void>((resolvePromise, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = () => {
        try {
          readFileSync(harness.samplerPidFile);
          readFileSync(harness.k6PidFile);
          resolvePromise();
        } catch {
          if (Date.now() >= deadline) reject(new Error("runner children did not start"));
          else setTimeout(poll, 10);
        }
      };
      poll();
    });

    const samplerPid = Number(readFileSync(harness.samplerPidFile, "utf8").trim());
    const k6Pid = Number(readFileSync(harness.k6PidFile, "utf8").trim());
    expect(samplerPid).not.toBe(k6Pid);
    const started = Date.now();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    child.kill("SIGTERM");

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      exited,
      new Promise<never>((_resolvePromise, reject) => {
        timeout = setTimeout(() => {
          for (const pid of [k6Pid, samplerPid, child.pid]) {
            if (pid) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // The process may have exited between the deadline and cleanup.
              }
            }
          }
          reject(new Error("runner did not stop promptly after TERM"));
        }, 2_000);
      }),
    ]).finally(() => clearTimeout(timeout));

    expect(result).toEqual({ code: 143, signal: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(processExists(k6Pid)).toBe(false);
    expect(processExists(samplerPid)).toBe(false);
  });
});
