import sharp from "sharp";
import { ApiError } from "../middleware/error.middleware";

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MAX_PIXELS = 50_000_000;
const RECEIPT_FORMATS: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Check actual image contents before accepting them into private storage. */
export async function validateReceiptUpload(file: { buffer: Buffer; mimetype: string }): Promise<void> {
  if (file.buffer.length === 0) throw new ApiError(400, "This receipt file is empty. Choose another image.");
  if (file.buffer.length > RECEIPT_MAX_BYTES) throw new ApiError(400, "Each receipt image must be 10 MB or smaller.");
  if (!RECEIPT_FORMATS[file.mimetype]) throw new ApiError(400, "Use a JPEG, PNG, or WebP receipt image.");

  try {
    const image = sharp(file.buffer, { failOn: "error", limitInputPixels: RECEIPT_MAX_PIXELS });
    const metadata = await image.metadata();
    if (metadata.format !== RECEIPT_FORMATS[file.mimetype]) {
      throw new ApiError(400, "The receipt file type does not match its contents. Export it as JPEG, PNG, or WebP.");
    }
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
      throw new ApiError(400, "Choose a still receipt image with a single page.");
    }
    // Header inspection alone accepts truncated files. Decoding a tiny result
    // checks readability without retaining another full-resolution image.
    await image.resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "This receipt image could not be read. Try another image, up to 50 megapixels.");
  }
}
