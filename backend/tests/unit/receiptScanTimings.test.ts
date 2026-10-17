import { describe, expect, it } from "vitest";
import { createReceiptScanClock, receiptQueueWaitMs } from "../../src/services/receiptScan/scanTimings";

function manualClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("receipt scan stage clock", () => {
  it("records each stage and the total from the claim", async () => {
    const time = manualClock();
    const clock = createReceiptScanClock({ attempt: 1, queueWaitMs: 4_000, now: time.now, claimedAt: time.now() });

    time.advance(5);
    await clock.measure("restore", async () => time.advance(40));
    await clock.measure("ocr", async () => time.advance(2_300.4));
    await clock.measure("provider", async () => time.advance(1_800));
    const stopFinalize = clock.start("finalize");
    time.advance(120);
    stopFinalize();
    await clock.measure("persist", async () => time.advance(260));

    expect(clock.snapshot()).toEqual({
      attempt: 1,
      queueWaitMs: 4_000,
      restoreMs: 40,
      ocrMs: 2_300,
      providerMs: 1_800,
      finalizeMs: 120,
      persistMs: 260,
      totalMs: 4_525,
    });
  });

  it("stores only what is known before the persistence transaction", async () => {
    const time = manualClock();
    const clock = createReceiptScanClock({ attempt: 2, queueWaitMs: 0, now: time.now });
    await clock.measure("ocr", async () => time.advance(10));

    expect(clock.stored()).toEqual({
      attempt: 2,
      queueWaitMs: 0,
      restoreMs: null,
      ocrMs: 10,
      providerMs: null,
      finalizeMs: null,
    });
    expect(clock.stored()).not.toHaveProperty("persistMs");
    expect(clock.stored()).not.toHaveProperty("totalMs");
  });

  it("times a stage that throws and still rethrows", async () => {
    const time = manualClock();
    const clock = createReceiptScanClock({ attempt: 1, queueWaitMs: null, now: time.now });

    await expect(clock.measure("ocr", async () => {
      time.advance(75);
      throw new Error("tesseract thread died");
    })).rejects.toThrow("tesseract thread died");

    expect(clock.snapshot()).toMatchObject({ ocrMs: 75, providerMs: null, finalizeMs: null, persistMs: null });
  });

  it("keeps the first measurement of a stage instead of summing a repeat", async () => {
    const time = manualClock();
    const clock = createReceiptScanClock({ attempt: 1, queueWaitMs: null, now: time.now });

    const stop = clock.start("finalize");
    time.advance(30);
    stop();
    time.advance(500);
    stop();
    await clock.measure("finalize", async () => time.advance(900));

    expect(clock.snapshot().finalizeMs).toBe(30);
  });

  it("starts every attempt from zero, so a retry never inherits the earlier attempt's figures", async () => {
    const time = manualClock();
    const first = createReceiptScanClock({ attempt: 1, queueWaitMs: 100, now: time.now, claimedAt: time.now() });
    await first.measure("ocr", async () => time.advance(3_000));

    const second = createReceiptScanClock({ attempt: 2, queueWaitMs: 50, now: time.now, claimedAt: time.now() });
    await second.measure("ocr", async () => time.advance(200));

    expect(first.snapshot()).toMatchObject({ attempt: 1, ocrMs: 3_000, totalMs: 3_200 });
    expect(second.snapshot()).toMatchObject({ attempt: 2, queueWaitMs: 50, ocrMs: 200, totalMs: 200 });
  });

  it("never reports a negative duration when the clock steps backwards", async () => {
    const time = manualClock();
    const clock = createReceiptScanClock({ attempt: 1, queueWaitMs: null, now: time.now, claimedAt: time.now() });
    await clock.measure("ocr", async () => time.advance(-50));

    expect(clock.snapshot()).toMatchObject({ ocrMs: 0, totalMs: 0 });
  });
});

describe("receipt queue wait", () => {
  const leaseMs = 120_000;
  const claimedAt = new Date("2026-10-17T10:00:10.000Z");

  it("measures from upload or owner retry, both of which set nextProcessingAttemptAt to now", () => {
    expect(receiptQueueWaitMs(claimedAt, {
      nextProcessingAttemptAt: new Date("2026-10-17T10:00:04.000Z"),
      processingWorkerId: null,
      processingHeartbeatAt: null,
    }, leaseMs)).toBe(6_000);
  });

  it("does not count the failure backoff as queueing", () => {
    // recordProcessingFailure pushes nextProcessingAttemptAt past the retry delay.
    expect(receiptQueueWaitMs(claimedAt, {
      nextProcessingAttemptAt: new Date("2026-10-17T10:00:09.250Z"),
      processingWorkerId: null,
      processingHeartbeatAt: null,
    }, leaseMs)).toBe(750);
  });

  it("measures a reclaimed stale lease from when that lease expired, not from the original upload", () => {
    expect(receiptQueueWaitMs(claimedAt, {
      nextProcessingAttemptAt: new Date("2026-10-17T09:50:00.000Z"),
      processingWorkerId: "dead-worker",
      processingHeartbeatAt: new Date("2026-10-17T09:58:08.000Z"),
    }, leaseMs)).toBe(2_000);
  });

  it("treats a lease with no heartbeat as claimable from its schedule", () => {
    expect(receiptQueueWaitMs(claimedAt, {
      nextProcessingAttemptAt: new Date("2026-10-17T10:00:00.000Z"),
      processingWorkerId: "worker-without-heartbeat",
      processingHeartbeatAt: null,
    }, leaseMs)).toBe(10_000);
  });

  it("clamps to zero when the schedule is ahead of the claiming clock", () => {
    expect(receiptQueueWaitMs(claimedAt, {
      nextProcessingAttemptAt: new Date("2026-10-17T10:00:11.000Z"),
      processingWorkerId: null,
      processingHeartbeatAt: null,
    }, leaseMs)).toBe(0);
  });
});
