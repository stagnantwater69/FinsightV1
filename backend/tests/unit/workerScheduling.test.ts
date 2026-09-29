import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(resolve(__dirname, "../../src/worker.ts"), "utf8");

describe("worker queue scheduling", () => {
  it("keeps purge and deletion work in the maintenance lane", () => {
    expect(workerSource).toContain('runMaintenanceJob("receipt-purge", runReceiptPurgeWorkerOnce)');
    expect(workerSource).toContain('runMaintenanceJob("csv-source-purge", runCsvSourcePurgeWorkerOnce)');
    expect(workerSource).toContain('runMaintenanceJob("account-deletion", runAccountDeletionWorkerOnce)');
  });

  it("runs one account deletion stage per queue pass", () => {
    expect(workerSource.match(/runMaintenanceJob\("account-deletion", runAccountDeletionWorkerOnce\)/g)).toHaveLength(1);
    expect(workerSource).not.toMatch(/for\s*\([^)]*runAccountDeletionWorkerOnce/);
  });

  it("starts recurring work only for its semantic lane", () => {
    expect(workerSource).toContain('hasWorkerLane(SELECTED_LANES, "csv")');
    expect(workerSource).toContain('hasWorkerLane(SELECTED_LANES, "analysis")');
    expect(workerSource).toContain('hasWorkerLane(SELECTED_LANES, "maintenance")');
    expect(workerSource.match(/hasWorkerLane\(SELECTED_LANES, "receipt"\)/g)).toHaveLength(2);
  });
});
