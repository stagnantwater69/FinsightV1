import type { ReceiptPageImage } from "./types";

/**
 * Keeps a signed image response bound to the exact page and variant requested.
 *
 * Receipt URLs are private, short-lived evidence links. Treating their response
 * as untyped data would let a malformed or stale response drive the review
 * image, even though the route itself is owner-scoped.
 */
export function receiptPageImageFromResponse(
  value: unknown,
  expected: { pageNumber: number; variant: "source" | "derived" },
): ReceiptPageImage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const image = value as Record<string, unknown>;
  if (image.pageNumber !== expected.pageNumber
    || image.variant !== expected.variant
    || typeof image.label !== "string" || image.label.length < 1 || image.label.length > 80
    || typeof image.url !== "string" || image.url.length > 4096 || !/^https?:\/\/[^\s]+$/i.test(image.url)
    || !Number.isInteger(image.expiresInSeconds) || Number(image.expiresInSeconds) <= 0) {
    return null;
  }
  const dimension = (candidate: unknown) => candidate === null
    || (Number.isInteger(candidate) && Number(candidate) > 0 && Number(candidate) <= 40000);
  if (!dimension(image.width) || !dimension(image.height)) return null;
  return image as unknown as ReceiptPageImage;
}
