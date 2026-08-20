/**
 * ONE confidence mapping, for the whole product.
 *
 * WHAT THIS REPLACES. Before this file there were three mutually inconsistent
 * cutoffs for the same question ("how much should the owner distrust this
 * reading?"):
 *
 *   - 75  — the server's vision-rescue routing trigger (receiptScan.service)
 *   - 80 / 60 — the web review screen's three-way colouring of ocrConfidence
 *   - 75  — the web review screen's per-item "N% sure" badge
 *
 * Three numbers meant an owner could see a green page-level percentage above a
 * table of amber item badges, or the reverse, and neither cue told them what to
 * DO. ADR-4 (docs/ML-OCR-CSV-UI-PROGRAM.md) settles it: the owner is shown a
 * calibrated BAND with an instruction in it, never a raw percentage, and every
 * surface derives that band here.
 *
 * WHY 80 AND 60 ARE THE CUTOFFS. They are the widest of the three existing
 * sets, so adopting them cannot make FinSight quieter about a reading it used
 * to warn on — the change only ever adds caution. The routing trigger stays at
 * 75 on the server because it answers a different question (is it worth paying
 * a vision model?), and is deliberately not user-facing.
 *
 * A RAW PERCENTAGE IS NEVER THE PRIMARY CUE. "87%" reads as a grade, and a
 * grade invites the owner to accept it. The band says what to do instead. The
 * number itself survives only in audit/detail positions, where it is evidence
 * rather than instruction.
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
  /** Maps onto the shared Pill/Callout token triples. */
  tone: "ok" | "warn" | "danger";
}

export const BAND_COPY: Record<ConfidenceBand, BandCopy> = {
  clear: {
    label: "Looks clear",
    detail: "FinSight read this receipt cleanly. A quick glance against the paper is still worth it.",
    tone: "ok",
  },
  check: {
    label: "Check a few fields",
    detail: "Most of this read cleanly, but some values are less certain. The ones to check are marked below.",
    tone: "warn",
  },
  review: {
    label: "Review carefully",
    detail: "This receipt was hard to read. Check every value against the paper before saving.",
    tone: "danger",
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
      bands.push(
        confidenceBand({ confidence: item.amountConfidence, visionAssisted: item.extractedByVision }),
      );
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
 * useful if the screen can then say WHICH.
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
 * of what a finding means. Same rule though — ADR-4 forbids showing the raw
 * model score as the primary explanation, so this is what the card carries and
 * the score lives in the audit section.
 */
export const SIGNAL_STRENGTHS = ["weak", "moderate", "strong"] as const;
export type SignalStrength = (typeof SIGNAL_STRENGTHS)[number];

export const SIGNAL_COPY: Record<SignalStrength, { label: string; detail: string; tone: "info" | "warn" | "danger" }> = {
  weak: {
    label: "Low confidence",
    detail: "A soft signal. Worth a glance, and easy to dismiss if it's normal for you.",
    tone: "info",
  },
  moderate: {
    label: "Fairly confident",
    detail: "This stood out clearly against your own history.",
    tone: "warn",
  },
  strong: {
    label: "High confidence",
    detail: "This is well outside what your records usually look like.",
    tone: "danger",
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
export function findingSignalStrength(
  severity: "LOW" | "MEDIUM" | "HIGH",
  score?: number | null,
): SignalStrength {
  if (severity === "HIGH") return "strong";
  if (severity === "LOW") return "weak";
  if (typeof score === "number" && Number.isFinite(score) && score >= 0.85) return "strong";
  return "moderate";
}
