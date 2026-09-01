import { Image } from "react-native";
import {
  CAPTURE_QUALITY,
  newSectionId,
  scannerPageUris,
  type ReceiptSection,
} from "./receiptCapture";

/**
 * Launches Google ML Kit Document Scanner — the only Android receipt-camera
 * capture path (see `components/receipt-camera/ReceiptCamera.tsx`).
 *
 * The import stays inside the function rather than at module scope so Expo
 * Go and any other unsupported runtime can still load FinSight without ever
 * asking Nitro for a native module it cannot provide. Callers must gate this
 * behind `ANDROID_RECEIPT_SCANNER_ENABLED` first —
 * `lib/receiptScannerLaunch.ts`'s `launchReceiptScanner` does that check
 * before this function is ever called, so an unsupported runtime never
 * reaches the dynamic import at all.
 *
 * THERE IS NO FALLBACK CAMERA on the far side of this call any more. A
 * rejection here becomes a `failure` outcome the screen shows with "Retry
 * scanner" / "Go back" — it never silently opens a different capture
 * implementation.
 */
export async function scanReceiptWithNativeDocumentScanner(maxPages: number): Promise<ReceiptSection[]> {
  const { scanDocument } = await import("expo-document-scanner");
  const result = await scanDocument({
    quality: CAPTURE_QUALITY,
    maxNumDocuments: maxPages,
    includeBase64: false,
    includePdf: false,
    galleryImportAllowed: false,
    scannerMode: "full",
  });

  // VisionKit does not expose a page-limit option. Read one past FinSight's
  // remaining capacity so an over-limit iOS scan is rejected visibly rather
  // than truncating the bottom of a receipt without telling its owner.
  const uris = scannerPageUris(result.pages, maxPages + 1);
  if (uris.length > maxPages) {
    throw new Error(
      `This receipt has more than the ${maxPages} ${maxPages === 1 ? "section" : "sections"} FinSight can still add. Remove a page in the scanner and try again.`,
    );
  }
  if (uris.length === 0) throw new Error("The document scanner returned no receipt pages.");

  return Promise.all(
    uris.map(async (uri): Promise<ReceiptSection> => {
      const { width, height } = await imageDimensions(uri);
      return {
        localId: newSectionId(),
        // VisionKit/ML Kit return the owner-approved, perspective-corrected
        // document image, not the sensor original. Keep that returned file
        // unchanged as both evidence and upload source; any later FinSight
        // transform must write a new URI rather than replacing it.
        originalUri: uri,
        processedUri: uri,
        width,
        height,
        originalWidth: width,
        originalHeight: height,
        quality: null,
        captureSource: "native-document-scanner",
        processingMode: "native-selected",
        transformVersion: "android-ml-kit-document-scanner-v1",
        documentConfidence: 1,
      };
    }),
  );
}

function imageDimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => {
        if (width > 0 && height > 0) resolve({ width, height });
        else reject(new Error("The scanned receipt has invalid dimensions."));
      },
      () => reject(new Error("FinSight could not open the scanned receipt image.")),
    );
  });
}
