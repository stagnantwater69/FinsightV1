import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { registerProcessFaultHandlers, type FaultProcess } from "../../src/lib/processFaults";

/*
 * Before this, a rejection outside an asyncHandler killed the process with a
 * bare stderr stack — outside pino, so outside the aggregator, with no drain.
 */

function harness() {
  const emitter = new EventEmitter();
  const fatal = vi.fn();
  const onFatal = vi.fn();
  registerProcessFaultHandlers({
    process: emitter as unknown as FaultProcess,
    logger: { fatal },
    onFatal,
  });
  return { emitter, fatal, onFatal };
}

describe("process fault handlers", () => {
  it("logs an unhandled rejection through the logger and drains", () => {
    const { emitter, fatal, onFatal } = harness();
    const reason = new Error("nobody awaited this");

    emitter.emit("unhandledRejection", reason);

    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0]![0]).toMatchObject({ err: reason, fault: "unhandledRejection" });
    expect(onFatal).toHaveBeenCalledWith("unhandledRejection", reason);
  });

  it("logs an uncaught exception through the logger and drains", () => {
    const { emitter, fatal, onFatal } = harness();
    const error = new Error("threw off a timer callback");

    emitter.emit("uncaughtException", error);

    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0]![0]).toMatchObject({ err: error, fault: "uncaughtException" });
    expect(onFatal).toHaveBeenCalledWith("uncaughtException", error);
  });

  it("carries a non-Error rejection reason to the log without throwing", () => {
    const { emitter, fatal, onFatal } = harness();

    emitter.emit("unhandledRejection", "a bare string");

    expect(fatal.mock.calls[0]![0]).toMatchObject({ err: "a bare string" });
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("drains once — a second fault mid-drain is logged, not re-entered", () => {
    const { emitter, fatal, onFatal } = harness();

    emitter.emit("uncaughtException", new Error("first"));
    emitter.emit("unhandledRejection", new Error("second"));
    emitter.emit("uncaughtException", new Error("third"));

    expect(fatal).toHaveBeenCalledTimes(3);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("is registered by both entrypoints, and exits non-zero on a fault", () => {
    // Importing either entrypoint opens a port or starts the queue loop, so
    // the registration itself is asserted statically.
    for (const file of ["../../src/server.ts", "../../src/worker.ts"]) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect(source).toMatch(/registerProcessFaultHandlers\(\{/);
      // Routed through the existing graceful shutdown, not a bare exit.
      expect(source).toMatch(/exitCode = 1;\s*\n\s*void shutdown\(kind\);/);
      expect(source).not.toMatch(/process\.exit\(0\)/);
    }
  });
});
