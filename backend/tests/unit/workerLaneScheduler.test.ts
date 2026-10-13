import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerLaneScheduler } from "../../src/lib/workerLaneScheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("worker lane scheduler", () => {
  it("keeps polling an idle lane while another lane is still busy", async () => {
    vi.useFakeTimers();
    let finishReceipt: ((claimed: boolean) => void) | undefined;
    const receiptPass = new Promise<boolean>((resolve) => {
      finishReceipt = resolve;
    });
    const calls: string[] = [];
    const scheduler = createWorkerLaneScheduler({
      lanes: ["receipt", "csv"] as const,
      idlePollMs: 1_000,
      runLane: async (lane) => {
        calls.push(lane);
        if (lane === "receipt") return receiptPass;
        return false;
      },
      onError: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls.filter((lane) => lane === "receipt")).toHaveLength(1);
    expect(calls.filter((lane) => lane === "csv")).toHaveLength(2);
    expect(scheduler.busyLanes()).toEqual(["receipt"]);

    finishReceipt?.(false);
    await Promise.resolve();
    scheduler.stop();
  });

  it("re-polls only the lane that claimed work without an idle delay", async () => {
    vi.useFakeTimers();
    const passes = new Map([
      ["receipt", 0],
      ["analysis", 0],
    ]);
    const scheduler = createWorkerLaneScheduler({
      lanes: ["receipt", "analysis"] as const,
      idlePollMs: 5_000,
      runLane: async (lane) => {
        const pass = (passes.get(lane) ?? 0) + 1;
        passes.set(lane, pass);
        return lane === "receipt" && pass === 1;
      },
      onError: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(passes.get("receipt")).toBe(2);
    expect(passes.get("analysis")).toBe(1);
    scheduler.stop();
  });

  it("stops new passes but leaves an active pass visible for graceful drain", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const activePass = new Promise<boolean>((resolve) => {
      finish = () => resolve(false);
    });
    const runLane = vi.fn(() => activePass);
    const scheduler = createWorkerLaneScheduler({
      lanes: ["maintenance"] as const,
      idlePollMs: 250,
      runLane,
      onError: vi.fn(),
    });

    scheduler.start();
    scheduler.stop();
    expect(scheduler.isBusy()).toBe(true);

    finish?.();
    await Promise.resolve();
    expect(scheduler.isBusy()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runLane).toHaveBeenCalledTimes(1);
  });
});
