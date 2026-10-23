import { performance } from "node:perf_hooks";

/**
 * One clock per processing attempt, so a retry never adds to an earlier attempt's
 * figures; within an attempt the first measurement of a stage stands.
 */
export type ReceiptScanStage = "restore" | "ocr" | "provider" | "finalize" | "persist";

export type ReceiptScanOutcome = "complete" | "retrying" | "waiting-for-provider" | "failed" | "lease-lost";

export interface ReceiptScanTimings {
  attempt: number;
  /** Eligible to run until claimed by this attempt. */
  queueWaitMs: number | null;
  /** Re-checking the stored evidence after the claim. */
  restoreMs: number | null;
  ocrMs: number | null;
  /** Wall time in the provider gate on this attempt; a replayed outcome costs only the lookup. */
  providerMs: number | null;
  /** Merge, history snap, evidence and warnings, up to the persistence transaction. */
  finalizeMs: number | null;
  persistMs: number | null;
  /** Claim to the moment the figures were read. */
  totalMs: number;
}

/** What the scan row keeps: written inside the result transaction, so persist and total cannot be known yet. */
export type StoredReceiptScanTimings = Omit<ReceiptScanTimings, "persistMs" | "totalMs">;

export interface ReceiptScanClock {
  /** Starts a stage and returns its stop function; stopping twice records once. */
  start(stage: ReceiptScanStage): () => void;
  /** Times `run`, including when it throws. */
  measure<T>(stage: ReceiptScanStage, run: () => Promise<T>): Promise<T>;
  snapshot(): ReceiptScanTimings;
  stored(): StoredReceiptScanTimings;
}

function elapsed(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

export function createReceiptScanClock(options: {
  attempt: number;
  queueWaitMs: number | null;
  now?: () => number;
  claimedAt?: number;
}): ReceiptScanClock {
  const now = options.now ?? (() => performance.now());
  const claimedAt = options.claimedAt ?? now();
  const durations = new Map<ReceiptScanStage, number>();

  const start = (stage: ReceiptScanStage) => {
    const startedAt = now();
    return () => {
      if (!durations.has(stage)) durations.set(stage, elapsed(startedAt, now()));
    };
  };

  const stored = (): StoredReceiptScanTimings => ({
    attempt: options.attempt,
    queueWaitMs: options.queueWaitMs,
    restoreMs: durations.get("restore") ?? null,
    ocrMs: durations.get("ocr") ?? null,
    providerMs: durations.get("provider") ?? null,
    finalizeMs: durations.get("finalize") ?? null,
  });

  return {
    start,
    async measure(stage, run) {
      const stop = start(stage);
      try {
        return await run();
      } finally {
        stop();
      }
    },
    snapshot: () => ({
      ...stored(),
      persistMs: durations.get("persist") ?? null,
      totalMs: elapsed(claimedAt, now()),
    }),
    stored,
  };
}

/**
 * Measured from `nextProcessingAttemptAt` (set by upload, owner retry and failure
 * backoff), so a retry delay is not queueing; a stale lease counts from its expiry.
 */
export function receiptQueueWaitMs(
  claimedAt: Date,
  row: { nextProcessingAttemptAt: Date; processingWorkerId: string | null; processingHeartbeatAt: Date | null },
  leaseMs: number,
): number {
  const scheduledAt = row.nextProcessingAttemptAt.getTime();
  const eligibleAt = row.processingWorkerId !== null && row.processingHeartbeatAt !== null
    ? Math.max(scheduledAt, row.processingHeartbeatAt.getTime() + leaseMs)
    : scheduledAt;
  return Math.max(0, claimedAt.getTime() - eligibleAt);
}
