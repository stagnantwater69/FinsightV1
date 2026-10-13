/**
 * Reading the server's answer to a retry that was already running.
 *
 * POST /records/receipts/:id/retry answers 409 with
 * `code: "RECEIPT_RETRY_IN_PROGRESS"` when the scan is Processing and still
 * Pending — which covers both the retry whose response the client never
 * received and the retry that lost a race to a concurrent one. In both cases
 * the work IS underway, so the honest response is to resume polling rather
 * than to tell the owner their retry failed.
 *
 * The 409 carries the authoritative state (`scanId`, `processingStatus`,
 * `scanRevision`) flat on the body. That state-reporting response is the
 * contract; there is deliberately no idempotency key on this endpoint.
 */

/** The scan state the server reported alongside its 409. */
export interface RetryUnderway {
  scanId: number;
  processingStatus: "Processing";
  scanRevision: number;
}

/**
 * The reported state when `err` is that 409 for `expectedScanId`, else null.
 *
 * Null for a 409 whose body does not verify, including one naming a different
 * scan: a client that cannot confirm what the server did must fall back to
 * treating the outcome as unknown, not to trusting a mismatched payload.
 */
export function retryAlreadyUnderway(err: unknown, expectedScanId: number): RetryUnderway | null {
  if (typeof err !== "object" || err === null) return null;
  const { status, code, responseBody } = err as { status?: unknown; code?: unknown; responseBody?: unknown };
  if (status !== 409) return null;
  const body = (typeof responseBody === "object" && responseBody !== null ? responseBody : {}) as Record<string, unknown>;
  if (code !== "RECEIPT_RETRY_IN_PROGRESS" && body.code !== "RECEIPT_RETRY_IN_PROGRESS") return null;
  if (body.scanId !== expectedScanId) return null;
  if (body.processingStatus !== "Processing") return null;
  if (!Number.isInteger(body.scanRevision) || Number(body.scanRevision) < 0) return null;
  return { scanId: expectedScanId, processingStatus: "Processing", scanRevision: Number(body.scanRevision) };
}

/**
 * Whether a failed retry might still have reached the server.
 *
 * Narrower than it was. A 409 carrying RECEIPT_RETRY_IN_PROGRESS never gets
 * here — `retryAlreadyUnderway` resolves it into "underway, keep polling" —
 * so what is left is a request that failed in transit (status 0) and a 409
 * this client cannot read, which includes whatever a server build older than
 * the code sends back. Both are genuinely unknown, and there is no
 * idempotency key on /retry to settle them, so the scan keeps its Review
 * result action instead of inviting a second retry that may double the work.
 */
export function retryLandingUnknown(status: number | null): boolean {
  return status === 0 || status === 409;
}
