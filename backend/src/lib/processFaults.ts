/*
 * The two faults Node hands to the process rather than to a caller.
 *
 * Everything inside a request already lands in error.middleware via
 * asyncHandler, and every queue pass wraps its own work in try/catch. What is
 * left over is the promise nobody awaited and the throw off an event emitter
 * or a timer callback. Unhandled, Node prints a bare stack to stderr and
 * exits: outside pino, so outside the log aggregator, with no request id, no
 * job id and no chance for the process to close its listener or finish the
 * pass it was in the middle of.
 *
 * Registering these does NOT make the process keep running. An uncaught
 * exception leaves state the code cannot reason about — a half-applied
 * transaction, a lease held by a stack frame that no longer exists — so both
 * entrypoints still exit, and non-zero so the supervisor restarts them. What
 * is bought here is one structured log line and one trip through the
 * entrypoint's existing drain.
 */
import type { Logger } from "pino";

export type ProcessFaultKind = "unhandledRejection" | "uncaughtException";

/** The slice of `process` this needs — so a test can pass an emitter instead. */
export interface FaultProcess {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
}

export interface ProcessFaultOptions {
  process: FaultProcess;
  logger: Pick<Logger, "fatal">;
  /**
   * The entrypoint's own graceful shutdown. Called at most once: a second
   * fault arriving mid-drain is logged and dropped, because re-entering a
   * drain that is already waiting on an in-flight job is how a shutdown
   * deadlocks instead of finishing.
   */
  onFatal: (kind: ProcessFaultKind, error: unknown) => void;
}

export function registerProcessFaultHandlers({ process: proc, logger, onFatal }: ProcessFaultOptions): void {
  let drained = false;

  const handle = (kind: ProcessFaultKind, error: unknown): void => {
    // `err` is pino's serialiser key, and the redaction paths in config/logger
    // (err.body, err.raw) only apply under it.
    logger.fatal({ err: error, fault: kind }, `unhandled ${kind}; shutting down`);
    if (drained) return;
    drained = true;
    onFatal(kind, error);
  };

  proc.on("unhandledRejection", (reason: unknown) => handle("unhandledRejection", reason));
  proc.on("uncaughtException", (error: Error) => handle("uncaughtException", error));
}
