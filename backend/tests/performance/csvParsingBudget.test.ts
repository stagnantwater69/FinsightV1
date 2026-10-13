import { describe, expect, it } from "vitest";
import { previewCsv } from "../../src/services/csvImport.service";
import { CSV_MAX_FILE_BYTES } from "../../src/lib/csvUploadValidation";

describe("CSV parser regression budget", () => {
  /*
   * There is no row limit, so the worst case is the most rows 5 MB can hold:
   * the shortest usable row, repeated to the size cap (~350,000 rows). Measured
   * at ~1.4s locally; the budget leaves room for a slower CI machine.
   */
  it("parses the largest-row-count 5 MB file within the local budget", () => {
    const header = "Date,Description,Amount";
    const row = "2026-09-29,a,1";
    const rows = Math.floor((CSV_MAX_FILE_BYTES - header.length - 1) / (row.length + 1));
    const buffer = Buffer.from([header, ...Array(rows).fill(row)].join("\n"));
    expect(buffer.byteLength).toBeLessThanOrEqual(CSV_MAX_FILE_BYTES);

    const startedAt = performance.now();
    const result = previewCsv(buffer);
    const elapsedMs = performance.now() - startedAt;

    expect(result.totalRows).toBe(rows);
    expect(result.previewRows).toHaveLength(50);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
