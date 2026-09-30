import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...parts: string[]) => readFileSync(join(__dirname, "..", "src", ...parts), "utf8");
const CAMERA = src("components", "receipt-camera", "ReceiptCamera.tsx");
const SCAN = src("screens", "records", "ScanReceiptScreen.tsx");
const CACHE = src("lib", "receiptScannerCache.ts");

/**
 * Every JPEG `ImageManipulator` writes lands in the app's cache and is reachable
 * only from the code that asked for it, so a copy nothing records is a file
 * nothing deletes: before this guard, one shutter press and one "Check
 * readability" tap each left a JPEG behind until sign-out.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. These are source-shape
 * assertions. Nothing here runs the camera, mounts a permission state, or
 * inspects a real cache directory; whether the files are gone on a phone NEEDS
 * PHYSICAL-DEVICE VERIFICATION and this suite must never be cited for it.
 */
describe("local receipt copies are registered where something will delete them", () => {
  it("records every manipulator output the camera writes", () => {
    const outputs = CAMERA.match(/Manipulator\.manipulateAsync\(/g) ?? [];
    expect(outputs.length).toBeGreaterThan(0);
    expect(CAMERA.match(/trackCacheCopy\(/g)?.length ?? 0).toBeGreaterThanOrEqual(outputs.length);
    expect(CAMERA).toContain("scannerFileLifecycle.created.add(uri)");
  });

  it("records the analysis downscale the camera uploads but never keeps", () => {
    expect(CAMERA).toContain("trackCacheCopy(await analysisImageUri(selected.processedUri");
    expect(CAMERA).toContain("trackCacheCopy(await analysisImageUri(selected.originalUri");
  });

  it("deletes the scan screen's readability copy once the check has answered", () => {
    expect(SCAN).toMatch(/if \(downscaled\) analysisCopy = checkUri;/);
    expect(SCAN).toMatch(/finally \{\s*if \(analysisCopy\) void deleteReceiptScannerFiles\(\[analysisCopy\]\);/);
  });

  /** The whole-folder sweep also empties CSV import and profile-photo picks. */
  it("keeps the whole-folder sweep unreachable outside the account boundary", () => {
    expect(CACHE).not.toMatch(/^async function clearLocalReceiptCopies/m);
    expect(CACHE).toMatch(/export async function clearReceiptScannerCache[\s\S]{0,200}?async function clearLocalReceiptCopies/);
  });
});
