import { describe, expect, it } from "vitest";
import {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
  exceedsReceiptUploadAggregateLimit,
  receiptUploadBytes,
  receiptUploadSelectionError,
  type ReceiptUploadFile,
} from "./constants";

function candidate(name: string, size: number, type = "image/png"): ReceiptUploadFile {
  return { name, size, type, lastModified: 1 };
}

describe("receipt upload limits", () => {
  it("matches the server byte, page and MIME contract", () => {
    expect(RECEIPT_UPLOAD_MAX_OBJECT_BYTES).toBe(10_485_760);
    expect(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES).toBe(83_886_080);
    expect(RECEIPT_UPLOAD_MAX_LOGICAL_PAGES).toBe(8);
    expect(RECEIPT_UPLOAD_ALLOWED_MIME_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("accepts the exact object, page and aggregate boundaries", () => {
    const files = Array.from({ length: 8 }, (_, index) =>
      candidate(`page-${index + 1}.png`, RECEIPT_UPLOAD_MAX_OBJECT_BYTES),
    );

    expect(receiptUploadBytes(files)).toBe(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES);
    expect(exceedsReceiptUploadAggregateLimit(files)).toBe(false);
    expect(receiptUploadSelectionError([], files)).toBeNull();
  });

  it("detects one byte beyond the object and aggregate boundaries", () => {
    const files = Array.from({ length: 8 }, (_, index) =>
      candidate(
        `page-${index + 1}.png`,
        RECEIPT_UPLOAD_MAX_OBJECT_BYTES + (index === 7 ? 1 : 0),
      ),
    );

    expect(exceedsReceiptUploadAggregateLimit(files)).toBe(true);
    expect(receiptUploadSelectionError([], [files[7]!])).toMatch(/larger than 10 MiB/);
  });

  it("rejects a ninth logical page while leaving the existing eight valid", () => {
    const selected = Array.from({ length: 8 }, (_, index) => candidate(`page-${index + 1}.png`, 1));

    expect(receiptUploadSelectionError(selected, [candidate("page-9.png", 1)])).toMatch(
      /at most 8 photos/,
    );
    expect(receiptUploadSelectionError([], selected)).toBeNull();
  });
});
