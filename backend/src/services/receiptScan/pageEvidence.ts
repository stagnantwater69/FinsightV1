import type { ReceiptScanPage } from "@prisma/client";
import type { ReceiptCaptureMetadata } from "./types";

export type ReceiptPageImageVariant = "source" | "derived";

function captureMetadata(value: unknown): ReceiptCaptureMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ReceiptCaptureMetadata;
}

function derivedLabel(mode: ReceiptCaptureMetadata["processingMode"]): string {
  if (mode === "manual-crop") return "Rectified";
  if (mode === "clear-colour") return "Enhanced color";
  if (mode === "grayscale") return "Enhanced grayscale";
  if (mode === "black-white") return "Enhanced black and white";
  return "Processed";
}

export function receiptPageEvidence(page: ReceiptScanPage) {
  const metadata = captureMetadata(page.captureMetadata);
  const sourceLabel = metadata.captureMode === "long" ? "Composite source" : "Source";

  return {
    pageNumber: page.pageNumber,
    captureMode: metadata.captureMode ?? null,
    processingMode: metadata.processingMode ?? "original",
    ocrInput: page.ocrSource === "processed" ? "derived" : "source",
    source: {
      variant: "source" as const,
      label: sourceLabel,
      width: metadata.originalWidth ?? null,
      height: metadata.originalHeight ?? null,
    },
    derived: page.processedImageFile
      ? {
          variant: "derived" as const,
          label: derivedLabel(metadata.processingMode),
          width: metadata.processedWidth ?? null,
          height: metadata.processedHeight ?? null,
        }
      : null,
  };
}
