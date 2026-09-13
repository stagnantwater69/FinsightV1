import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANALYSIS_MAX_WIDTH, ANALYSIS_QUALITY, CAPTURE_QUALITY, analysisResize } from "../src/lib/receiptCapture";

const src = (...parts: string[]) => readFileSync(join(__dirname, "..", "src", ...parts), "utf8");
const CAMERA = src("components", "receipt-camera", "ReceiptCamera.tsx");
const SCAN = src("screens", "records", "ScanReceiptScreen.tsx");
const HELPER = src("lib", "analysisImage.ts");
const UPLOAD_CONTRACT = src("lib", "receiptUploadContract.ts");

/**
 * PERF-003. Full-resolution photographs were being uploaded to endpoints that
 * only ever look at a thumbnail of them.
 *
 * /records/receipts/quality-check resizes to width 400 and
 * /records/receipts/detect-edges to width 320 before either does any work, so
 * everything above that was bytes a shop owner paid mobile data for and the
 * server decoded and discarded — once per shutter press, up to eight times for
 * one long receipt.
 *
 * THE LIMIT OF WHAT THIS FILE PROVES. The arithmetic below is real; the capture
 * path it feeds is not covered by any automated test in this repo. Whether the
 * camera still detects edges as well on a physical phone NEEDS PHYSICAL-DEVICE
 * VERIFICATION and this suite must never be cited as evidence that it does.
 */
describe("the analysis-only downscale", () => {
  it("leaves a capture that is already small enough alone", () => {
    expect(analysisResize(800, 1400)).toBeNull();
    expect(analysisResize(ANALYSIS_MAX_WIDTH, 2000)).toBeNull();
  });

  it("scales a full-resolution capture to the ceiling, keeping its aspect ratio", () => {
    expect(analysisResize(4000, 3000)).toEqual({ width: 1000, height: 750 });
    expect(analysisResize(3024, 4032)).toEqual({ width: 1000, height: 1333 });
  });

  /** A very wide, very short crop must not round its way to a zero-pixel image. */
  it("never produces a zero-height image", () => {
    const out = analysisResize(40000, 3);
    expect(out?.height).toBeGreaterThanOrEqual(1);
  });

  it("refuses nonsense dimensions rather than guessing", () => {
    expect(analysisResize(0, 0)).toBeNull();
    expect(analysisResize(Number.NaN, 100)).toBeNull();
    expect(analysisResize(-4000, 3000)).toBeNull();
  });

  /**
   * A wide margin over what the server actually needs, on purpose: those widths
   * belong to ai-ocr-analytics and may be raised, and a client shaved to exactly
   * today's figure would silently start starving them.
   */
  it("keeps a comfortable margin over the widths the server resizes to", () => {
    expect(ANALYSIS_MAX_WIDTH).toBeGreaterThanOrEqual(800);
    expect(ANALYSIS_QUALITY).toBeLessThan(CAPTURE_QUALITY);
  });
});

/**
 * WHAT THE OWNER KEEPS IS UNAFFECTED. This is the half of the change that could
 * do real damage if it drifted — a downscaled image reaching /transform or the
 * scan upload would degrade the receipt the owner actually stores.
 */
describe("the kept image stays at full resolution", () => {
  it("crops from the untouched original", () => {
    // applyCrop builds its form from `selected.originalUri`, never from an
    // analysis copy.
    expect(CAMERA).toMatch(/const form = formFor\(selected\.originalUri, selected\.originalMimeType \?\? 'image\/jpeg'\); form\.append\('corners'/);
    expect(CAMERA).not.toMatch(/analysisImageUri[\s\S]{0,400}?'\/records\/receipts\/transform'/);
  });

  it("uploads the captured page for scanning, not the quality-check copy", () => {
    expect(SCAN).toMatch(/for \(const object of inspection\.objects\)[\s\S]{0,400}uri: object\.uri/);
    expect(UPLOAD_CONTRACT).toMatch(/variant: "processed",\s*uri: page\.uri/);
    expect(UPLOAD_CONTRACT).toMatch(/variant: "original",\s*uri: page\.originalUri \?\? page\.uri/);
  });

  it("downscales only the two inspect-only endpoints", () => {
    expect(CAMERA).toMatch(/analysisImageUri\(selected\.processedUri[\s\S]{0,300}?'\/records\/receipts\/quality-check'/);
    expect(CAMERA).toMatch(/analysisImageUri\(selected\.originalUri[\s\S]{0,300}?'\/records\/receipts\/detect-edges'/);
    expect(SCAN).toMatch(/analysisImageUri\(uri, asset\.width, asset\.height\)/);
  });

  /**
   * Detection answers in fractions of the frame, which is why shrinking its
   * input is safe — but only as long as the corners are scaled back against the
   * FULL-resolution dimensions the crop will be applied to.
   */
  it("still maps detected corners onto the full-resolution original", () => {
    expect(CAMERA).toContain("corners = cornersFromFractions(result.corners, width, height);");
    expect(CAMERA).toContain("const width = selected.originalWidth ?? selected.width;");
  });

  /** A resize that fails must not take the advisory check down with it. */
  it("falls back to the original when the manipulator cannot help", () => {
    expect(HELPER).toMatch(/catch \{\s*\n\s*return uri;/);
  });
});
