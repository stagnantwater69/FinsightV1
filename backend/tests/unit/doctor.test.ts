import { describe, expect, it } from "vitest";
import { checkQueues, type Readiness } from "../../scripts/doctor";

/*
 * The queue line is the one that catches a stopped worker, which is the
 * failure this project keeps hitting: work sits, nothing consumes it, and
 * nothing says so. A worker that is running claims within a second or two, so
 * age is the signal — not depth, which is zero either way once it has caught
 * up.
 */
describe("doctor: queue line", () => {
  const idle: Readiness = {
    queuedReceiptScans: 0,
    queuedCsvImports: 0,
    queuedCsvSourcePurges: 0,
    queuedAnalysisJobs: 0,
  };

  it("fails and names the worker when a receipt has waited past a claim interval", () => {
    const check = checkQueues({ ...idle, queuedReceiptScans: 3, oldestQueuedReceiptScanAgeSeconds: 900 });
    expect(check.state).toBe("FAIL");
    expect(check.summary).toContain("900s");
    expect(check.hint).toMatch(/worker:dev/);
  });

  it("stays OK while work is moving", () => {
    expect(checkQueues({ ...idle, queuedReceiptScans: 2, oldestQueuedReceiptScanAgeSeconds: 3 }).state).toBe("OK");
    expect(checkQueues(idle).state).toBe("OK");
  });

  it("warns about a stalled account deletion, which nothing else surfaces", () => {
    const check = checkQueues({ ...idle, stalledAccountDeletions: 2 });
    expect(check.state).toBe("WARN");
    expect(check.summary).toContain("2 stalled");
  });

  it("fails when CSV source cleanup has stopped moving", () => {
    const check = checkQueues({ ...idle, queuedCsvSourcePurges: 1, oldestQueuedCsvSourcePurgeAgeSeconds: 61 });
    expect(check.state).toBe("FAIL");
    expect(check.summary).toContain("oldest CSV purge waiting 61s");
  });

  it("warns when a CSV path remains after cleanup exhausts its retries", () => {
    const check = checkQueues({ ...idle, failedCsvSourcePurges: 1 });
    expect(check.state).toBe("WARN");
    expect(check.summary).toContain("1 failed CSV purge");
  });

  it("skips rather than guessing when the API is down or withholding detail", () => {
    expect(checkQueues(null).state).toBe("SKIP");
    // 200 from the API, but queue detail gated behind the health token.
    const withheld = checkQueues({ status: "ready" });
    expect(withheld.state).toBe("SKIP");
    expect(withheld.hint).toMatch(/HEALTH_DETAIL_TOKEN/);
  });
});
