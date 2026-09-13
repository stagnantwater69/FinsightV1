import type { CapturedPage } from "./types";

export function receiptEvidenceLabels(page: CapturedPage) {
  const source = page.captureSource === "native-document-scanner"
    ? page.captureMode === "long" ? "Composite source" : "Unenhanced scan"
    : "Source photo";
  const processed = page.processingMode === "manual-crop"
    ? "Rectified"
    : page.processingMode === "clear-colour"
      ? "Enhanced color"
      : page.processingMode === "grayscale"
        ? "Enhanced grayscale"
        : page.processingMode === "black-white"
          ? "Enhanced black and white"
          : "Processed image";
  return { source, processed };
}
