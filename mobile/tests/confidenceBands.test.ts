import { describe, expect, it } from "vitest";
import {
  BAND_CHECK_MIN,
  BAND_CLEAR_MIN,
  BAND_COPY,
  confidenceBand,
  findingSignalStrength,
  needsAttention,
  scanConfidenceBand,
  worstBand,
} from "../src/lib/confidenceBands";

/**
 * The band mapping is the only thing standing between a raw OCR percentage
 * and an owner's judgement about whether to trust a figure, so its edges are
 * pinned rather than left to be re-derived by whoever next reads the file.
 *
 * The cases that matter are the ones where a wrong answer is dangerous in one
 * specific direction: an unknown or a model-interpreted read must never come
 * back as "Looks clear". Everything else is a presentation choice; that one is
 * a truth claim.
 */
describe("receipt confidence bands", () => {
  it("uses the three ADR-4 labels and no others", () => {
    expect([BAND_COPY.clear.label, BAND_COPY.check.label, BAND_COPY.review.label]).toEqual([
      "Looks clear",
      "Check a few fields",
      "Review carefully",
    ]);
  });

  it("calls a clean read clear at the cutoff and above", () => {
    expect(confidenceBand({ confidence: BAND_CLEAR_MIN })).toBe("clear");
    expect(confidenceBand({ confidence: 95 })).toBe("clear");
    expect(confidenceBand({ confidence: 100 })).toBe("clear");
  });

  it("asks for a check between the two cutoffs", () => {
    expect(confidenceBand({ confidence: BAND_CHECK_MIN })).toBe("check");
    expect(confidenceBand({ confidence: 75 })).toBe("check");
    expect(confidenceBand({ confidence: BAND_CLEAR_MIN - 0.5 })).toBe("check");
  });

  it("asks for a careful review below the lower cutoff", () => {
    expect(confidenceBand({ confidence: BAND_CHECK_MIN - 1 })).toBe("review");
    expect(confidenceBand({ confidence: 33 })).toBe("review");
    expect(confidenceBand({ confidence: 0 })).toBe("review");
  });

  it("never calls a vision-interpreted read clear, however sure the model claims to be", () => {
    expect(confidenceBand({ confidence: 99, visionAssisted: true })).toBe("check");
    // Capping only ever moves DOWN — a genuinely bad interpreted read stays
    // "review" rather than being softened to "check".
    expect(confidenceBand({ confidence: 40, visionAssisted: true })).toBe("review");
  });

  it("treats an unmeasured confidence as needing a check, not as clear", () => {
    expect(confidenceBand({ confidence: null })).toBe("check");
    expect(confidenceBand({ confidence: undefined })).toBe("check");
    expect(confidenceBand({ confidence: Number.NaN })).toBe("check");
  });

  it("pairs every band with a status tone and an actionable sentence", () => {
    for (const copy of Object.values(BAND_COPY)) {
      expect(["good", "warning", "critical"]).toContain(copy.tone);
      expect(copy.detail.length).toBeGreaterThan(20);
    }
  });
});

describe("a receipt is only as clear as its worst page", () => {
  it("takes the most cautious of several bands", () => {
    expect(worstBand(["clear", "clear"])).toBe("clear");
    expect(worstBand(["clear", "check"])).toBe("check");
    expect(worstBand(["review", "clear", "check"])).toBe("review");
    expect(worstBand([])).toBe("clear");
  });

  it("lets one badly-read line pull the whole scan down", () => {
    expect(
      scanConfidenceBand({
        ocrConfidence: 95,
        items: [{ amountConfidence: 96 }, { amountConfidence: 30 }],
      }),
    ).toBe("review");
  });

  /*
   * The old inline cutoff was `amountConfidence < 75` on a single row. It is
   * now the shared mapping, and it also feeds the scan-level cue — a receipt
   * whose page read cleanly but whose amounts did not is not "clear".
   */
  it("counts an item a model produced even with no confidence figure of its own", () => {
    expect(scanConfidenceBand({ ocrConfidence: 95, items: [{ extractedByVision: true }] })).toBe("check");
  });

  it("does not punish an older scan twice for having no per-item measurements", () => {
    expect(scanConfidenceBand({ ocrConfidence: 95, items: [{}, {}] })).toBe("clear");
  });
});

describe("which fields to point at", () => {
  it("marks anything that is not a clean read", () => {
    expect(needsAttention({ confidence: 95 })).toBe(false);
    expect(needsAttention({ confidence: 70 })).toBe(true);
    expect(needsAttention({ confidence: 95, visionAssisted: true })).toBe(true);
    expect(needsAttention({ confidence: null })).toBe(true);
  });
});

describe("finding signal strength", () => {
  it("lets severity lead", () => {
    expect(findingSignalStrength("HIGH")).toBe("strong");
    expect(findingSignalStrength("LOW")).toBe("weak");
    expect(findingSignalStrength("MEDIUM")).toBe("moderate");
  });

  /*
   * A score can only nudge a MEDIUM. Scores are not comparable across
   * detectors — a z-score of 3.2 and a normalized isolation-forest score of
   * 0.82 are different units — so letting one define the band would mean the
   * same words describing two different amounts of evidence.
   */
  it("only lets the score break a tie in the middle", () => {
    expect(findingSignalStrength("MEDIUM", 0.9)).toBe("strong");
    expect(findingSignalStrength("MEDIUM", 0.4)).toBe("moderate");
    expect(findingSignalStrength("LOW", 0.99)).toBe("weak");
    expect(findingSignalStrength("HIGH", 0.01)).toBe("strong");
    expect(findingSignalStrength("MEDIUM", null)).toBe("moderate");
  });
});
