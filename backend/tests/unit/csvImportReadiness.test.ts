import { describe, expect, it } from "vitest";
import { assessCsvHealth, type CsvReadinessThresholds } from "../../scripts/csv-import-readiness";

const thresholds: CsvReadinessThresholds = {
  queueWaitSeconds: 600,
  processingAgeSeconds: 1_800,
  purgeAgeSeconds: 600,
  stageAgeSeconds: 90_000,
};

const healthy = {
  status: "ready",
  database: "ok",
  pendingCsvImports: 0,
  oldestPendingCsvImportAgeSeconds: null,
  processingCsvImports: 0,
  oldestProcessingCsvImportAgeSeconds: null,
  queuedCsvSourcePurges: 0,
  oldestQueuedCsvSourcePurgeAgeSeconds: null,
  failedCsvSourcePurges: 0,
  stagedCsvUploads: 0,
  oldestStagedCsvUploadAgeSeconds: null,
};

describe("CSV import readiness", () => {
  it("reports only aggregate metrics and no alert for an idle queue", () => {
    const result = assessCsvHealth({ ...healthy, fileReference: "private/object.csv" }, thresholds);
    expect(result).toEqual({
      check: "csv-import-readiness",
      status: "ok",
      alerts: [],
      pendingCsvImports: 0,
      oldestPendingCsvImportAgeSeconds: null,
      processingCsvImports: 0,
      oldestProcessingCsvImportAgeSeconds: null,
      queuedCsvSourcePurges: 0,
      oldestQueuedCsvSourcePurgeAgeSeconds: null,
      failedCsvSourcePurges: 0,
      stagedCsvUploads: 0,
      oldestStagedCsvUploadAgeSeconds: null,
    });
    expect(JSON.stringify(result)).not.toContain("private/object.csv");
  });

  it("flags stalled import, purge, expired stage, and terminal purge failure", () => {
    const result = assessCsvHealth({
      ...healthy,
      pendingCsvImports: 2,
      oldestPendingCsvImportAgeSeconds: 601,
      processingCsvImports: 1,
      oldestProcessingCsvImportAgeSeconds: 1_801,
      queuedCsvSourcePurges: 1,
      oldestQueuedCsvSourcePurgeAgeSeconds: 601,
      failedCsvSourcePurges: 1,
      stagedCsvUploads: 3,
      oldestStagedCsvUploadAgeSeconds: 90_001,
    }, thresholds);
    expect(result.status).toBe("attention");
    expect(result.alerts).toEqual([
      "CSV_QUEUE_WAIT", "CSV_PROCESSING_AGE", "CSV_PURGE_AGE", "CSV_PURGE_FAILED", "CSV_STAGE_AGE",
    ]);
  });

  it("rejects a public health response with no protected detail", () => {
    expect(() => assessCsvHealth({ status: "ready", database: "ok" }, thresholds)).toThrow("HEALTH_DETAIL_MISSING");
  });

  it("rejects malformed or unavailable health data", () => {
    expect(() => assessCsvHealth({ ...healthy, pendingCsvImports: -1 }, thresholds)).toThrow("HEALTH_DETAIL_MISSING");
    expect(() => assessCsvHealth({ ...healthy, database: "unavailable" }, thresholds)).toThrow("HEALTH_NOT_READY");
  });
});
