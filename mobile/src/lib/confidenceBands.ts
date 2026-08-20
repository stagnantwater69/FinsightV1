/**
 * ONE confidence mapping, for the whole product — the app's half of it.
 *
 * WHAT THIS REPLACES ON MOBILE. The confirm screen printed "Reading confidence
 * 87%", which is not a sentence anyone can act on: 87 of what, out of what,
 * and is that good? It is tesseract's mean per-word certainty for the page — a
 * property of the ENGINE, not a probability that the total is right — and
 * owners read it as the latter. A second, unrelated cutoff (`amountConfidence
 * < 75`) decided whether one ITEM was worth remarking on. Web had two more.
 * Four opinions about one number, none of them written down together.
 *
 * ADR-4 (docs/ML-OCR-CSV-UI-PROGRAM.md) settles it: the owner sees a
 * calibrated BAND with an instruction in it, never a raw percentage, and every
 * surface derives that band here.
 *
 * MIRRORS web/src/lib/confidenceBands.ts — same thresholds, same behaviour,
 * same three labels — deliberately rather than being shared, for the reason
 * set out at the top of theme/tokens.ts. The mirror is not left to trust:
 * tests/webParity.test.ts imports BOTH implementations and compares them
 * input-by-input, so a threshold changed on one side fails on this side.
 *
 * The 80/60 cutoffs and the reasoning for them belong to that file and are not
 * restated here — a second copy of the argument is a second thing to drift.
 * What matters locally is that a raw percentage is never the primary cue, and
 * that the number survives only where it is evidence rather than instruction.
 *
 * WHAT IS MOBILE-ONLY HERE: the `tone` values name this app's status tokens
 * (`status[tone]` fill + `statusText[tone]` text) instead of web's Tailwind
 * triples. Same meaning, different token system — colour is never the only
 * signal on either client, because every call site renders the label too.
 */

/** The three bands, worst last. Order matters — `worstBand` relies on it. */
export const CONFIDENCE_BANDS = ["clear", "check", "review"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** At or above this, a reading is presented as trustworthy. */
export const BAND_CLEAR_MIN = 80;
/** At or above this (and below `BAND_CLEAR_MIN`), a few fields want a look. */
export const BAND_CHECK_MIN = 60;

interface BandCopy {
  /** The owner-facing name. Always rendered as TEXT — never colour alone. */
  label: string;
  /** One sentence saying what to do about it. */
  detail: string;
  /** The status token pair to paint it with. */
  tone: "good" | "warning" | "critical";
}

export const BAND_COPY: Record<ConfidenceBand, BandCopy> = {
  clear: {
    label: "Looks clear",
    detail: "FinSight read this receipt cleanly. A quick glance against the paper is still worth it.",
    tone: "good",
  },
  check: {
    label: "Check a few fields",
    detail: "Most of this read cleanly, but some values are less certain. The ones to check are marked below.",
    tone: "warning",
  },
  review: {
    label: "Review carefully",
    detail: "This receipt was hard to read. Check every value against the paper before saving.",
    tone: "critical",
  },
};

export interface BandInput {
  /**
   * The engine's own confidence, 0-100, or null/undefined when it was never
   * measured. Unmeasured is NOT treated as high: a vision-assisted read has no
   * tesseract confidence at all, and letting a missing number resolve to
   * "Looks clear" would be the one failure mode this band must not have.
   */
  confidence?: number | null;
  /**
   * True when a model interpreted the photograph instead of text being read
   * off it. Caps the band at "check" however high the confidence is —
   * interpretation is not reading, and a high score on an interpreted value
   * measures the model's fluency, not the receipt's legibility.
   */
  visionAssisted?: boolean;
}

/** The band for one reading. */
export function confidenceBand({ confidence, visionAssisted = false }: BandInput): ConfidenceBand {
  const measured = typeof confidence === "number" && Number.isFinite(confidence);

  if (!measured) {
    // Nothing measured. "check" rather than "review": an unmeasured read is
    // usually an ordinary deterministic parse that simply predates the metric,
    // and shouting at every one of those trains owners to ignore the band.
    return "check";
  }

  const raw = confidence! >= BAND_CLEAR_MIN ? "clear" : confidence! >= BAND_CHECK_MIN ? "check" : "review";
  if (visionAssisted && raw === "clear") return "check";
  return raw;
}

/** The most cautious of several bands — a receipt is only as clear as its worst page. */
export function worstBand(bands: ConfidenceBand[]): ConfidenceBand {
  return bands.reduce<ConfidenceBand>(
    (worst, band) => (CONFIDENCE_BANDS.indexOf(band) > CONFIDENCE_BANDS.indexOf(worst) ? band : worst),
    "clear",
  );
}

/**
 * The band for a whole scan: the page reading, every item amount, and whether
 * a model was involved, resolved to the single cue shown at the top.
 */
export function scanConfidenceBand(scan: {
  ocrConfidence?: number | null;
  visionAssisted?: boolean;
  items?: { amountConfidence?: number | null; extractedByVision?: boolean }[];
}): ConfidenceBand {
  const bands: ConfidenceBand[] = [
    confidenceBand({ confidence: scan.ocrConfidence, visionAssisted: scan.visionAssisted }),
  ];
  for (const item of scan.items ?? []) {
    // An item amount with no measurement of its own says nothing about the
    // receipt — the page-level reading above already covers that case, and
    // counting it again would push every older scan to "check" twice over.
    if (typeof item.amountConfidence === "number") {
      bands.push(confidenceBand({ confidence: item.amountConfidence, visionAssisted: item.extractedByVision }));
    } else if (item.extractedByVision) {
      bands.push("check");
    }
  }
  return worstBand(bands);
}

/**
 * Whether ONE field or item is the reason a scan is not "Looks clear".
 *
 * This is what turns a band into an action: "Check a few fields" is only
 * useful if the screen can then say WHICH. It also replaces the old inline
 * `amountConfidence < 75` test on the item rows.
 */
export function needsAttention(input: BandInput): boolean {
  return confidenceBand(input) !== "clear";
}

// ============================================================
// Findings — the same idea, a different question
// ============================================================

/**
 * How sure FinSight is that a FLAG is worth the owner's time.
 *
 * Deliberately a separate vocabulary from the receipt bands: "Looks clear" on
 * a flagged record would read as "this record is fine", which is the opposite
 * of what a finding means.
 */
export const SIGNAL_STRENGTHS = ["weak", "moderate", "strong"] as const;
export type SignalStrength = (typeof SIGNAL_STRENGTHS)[number];

export const SIGNAL_COPY: Record<
  SignalStrength,
  { label: string; detail: string; tone: "info" | "warning" | "critical" }
> = {
  weak: {
    label: "Low confidence",
    detail: "A soft signal. Worth a glance, and easy to dismiss if it's normal for you.",
    tone: "info",
  },
  moderate: {
    label: "Fairly confident",
    detail: "This stood out clearly against your own history.",
    tone: "warning",
  },
  strong: {
    label: "High confidence",
    detail: "This is well outside what your records usually look like.",
    tone: "critical",
  },
};

/**
 * Severity leads, score only breaks ties.
 *
 * Severity is the detector's own owner-facing judgement and is comparable
 * across detectors; `score` is not — a z-score of 3.2 and a normalized
 * isolation-forest score of 0.82 are different units entirely. So the score
 * can only nudge a MEDIUM up or down, never define the band on its own.
 */
export function findingSignalStrength(severity: "LOW" | "MEDIUM" | "HIGH", score?: number | null): SignalStrength {
  if (severity === "HIGH") return "strong";
  if (severity === "LOW") return "weak";
  if (typeof score === "number" && Number.isFinite(score) && score >= 0.85) return "strong";
  return "moderate";
}
