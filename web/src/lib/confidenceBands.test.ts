import { describe, expect, it } from "vitest";
import {
  BAND_CHECK_MIN,
  BAND_CLEAR_MIN,
  confidenceBand,
  findingSignalStrength,
  needsAttention,
  scanConfidenceBand,
  worstBand,
} from "./confidenceBands";

/**
 * WHAT THIS FILE GUARDS.
 *
 * Three cutoffs used to answer the same question differently — 75 for the
 * server's vision routing, 80/60 for the web page-level colouring, 75 for the
 * per-item badge — so a receipt could show a "green" header above amber item
 * rows read by the same engine. ADR-4 collapses them into this one mapping.
 *
 * The tests below are written against the BOUNDARIES and the two rules that
 * cannot be relaxed without inventing certainty: an unmeasured reading is
 * never "Looks clear", and a vision-interpreted one is never "Looks clear"
 * however confident the model was.
 */

describe("confidenceBand", () => {
  it("is clear at and above the clear floor", () => {
    expect(confidenceBand({ confidence: BAND_CLEAR_MIN })).toBe("clear");
    expect(confidenceBand({ confidence: 100 })).toBe("clear");
  });

  it("is check between the two floors", () => {
    expect(confidenceBand({ confidence: BAND_CLEAR_MIN - 1 })).toBe("check");
    expect(confidenceBand({ confidence: BAND_CHECK_MIN })).toBe("check");
  });

  it("is review below the check floor", () => {
    expect(confidenceBand({ confidence: BAND_CHECK_MIN - 1 })).toBe("review");
    expect(confidenceBand({ confidence: 0 })).toBe("review");
  });

  it("never calls an unmeasured reading clear", () => {
    // A missing number must not read as a high one — the failure mode this
    // mapping exists to prevent.
    expect(confidenceBand({ confidence: null })).toBe("check");
    expect(confidenceBand({})).toBe("check");
    expect(confidenceBand({ confidence: Number.NaN })).toBe("check");
  });

  it("caps a vision-interpreted reading below clear", () => {
    // 99% on an interpreted value measures the model's fluency, not the
    // receipt's legibility.
    expect(confidenceBand({ confidence: 99, visionAssisted: true })).toBe("check");
    // But it never makes a genuinely bad reading look better.
    expect(confidenceBand({ confidence: 20, visionAssisted: true })).toBe("review");
  });
});

describe("worstBand", () => {
  it("takes the most cautious of several", () => {
    expect(worstBand(["clear", "check", "clear"])).toBe("check");
    expect(worstBand(["check", "review"])).toBe("review");
    expect(worstBand(["clear", "clear"])).toBe("clear");
  });

  it("is clear for an empty list", () => {
    expect(worstBand([])).toBe("clear");
  });
});

describe("scanConfidenceBand", () => {
  it("is dragged down by one bad item, however good the page read", () => {
    expect(
      scanConfidenceBand({
        ocrConfidence: 95,
        items: [{ amountConfidence: 95 }, { amountConfidence: 40 }],
      }),
    ).toBe("review");
  });

  it("stays clear when the page and every item read cleanly", () => {
    expect(
      scanConfidenceBand({
        ocrConfidence: 92,
        items: [{ amountConfidence: 88 }, { amountConfidence: 96 }],
      }),
    ).toBe("clear");
  });

  it("does not punish an older scan twice for having no per-item measurement", () => {
    // Items with no measurement say nothing; the page-level band already
    // covers "nothing was measured".
    expect(scanConfidenceBand({ ocrConfidence: 90, items: [{}, {}] })).toBe("clear");
  });

  it("treats an unmeasured vision-read item as worth a check", () => {
    expect(
      scanConfidenceBand({ ocrConfidence: 95, items: [{ extractedByVision: true }] }),
    ).toBe("check");
  });

  it("handles a scan with nothing measured at all", () => {
    expect(scanConfidenceBand({})).toBe("check");
  });
});

describe("needsAttention", () => {
  it("is true for anything short of clear", () => {
    expect(needsAttention({ confidence: 90 })).toBe(false);
    expect(needsAttention({ confidence: 70 })).toBe(true);
    expect(needsAttention({ confidence: null })).toBe(true);
  });
});

describe("findingSignalStrength", () => {
  it("follows severity first", () => {
    expect(findingSignalStrength("HIGH", 0.1)).toBe("strong");
    expect(findingSignalStrength("LOW", 0.99)).toBe("weak");
  });

  it("lets a very high score lift a MEDIUM, and nothing else", () => {
    expect(findingSignalStrength("MEDIUM", 0.9)).toBe("strong");
    expect(findingSignalStrength("MEDIUM", 0.5)).toBe("moderate");
    expect(findingSignalStrength("MEDIUM", null)).toBe("moderate");
  });
});
