import { describe, expect, it } from "vitest";
import {
  CAPTURE_QUALITY,
  canAddSection,
  captureInstruction,
  clampToImage,
  cornersFromFractions,
  cornersToCropRect,
  cropChangesAnything,
  defaultCorners,
  EDGE_CONFIDENCE_FLOOR,
  fullFrameCorners,
  initialCorners,
  isScannerCancellation,
  MAX_SECTIONS,
  moveSection,
  newSectionId,
  OVERLAP_TARGET,
  overlapGuideHeight,
  remainingScannerCapacity,
  scannerFailureMessage,
  scannerPageUris,
  sectionLabel,
  sectionOrdinal,
  shouldPreselectCorners,
} from "../src/lib/receiptCapture";

/**
 * The camera's arithmetic.
 *
 * This suite exists because the camera itself cannot be tested here — there
 * is no render harness on mobile, so `ReceiptCamera.tsx` and the crop editor
 * are verifiable only by hand on a physical Android phone. Everything that
 * could be pulled out of them and checked was, and this is it: crop geometry,
 * the section ceiling, ordering, and the fraction-to-pixel conversion between
 * the server's answer and the phone's file.
 *
 * These are the parts where a quiet off-by-one crops a receipt through its
 * own total, or lets someone photograph a ninth section the server will
 * refuse. The parts that are not here — gesture handling, camera lifecycle,
 * permission screens — are named in the manual test matrix instead of being
 * pretended about.
 */

describe("the section ceiling", () => {
  /**
   * A CONTRACT, not a preference. `MAX_PAGES` in
   * backend/src/services/receiptScan.service.ts configures multer and makes
   * the service reject a ninth page with a 400. If the two drift, the camera
   * lets someone photograph a section that cannot be uploaded — after they
   * have taken it, which is the worst possible moment to find out.
   */
  it("matches the server's own page limit", () => {
    expect(MAX_SECTIONS).toBe(8);
  });

  it("allows sections up to the ceiling and not past it", () => {
    expect(canAddSection(0)).toBe(true);
    expect(canAddSection(MAX_SECTIONS - 1)).toBe(true);
    expect(canAddSection(MAX_SECTIONS)).toBe(false);
    expect(canAddSection(MAX_SECTIONS + 1)).toBe(false);
  });

  it("gives the native scanner only the capacity left in this session", () => {
    expect(remainingScannerCapacity(0)).toBe(MAX_SECTIONS);
    expect(remainingScannerCapacity(3)).toBe(MAX_SECTIONS - 3);
    expect(remainingScannerCapacity(MAX_SECTIONS)).toBe(0);
    expect(remainingScannerCapacity(MAX_SECTIONS + 2)).toBe(0);
    expect(remainingScannerCapacity(-2)).toBe(MAX_SECTIONS);
  });
});

describe("native document-scanner results", () => {
  it("keeps unique usable page URIs in capture order and enforces the limit", () => {
    expect(
      scannerPageUris(
        [
          { uri: " file:///receipt-1.jpg " },
          { uri: "file:///receipt-1.jpg" },
          null,
          { uri: "" },
          { uri: "file:///receipt-2.jpg" },
          { uri: "file:///receipt-3.jpg" },
        ],
        2,
      ),
    ).toEqual(["file:///receipt-1.jpg", "file:///receipt-2.jpg"]);
  });

  it("treats malformed bridge output as no pages", () => {
    expect(scannerPageUris(null, 8)).toEqual([]);
    expect(scannerPageUris({ pages: [] }, 8)).toEqual([]);
    expect(scannerPageUris([{ nope: "file:///x.jpg" }], 8)).toEqual([]);
    expect(scannerPageUris([{ uri: "file:///x.jpg" }], 0)).toEqual([]);
  });

  it("distinguishes owner cancellation from scanner failure", () => {
    expect(isScannerCancellation(new Error("User cancelled the scanner"))).toBe(true);
    expect(isScannerCancellation("Scan canceled")).toBe(true);
    expect(isScannerCancellation(new Error("Google Play Services unavailable"))).toBe(false);
    expect(isScannerCancellation(null)).toBe(false);
  });

  it("turns native failures into safe recovery copy", () => {
    expect(scannerFailureMessage(new Error("Missing NitroModules native implementation"))).toBe(
      "Auto scan couldn't start on this device or build.",
    );
    expect(scannerFailureMessage(new Error("The document scanner returned no receipt pages."))).toBe(
      "The scanner did not return a receipt image. Try again.",
    );
    expect(
      scannerFailureMessage(
        new Error("This receipt has more than the 3 sections FinSight can still add. Remove a page in the scanner and try again."),
      ),
    ).toMatch(/more than the 3 sections/);
  });
});

describe("what the camera says about where you are", () => {
  /**
   * The sentence has to carry that these are parts of ONE receipt. The whole
   * failure this feature prevents is a long receipt entered as several
   * separate purchases, and "3 photos" does not prevent it.
   */
  it("counts the section being framed, not just the ones already taken", () => {
    expect(sectionLabel(0)).toBe("Section 1 of 1");
    expect(sectionLabel(2)).toBe("Section 3 of 3");
  });

  it("numbers a section in the strip by its position in the read order", () => {
    expect(sectionOrdinal(0, 3)).toBe("Section 1 of 3");
    expect(sectionOrdinal(2, 3)).toBe("Section 3 of 3");
  });

  it("does not tell the first section to align with an overlap that does not exist", () => {
    expect(captureInstruction(0)).not.toMatch(/previous/i);
    expect(captureInstruction(1)).toMatch(/previous/i);
  });
});

describe("ordering", () => {
  it("moves a section earlier and later", () => {
    expect(moveSection(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveSection(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  /**
   * The arrows at the ends of the strip are disabled, but a disabled control
   * that still explodes when a race gets past it is not worth the risk — page
   * order is the client's assertion and the server trusts it wholesale.
   */
  it("returns the list untouched rather than throwing on an impossible move", () => {
    const list = ["a", "b", "c"];
    expect(moveSection(list, 0, -1)).toBe(list);
    expect(moveSection(list, 2, 1)).toBe(list);
    expect(moveSection(list, -1, 1)).toBe(list);
    expect(moveSection(list, 9, -1)).toBe(list);
  });

  it("does not mutate the list it was given", () => {
    const list = ["a", "b", "c"];
    moveSection(list, 0, 1);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("issues ids that do not collide, so a removed section cannot reuse one", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSectionId()));
    expect(ids.size).toBe(200);
  });
});

describe("crop geometry", () => {
  const W = 3000;
  const H = 4000;

  it("keeps a dragged handle inside the photograph", () => {
    expect(clampToImage({ x: -50, y: -20 }, W, H)).toEqual({ x: 0, y: 0 });
    expect(clampToImage({ x: 9999, y: 9999 }, W, H)).toEqual({ x: W, y: H });
    expect(clampToImage({ x: 100, y: 200 }, W, H)).toEqual({ x: 100, y: 200 });
  });

  it("opens with handles inset from the edge, so all four are grabbable", () => {
    const corners = defaultCorners(W, H);
    expect(corners.topLeft.x).toBeGreaterThan(0);
    expect(corners.topLeft.y).toBeGreaterThan(0);
    expect(corners.bottomRight.x).toBeLessThan(W);
    expect(corners.bottomRight.y).toBeLessThan(H);
  });

  it("resets to the whole photograph", () => {
    expect(fullFrameCorners(W, H)).toEqual({
      topLeft: { x: 0, y: 0 },
      topRight: { x: W, y: 0 },
      bottomRight: { x: W, y: H },
      bottomLeft: { x: 0, y: H },
    });
  });

  /**
   * The crop applied is the bounding box of the four corners, because
   * expo-image-manipulator cannot resample through a homography and Expo Go
   * has no native module that can. The editor shows that box, so this is not
   * a hidden approximation — but it does have to be the box, exactly.
   */
  it("cuts the bounding box of a tilted quadrilateral", () => {
    const rect = cornersToCropRect(
      {
        topLeft: { x: 300, y: 500 },
        topRight: { x: 2600, y: 400 },
        bottomRight: { x: 2700, y: 3600 },
        bottomLeft: { x: 250, y: 3500 },
      },
      W,
      H,
    );
    expect(rect).toEqual({ originX: 250, originY: 400, width: 2450, height: 3200 });
  });

  it("rounds outward, so a crop never shaves off print the owner included", () => {
    const rect = cornersToCropRect(
      {
        topLeft: { x: 100.7, y: 200.7 },
        topRight: { x: 2000.2, y: 200.7 },
        bottomRight: { x: 2000.2, y: 3000.2 },
        bottomLeft: { x: 100.7, y: 3000.2 },
      },
      W,
      H,
    );
    expect(rect!.originX).toBe(100);
    expect(rect!.originY).toBe(200);
    expect(rect!.originX + rect!.width).toBe(2001);
    expect(rect!.originY + rect!.height).toBe(3001);
  });

  it("never returns a rectangle that leaves the image", () => {
    const rect = cornersToCropRect(
      {
        topLeft: { x: -500, y: -500 },
        topRight: { x: W + 500, y: -500 },
        bottomRight: { x: W + 500, y: H + 500 },
        bottomLeft: { x: -500, y: H + 500 },
      },
      W,
      H,
    );
    expect(rect).toEqual({ originX: 0, originY: 0, width: W, height: H });
  });

  /**
   * A crop this small is a mis-drag, not an intention — two handles pulled
   * together by accident. Refusing is right; silently widening it back up to
   * a minimum would crop somewhere nobody asked for.
   */
  it("refuses a sliver rather than clamping it up to something usable", () => {
    const rect = cornersToCropRect(
      {
        topLeft: { x: 1000, y: 1000 },
        topRight: { x: 1020, y: 1000 },
        bottomRight: { x: 1020, y: 1020 },
        bottomLeft: { x: 1000, y: 1020 },
      },
      W,
      H,
    );
    expect(rect).toBeNull();
  });

  it("knows when a crop is not worth a re-encode", () => {
    expect(cropChangesAnything({ originX: 0, originY: 0, width: W, height: H }, W, H)).toBe(false);
    expect(cropChangesAnything({ originX: 400, originY: 0, width: 2000, height: H }, W, H)).toBe(true);
    expect(cropChangesAnything({ originX: 0, originY: 0, width: W, height: 2000 }, W, H)).toBe(true);
  });
});

describe("what the edge detector is allowed to decide", () => {
  const W = 3000;
  const H = 4000;

  const detected = {
    topLeft: { x: 0.1, y: 0.2 },
    topRight: { x: 0.9, y: 0.2 },
    bottomRight: { x: 0.9, y: 0.8 },
    bottomLeft: { x: 0.1, y: 0.8 },
  };

  /**
   * The server answers in fractions because it detects on a downscaled copy
   * whose dimensions the phone never learns. Applying those numbers as PIXELS
   * would put every handle in the top-left corner of the photograph.
   */
  it("scales the server's fractions to this photograph's real pixels", () => {
    expect(cornersFromFractions(detected, W, H)).toEqual({
      topLeft: { x: 300, y: 800 },
      topRight: { x: 2700, y: 800 },
      bottomRight: { x: 2700, y: 3200 },
      bottomLeft: { x: 300, y: 3200 },
    });
  });

  it("treats a missing or malformed answer as no answer at all", () => {
    expect(cornersFromFractions(null, W, H)).toBeNull();
    expect(cornersFromFractions(undefined, W, H)).toBeNull();
    expect(
      cornersFromFractions({ ...detected, topLeft: { x: NaN, y: 0.2 } }, W, H),
    ).toBeNull();
  });

  it("preselects only above the confidence floor", () => {
    expect(shouldPreselectCorners(EDGE_CONFIDENCE_FLOOR)).toBe(true);
    expect(shouldPreselectCorners(0.95)).toBe(true);
    expect(shouldPreselectCorners(EDGE_CONFIDENCE_FLOOR - 0.01)).toBe(false);
    expect(shouldPreselectCorners(null)).toBe(false);
    expect(shouldPreselectCorners(undefined)).toBe(false);
  });

  /**
   * THE RULE THAT MAKES DETECTION SAFE TO SHIP. Every way detection can fail
   * — no answer, low confidence, nonsense coordinates — lands on the same
   * usable default handles. Failure is not an error state here; it is the
   * same screen the owner would have got if detection had never run.
   */
  it("always yields usable handles, however detection went", () => {
    const fallback = defaultCorners(W, H);
    expect(initialCorners(W, H, null, null)).toEqual(fallback);
    expect(initialCorners(W, H, cornersFromFractions(detected, W, H), 0.1)).toEqual(fallback);
    expect(initialCorners(W, H, null, 0.99)).toEqual(fallback);

    const confident = initialCorners(W, H, cornersFromFractions(detected, W, H), 0.9);
    expect(confident.topLeft).toEqual({ x: 300, y: 800 });
  });

  it("clamps a confident but out-of-range proposal instead of trusting it", () => {
    const overshooting = cornersFromFractions(
      { ...detected, bottomRight: { x: 1.4, y: 1.4 } },
      W,
      H,
    );
    const corners = initialCorners(W, H, overshooting, 0.9);
    expect(corners.bottomRight).toEqual({ x: W, y: H });
  });
});

describe("capture settings", () => {
  /**
   * Raised from the 0.7 inherited from the profile-photo picker, where it is
   * right — an avatar is displayed at 72px and nobody reads it. A receipt is
   * read by an OCR engine at full resolution.
   */
  it("compresses less than the avatar picker it was copied from", () => {
    expect(CAPTURE_QUALITY).toBeGreaterThan(0.7);
    expect(CAPTURE_QUALITY).toBeLessThanOrEqual(1);
  });

  it("aims the overlap guide inside the band it asks for", () => {
    expect(overlapGuideHeight()).toBeGreaterThanOrEqual(OVERLAP_TARGET.min);
    expect(overlapGuideHeight()).toBeLessThanOrEqual(OVERLAP_TARGET.max);
  });
});
