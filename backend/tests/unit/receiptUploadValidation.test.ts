import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { RECEIPT_MAX_BYTES, validateReceiptUpload } from "../../src/lib/receiptUploadValidation";

describe("receipt upload validation", () => {
  it.each(["jpeg", "png", "webp"] as const)("accepts decoded %s images", async (format) => {
    const buffer = await sharp({ create: { width: 80, height: 120, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    await expect(validateReceiptUpload({ buffer, mimetype: `image/${format}` })).resolves.toBeUndefined();
  });
  it("rejects empty, oversized, unsupported, corrupt, and mismatched image data", async () => {
    const png = await sharp({ create: { width: 80, height: 120, channels: 3, background: "white" } }).png().toBuffer();
    for (const file of [
      { buffer: Buffer.alloc(0), mimetype: "image/jpeg" },
      { buffer: Buffer.alloc(RECEIPT_MAX_BYTES + 1), mimetype: "image/jpeg" },
      { buffer: Buffer.from("%PDF-1.7"), mimetype: "application/pdf" },
      { buffer: Buffer.from("receipt text"), mimetype: "image/jpeg" },
      { buffer: png, mimetype: "image/jpeg" },
      { buffer: png.subarray(0, 50), mimetype: "image/png" },
    ]) await expect(validateReceiptUpload(file)).rejects.toMatchObject({ status: 400 });
  });
});
