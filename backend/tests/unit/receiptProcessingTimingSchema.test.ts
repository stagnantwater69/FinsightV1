import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = join(__dirname, "../..");
const schema = readFileSync(join(backendRoot, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(
    backendRoot,
    "prisma/migrations/20260928053911_receipt_scan_processing_completed_at/migration.sql",
  ),
  "utf8",
);

describe("receipt processing timing schema", () => {
  it("maps a nullable completion timestamp beside the processing start timestamp", () => {
    expect(schema).toMatch(
      /processingStartedAt\s+DateTime\?\s+@map\("ReceiptScan_ProcessingStartedAt"\)\s+processingCompletedAt\s+DateTime\?\s+@map\("ReceiptScan_ProcessingCompletedAt"\)/,
    );
  });

  it("adds the nullable column without fabricating completion times for existing scans", () => {
    expect(migration).toContain(
      'ALTER TABLE "ReceiptScan" ADD COLUMN     "ReceiptScan_ProcessingCompletedAt" TIMESTAMP(3);',
    );
    expect(migration).not.toMatch(/ReceiptScan_ProcessingCompletedAt[^;]*(?:NOT NULL|DEFAULT)/);
    expect(migration).not.toMatch(/\bUPDATE\s+"ReceiptScan"/i);
  });
});
