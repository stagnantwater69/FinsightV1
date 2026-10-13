import { describe, expect, it } from "vitest";
import { retryAlreadyUnderway, retryLandingUnknown } from "../src/screens/records/scanReceipt/retryConflict";

/**
 * The 409 body POST /records/receipts/:id/retry sends when the scan is
 * already Processing. `code` sits both on the ApiError and on the parsed
 * body, and the state fields are flat, not nested under `details`.
 */
function conflict(body: Record<string, unknown> = {}) {
  const responseBody = {
    error: "This receipt is already being read.",
    code: "RECEIPT_RETRY_IN_PROGRESS",
    scanId: 83,
    processingStatus: "Processing",
    scanRevision: 4,
    ...body,
  };
  return { status: 409, code: responseBody.code, responseBody };
}

describe("a retry the server says is already underway", () => {
  it("reports the server's state so the client can resume polling", () => {
    expect(retryAlreadyUnderway(conflict(), 83)).toEqual({
      scanId: 83,
      processingStatus: "Processing",
      scanRevision: 4,
    });
  });

  it("reads the code off the body when the transport did not lift it out", () => {
    const { responseBody } = conflict();
    expect(retryAlreadyUnderway({ status: 409, responseBody }, 83)).not.toBeNull();
  });

  it("accepts revision zero, which a never-edited scan has", () => {
    expect(retryAlreadyUnderway(conflict({ scanRevision: 0 }), 83)?.scanRevision).toBe(0);
  });
});

describe("a 409 that cannot be trusted is not treated as underway", () => {
  it.each([
    ["a conflict naming a different scan", conflict({ scanId: 84 }), 83],
    ["a conflict this client asked nothing about", conflict(), 99],
    ["a status the server reports as something other than Processing", conflict({ processingStatus: "Failed" }), 83],
    ["a missing revision", conflict({ scanRevision: undefined }), 83],
    ["a revision sent as text", conflict({ scanRevision: "4" }), 83],
    ["the older 409 that carries no code", { status: 409, responseBody: { error: "Only an unconfirmed failed receipt scan can be retried" } }, 83],
    ["a batch conflict", { status: 409, responseBody: { error: "This receipt batch is no longer available" } }, 83],
    ["a request that never reached the server", { status: 0, responseBody: undefined }, 83],
    ["a 404", { status: 404, code: "RECEIPT_RETRY_IN_PROGRESS", responseBody: { code: "RECEIPT_RETRY_IN_PROGRESS", scanId: 83, processingStatus: "Processing", scanRevision: 4 } }, 83],
    ["something that is not an error object at all", "boom", 83],
    ["null", null, 83],
  ])("returns null for %s", (_case, err, expectedId) => {
    expect(retryAlreadyUnderway(err, expectedId)).toBeNull();
  });
});

describe("what is still genuinely unknown after a failed retry", () => {
  it("keeps a transport failure and an unreadable 409 unknown", () => {
    // /retry has no idempotency key by design, so neither can be settled.
    expect(retryLandingUnknown(0)).toBe(true);
    expect(retryLandingUnknown(409)).toBe(true);
  });

  it("does not treat an answered failure as unknown", () => {
    expect(retryLandingUnknown(404)).toBe(false);
    expect(retryLandingUnknown(500)).toBe(false);
    expect(retryLandingUnknown(null)).toBe(false);
  });
});
