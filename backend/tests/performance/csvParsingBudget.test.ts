import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS, previewCsv } from "../../src/services/csvImport.service";

describe("CSV parser regression budget", () => {
  it("parses the maximum accepted synthetic row count within the local budget", () => {
    const lines = ["Date,Description,Amount,Category"];
    for (let index = 0; index < MAX_IMPORT_ROWS; index += 1) {
      lines.push(`2026-09-29,Item ${index},${100 + (index % 100)},Inventory`);
    }
    const buffer = Buffer.from(lines.join("\n"));

    const startedAt = performance.now();
    const result = previewCsv(buffer);
    const elapsedMs = performance.now() - startedAt;

    expect(result.totalRows).toBe(MAX_IMPORT_ROWS);
    expect(result.previewRows).toHaveLength(50);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
