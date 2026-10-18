import { describe, expect, it } from "vitest";
import { checkQueues, describeMigrationDrift, developmentTargets, type Readiness } from "../../scripts/doctor";
import type { MigrationDrift } from "../../src/config/migrationGuard";

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

describe("doctor: migration line", () => {
  const clean: MigrationDrift = { status: "ok", pending: [], failed: [], checksumMismatches: [], schemaIssues: [] };

  it("passes only on the startup gate's own ok", () => {
    expect(describeMigrationDrift(clean).state).toBe("OK");
  });

  it("fails on a changed checksum, which a count of applied rows cannot see", () => {
    const check = describeMigrationDrift({
      ...clean,
      status: "drift",
      checksumMismatches: [{ migration: "20261011154302_manual_record_create_retry_protection", expectedChecksum: "a", actualChecksum: "b" }],
    });

    expect(check.state).toBe("FAIL");
    expect(check.summary).toBe("1 changed since applied");
    expect(check.hint).toContain("20261011154302_manual_record_create_retry_protection");
  });

  it("fails on a missing security control with every migration applied", () => {
    const check = describeMigrationDrift({ ...clean, status: "drift", schemaIssues: ["security.chat_send_request_rls"] });

    expect(check.state).toBe("FAIL");
    expect(check.hint).toContain("security.chat_send_request_rls");
  });

  it("warns rather than passing when the gate could not reach a verdict", () => {
    const check = describeMigrationDrift({ status: "unknown", pending: [], failed: [], verificationFailure: "schema_shape_unverifiable" });

    expect(check.state).toBe("WARN");
    expect(check.summary).toContain("schema_shape_unverifiable");
  });
});

describe("doctor: mobile target", () => {
  it("follows this machine's LAN address, as a dev build does, keeping port and path", () => {
    expect(developmentTargets("http://192.168.1.20:4000/api/v1", ["192.168.1.57", "8.8.8.8"]))
      .toEqual(["http://192.168.1.57:4000/api/v1"]);
  });

  it("follows from a loopback configuration too", () => {
    expect(developmentTargets("http://localhost:4000/api/v1", ["100.101.1.2"])).toEqual(["http://100.101.1.2:4000/api/v1"]);
  });

  it("leaves an HTTPS or public address alone, as the app does", () => {
    expect(developmentTargets("https://api.example.com/api/v1", ["192.168.1.57"])).toEqual([]);
    expect(developmentTargets("http://203.0.113.5:4000/api/v1", ["192.168.1.57"])).toEqual([]);
  });
});
