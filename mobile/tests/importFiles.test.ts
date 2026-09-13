import { describe, expect, it } from "vitest";
import { CSV_MAX_BYTES, RECEIPT_MAX_BYTES, csvFileError, receiptFileError, receiptMimeType } from "../src/lib/importFiles";

describe("receipt and CSV file selection", () => {
  it.each(["receipt.jpg", "receipt.JPEG", "receipt.png", "receipt.webp"])("accepts supported image %s", (name) => {
    expect(receiptFileError({ name, size: RECEIPT_MAX_BYTES })).toBeNull();
    expect(receiptFileError({ name, size: RECEIPT_MAX_BYTES + 1 })).toMatch(/10 MiB/);
  });
  it("rejects PDFs and misleading MIME types", () => {
    expect(receiptFileError({ name: "receipt.pdf", mimeType: "application/pdf" })).toMatch(/PDF/);
    expect(receiptFileError({ name: "receipt.jpg", mimeType: "application/pdf" })).toMatch(/Choose a JPG/);
    expect(receiptFileError({ name: "receipt.jpg", mimeType: "image/jpeg", size: 0 })).toMatch(/empty/);
    expect(receiptFileError({ name: "receipt.png", mimeType: "application/octet-stream" })).toBeNull();
  });
  it("maps document images to their real supported MIME", () => {
    expect(receiptMimeType("receipt.PNG")).toBe("image/png");
    expect(receiptMimeType("receipt.webp")).toBe("image/webp");
    expect(receiptMimeType("receipt.jpeg")).toBe("image/jpeg");
  });
  it("enforces CSV type, empty-file and exact size boundaries", () => {
    expect(csvFileError({ name: "export.csv", size: CSV_MAX_BYTES })).toBeNull();
    expect(csvFileError({ name: "export.CSV", size: CSV_MAX_BYTES + 1 })).toMatch(/5 MB/);
    expect(csvFileError({ name: "export.xlsx", size: 20 })).toMatch(/Export Excel/);
    expect(csvFileError({ name: "export.csv", size: 0 })).toMatch(/empty/);
  });
});
