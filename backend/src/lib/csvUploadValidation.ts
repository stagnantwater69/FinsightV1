import { TextDecoder } from "node:util";
import { ApiError } from "../middleware/error.middleware";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const BINARY_SIGNATURES = [
  Buffer.from("%PDF-", "ascii"),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("GIF8", "ascii"),
  Buffer.from("BM", "ascii"),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
] as const;

function csvTypeError(): ApiError {
  return new ApiError(
    400,
    "This file is not a plain-text UTF-8 CSV. Export it as CSV UTF-8 and upload it again.",
    { code: "CSV_FILE_TYPE_MISMATCH" },
  );
}

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

/** CSV has no magic number, so reject known binary containers and require valid UTF-8 text bytes. */
export function validateCsvUploadBytes(buffer: Buffer): void {
  const content = buffer.subarray(buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? UTF8_BOM.length : 0);
  if (
    BINARY_SIGNATURES.some((signature) => startsWith(content, signature))
    || (
      content.length >= 12
      && content.subarray(0, 4).toString("ascii") === "RIFF"
      && content.subarray(8, 12).toString("ascii") === "WEBP"
    )
  ) {
    throw csvTypeError();
  }

  for (const byte of content) {
    const disallowedControl = byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
    if (disallowedControl || byte === 0x7f) throw csvTypeError();
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw csvTypeError();
  }
}
