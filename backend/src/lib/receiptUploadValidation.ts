import { stat } from "node:fs/promises";
import sharp from "sharp";
import { ApiError } from "../middleware/error.middleware";
import {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "./receiptUploadContract";

export const RECEIPT_MAX_BYTES = RECEIPT_UPLOAD_MAX_OBJECT_BYTES;
const RECEIPT_MAX_PIXELS = 50_000_000;
const RECEIPT_FORMATS: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};
const RECEIPT_MIME_TYPES = new Set<string>(RECEIPT_UPLOAD_ALLOWED_MIME_TYPES);

interface ReceiptUploadValidationInput {
  buffer?: Buffer;
  path?: string;
  size?: number;
  mimetype: string;
}

export async function receiptUploadByteLength(file: ReceiptUploadValidationInput): Promise<number> {
  if (file.buffer) return file.buffer.length;
  if (!file.path) throw new ApiError(400, "This receipt file is unavailable. Choose it again.");
  try {
    const details = await stat(file.path);
    if (!details.isFile()) throw new ApiError(400, "This receipt file is unavailable. Choose it again.");
    return details.size;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "This receipt file is unavailable. Choose it again.");
  }
}

/** Check actual image contents before accepting them into private storage. */
export async function validateReceiptUpload(file: ReceiptUploadValidationInput): Promise<void> {
  const byteLength = await receiptUploadByteLength(file);
  if (byteLength === 0) throw new ApiError(400, "This receipt file is empty. Choose another image.");
  if (byteLength > RECEIPT_MAX_BYTES) throw new ApiError(400, "Each receipt image must be 10 MiB or smaller.");
  if (!RECEIPT_MIME_TYPES.has(file.mimetype)) {
    throw new ApiError(400, "Use a JPEG, PNG, or WebP receipt image.");
  }

  try {
    const image = sharp(file.buffer ?? file.path!, { failOn: "error", limitInputPixels: RECEIPT_MAX_PIXELS });
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
