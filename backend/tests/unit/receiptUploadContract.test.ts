import { describe, expect, it } from "vitest";
import {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "../../src/lib/receiptUploadContract";
import { validateReceiptUploadTempRoot } from "../../src/middleware/upload.middleware";

describe("receipt upload contract", () => {
  it("publishes one exact byte and page contract", () => {
    expect(RECEIPT_UPLOAD_MAX_OBJECT_BYTES).toBe(10 * 1024 * 1024);
    expect(RECEIPT_UPLOAD_MAX_LOGICAL_PAGES).toBe(8);
    expect(RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS).toBe(16);
    expect(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES).toBe(80 * 1024 * 1024);
    expect(RECEIPT_UPLOAD_ALLOWED_MIME_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it.each([
    "/",
    "/tmp",
    "relative/finsight-receipt-uploads",
    "/tmp/other-upload-root",
    "/tmp/unsafe/../finsight-receipt-uploads",
  ])("rejects unsafe temporary upload root %s", (root) => {
    expect(() => validateReceiptUploadTempRoot(root)).toThrowError(/temporary storage is unavailable/i);
  });

  it.each([
    "/tmp/finsight-receipt-uploads",
    "/run/finsight/receipt-uploads",
  ])("accepts the dedicated absolute temporary upload root %s", (root) => {
    expect(validateReceiptUploadTempRoot(root)).toBe(root);
  });
});
