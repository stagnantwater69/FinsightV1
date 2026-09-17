import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The worker's idle poll interval governs how often an otherwise idle replica
 * queries every queue. At 1s that is roughly 518k queries a day per replica,
 * and it used to be a module constant — an operator on a metered hosted
 * database could not back it off without rebuilding the image.
 */

const ORIGINAL = process.env.RECEIPT_WORKER_IDLE_POLL_MS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RECEIPT_WORKER_IDLE_POLL_MS;
  else process.env.RECEIPT_WORKER_IDLE_POLL_MS = ORIGINAL;
  vi.resetModules();
});

async function idlePollFor(raw: string | undefined): Promise<number> {
  if (raw === undefined) delete process.env.RECEIPT_WORKER_IDLE_POLL_MS;
  else process.env.RECEIPT_WORKER_IDLE_POLL_MS = raw;
  vi.resetModules();
  const { env } = await import("../../src/config/env");
  return env.RECEIPT_WORKER_IDLE_POLL_MS;
}

describe("worker idle poll interval", () => {
  it("defaults to one second when the operator has set nothing", async () => {
    await expect(idlePollFor(undefined)).resolves.toBe(1_000);
  });

  it("takes the operator's value", async () => {
    await expect(idlePollFor("5000")).resolves.toBe(5_000);
  });

  it("clamps a value that would busy-spin the loop up to the floor", async () => {
    await expect(idlePollFor("1")).resolves.toBe(250);
    await expect(idlePollFor("-30")).resolves.toBe(1_000);
  });

  it("clamps a value that would leave an upload waiting minutes down to the ceiling", async () => {
    await expect(idlePollFor("600000")).resolves.toBe(60_000);
  });

  it("falls back to the default rather than refusing to boot on a mistyped value", async () => {
    // A tuning knob must not be able to stop the queue consumers from starting.
    await expect(idlePollFor("")).resolves.toBe(1_000);
    await expect(idlePollFor("soon")).resolves.toBe(1_000);
  });

  it("is what the worker loop actually sleeps on", async () => {
    // Read statically: importing worker.ts starts the loop and the boot gate.
    const source = readFileSync(resolve(__dirname, "../../src/worker.ts"), "utf8");
    expect(source).toMatch(/const IDLE_POLL_MS = env\.RECEIPT_WORKER_IDLE_POLL_MS;/);
    expect(source).toMatch(/setTimeout\(\(\) => void runPass\(\), claimed \? 0 : IDLE_POLL_MS\)/);
  });
});
