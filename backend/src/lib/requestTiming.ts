import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../config/logger";

/*
 * Per-request latency breakdown, sent as a `Server-Timing` header so browser
 * DevTools (and `curl -i`) show where a slow request spent its time, and logged
 * when a request is slow enough to matter.
 *
 * Span names are a fixed vocabulary (`auth`, `user`, `ratelimit`, ...), never
 * request data: the header is visible to the client and the log line is kept.
 */

interface TimingStore {
  startedAt: number;
  spans: Map<string, number>;
}

const storage = new AsyncLocalStorage<TimingStore>();

/** Requests slower than this get one structured log line with their spans. */
export const SLOW_REQUEST_MS = 500;

/** Adds `ms` to the named span of the current request. Outside a request it is a no-op. */
export function recordSpan(name: string, ms: number): void {
  const store = storage.getStore();
  if (!store) return;
  store.spans.set(name, (store.spans.get(name) ?? 0) + ms);
}

/** Runs `work` and charges its wall time to `name`, whether it resolves or throws. */
export async function timeSpan<T>(name: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    recordSpan(name, performance.now() - startedAt);
  }
}

function headerValue(store: TimingStore, totalMs: number): string {
  const parts = [...store.spans].map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`);
  parts.push(`total;dur=${totalMs.toFixed(1)}`);
  return parts.join(", ");
}

export function requestTiming(req: Request, res: Response, next: NextFunction): void {
  const store: TimingStore = { startedAt: performance.now(), spans: new Map() };

  // `writeHead` is the last moment a header can still be added, and it runs for
  // every response shape (json, send, end, streamed files).
  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(this: Response, ...args: Parameters<Response["writeHead"]>) {
    // A handler that sets its own Server-Timing (dashboard, insights, CSV
    // import) owns that header's vocabulary, and its tests pin it; the spans
    // here still reach the slow-request log.
    if (!res.headersSent && !res.hasHeader("Server-Timing")) {
      res.setHeader("Server-Timing", headerValue(store, performance.now() - store.startedAt));
    }
    return writeHead.apply(this, args);
  } as Response["writeHead"];

  res.on("finish", () => {
    const totalMs = performance.now() - store.startedAt;
    if (totalMs < SLOW_REQUEST_MS) return;
    logger.info(
      {
        event: "http.slow_request",
        method: req.method,
        // The route pattern, not the URL: ids and query strings stay out of the log.
        route: req.baseUrl + (req.route?.path ?? ""),
        status: res.statusCode,
        totalMs: Math.round(totalMs),
        spans: Object.fromEntries([...store.spans].map(([name, ms]) => [name, Math.round(ms)])),
      },
      "slow request",
    );
  });

  storage.run(store, next);
}
