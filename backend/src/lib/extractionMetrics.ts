/**
 * Turning recorded corrections into the figures worth acting on.
 *
 * Pure functions over rows, with no database and no clock, so every number
 * below can be tested against a handful of hand-written observations rather
 * than against whatever happens to be in a database that day.
 *
 * THE CENTRAL HONESTY PROBLEM, and why several of these functions look
 * duplicated: an edited field and an unedited one are not equally good
 * evidence. An edit is a person actively disagreeing — near-certain proof the
 * extraction was wrong. A confirmation is a person not disagreeing, which
 * includes both "I checked and it is right" and "I glanced at it and tapped".
 * The second is biased towards agreement by construction, because the screen
 * shows FinSight's answer first and the owner has to overcome it.
 *
 * So `accuracy` here means "the share of fields the owner did not change",
 * which is an UPPER BOUND on true accuracy, and every function that computes
 * it says so in its name or its docs. The one number that must never exist is
 * a single blended "system accuracy" that hides which half of the evidence it
 * rests on.
 */

/** The shape these functions need. A subset of the stored row, so tests can build one by hand. */
export interface CorrectionObservation {
  receiptScanId: number;
  field: string;
  source: string;
  originalValue: string | null;
  finalValue: string | null;
  itemName: string | null;
  confidence: number | null;
  wasEdited: boolean;
  createdAt: Date;
}

export interface FieldAccuracy {
  field: string;
  /** Fields shown to an owner for review. The denominator. */
  reviewed: number;
  /** Of those, how many the owner changed. */
  edited: number;
  /**
   * `(reviewed - edited) / reviewed`. An UPPER BOUND on accuracy — see the
   * module header. Null when nothing has been reviewed yet, rather than 0 or
   * 1, both of which would be read as a real measurement.
   */
  unchangedRate: number | null;
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/**
 * Per-field accuracy, which answers "which fields are most frequently
 * misrecognised" — sorted worst first, because that is the order in which
 * anyone reading it wants to spend their afternoon.
 */
export function fieldAccuracy(rows: CorrectionObservation[]): FieldAccuracy[] {
  const byField = new Map<string, { reviewed: number; edited: number }>();
  for (const row of rows) {
    const bucket = byField.get(row.field) ?? { reviewed: 0, edited: 0 };
    bucket.reviewed += 1;
    if (row.wasEdited) bucket.edited += 1;
    byField.set(row.field, bucket);
  }

  return [...byField.entries()]
    .map(([field, b]) => ({ field, reviewed: b.reviewed, edited: b.edited, unchangedRate: rate(b.reviewed - b.edited, b.reviewed) }))
    .sort((a, b) => (a.unchangedRate ?? 1) - (b.unchangedRate ?? 1));
}

/**
 * The same split by who produced the reading.
 *
 * Kept separate from `fieldAccuracy` rather than added as a column to it
 * because averaging tesseract's error rate with a vision model's produces a
 * number that describes neither, and the whole point of recording `source` was
 * to stop that happening.
 */
export function accuracyBySource(rows: CorrectionObservation[]): { source: string; reviewed: number; edited: number; unchangedRate: number | null }[] {
  const bySource = new Map<string, { reviewed: number; edited: number }>();
  for (const row of rows) {
    const bucket = bySource.get(row.source) ?? { reviewed: 0, edited: 0 };
    bucket.reviewed += 1;
    if (row.wasEdited) bucket.edited += 1;
    bySource.set(row.source, bucket);
  }
  return [...bySource.entries()]
    .map(([source, b]) => ({ source, reviewed: b.reviewed, edited: b.edited, unchangedRate: rate(b.reviewed - b.edited, b.reviewed) }))
    .sort((a, b) => (a.unchangedRate ?? 1) - (b.unchangedRate ?? 1));
}

/**
 * The same split by EXTRACTOR VERSION — which prompt/schema/parser read the
 * scan, resolved by the caller from ReceiptScan.extractorVersions.
 *
 * Takes a resolver rather than joining rows itself so this stays a pure
 * function over observations, like everything else here: the caller decides
 * what "version" means for its question ("vision-prompt-v2", "gemini-x @
 * prompt-v2", the parser tag) by what it puts in the string. Kept separate
 * from accuracyBySource for the same reason that is kept separate from
 * fieldAccuracy — averaging two prompts' error rates produces a number that
 * describes neither, and recording versions per scan was the whole point.
 */
export function accuracyByVersion(
  rows: CorrectionObservation[],
  versionOf: (scanId: number) => string | null,
): { version: string; reviewed: number; edited: number; unchangedRate: number | null }[] {
  const byVersion = new Map<string, { reviewed: number; edited: number }>();
  for (const row of rows) {
    // Scans from before version recording began are reported under their own
    // bucket rather than dropped — they are still evidence, just evidence
    // that cannot be attributed, and hiding them would overstate coverage.
    const version = versionOf(row.receiptScanId) ?? "unversioned";
    const bucket = byVersion.get(version) ?? { reviewed: 0, edited: 0 };
    bucket.reviewed += 1;
    if (row.wasEdited) bucket.edited += 1;
    byVersion.set(version, bucket);
  }
  return [...byVersion.entries()]
    .map(([version, b]) => ({ version, reviewed: b.reviewed, edited: b.edited, unchangedRate: rate(b.reviewed - b.edited, b.reviewed) }))
    .sort((a, b) => (a.unchangedRate ?? 1) - (b.unchangedRate ?? 1));
}

export interface ScanAccuracy {
  receiptScanId: number;
  fieldsReviewed: number;
  fieldsEdited: number;
  unchangedRate: number | null;
}

/** Per-scan accuracy — "how much of this receipt did we get right". */
export function perScanAccuracy(rows: CorrectionObservation[]): ScanAccuracy[] {
  const byScan = new Map<number, { reviewed: number; edited: number }>();
  for (const row of rows) {
    const bucket = byScan.get(row.receiptScanId) ?? { reviewed: 0, edited: 0 };
    bucket.reviewed += 1;
    if (row.wasEdited) bucket.edited += 1;
    byScan.set(row.receiptScanId, bucket);
  }
  return [...byScan.entries()].map(([receiptScanId, b]) => ({
    receiptScanId,
    fieldsReviewed: b.reviewed,
    fieldsEdited: b.edited,
    unchangedRate: rate(b.reviewed - b.edited, b.reviewed),
  }));
}

/**
 * The share of SCANS that needed any correction at all.
 *
 * Deliberately not the share of FIELDS. An owner's experience of the feature
 * is per receipt: a scan where one of eleven fields was wrong is not
 * "91% good", it is a receipt they had to stop and fix. Field-level accuracy
 * measures the extractor; this measures the product.
 */
export function scanCorrectionRate(rows: CorrectionObservation[]): { scans: number; scansWithAnyEdit: number; rate: number | null } {
  const scans = perScanAccuracy(rows);
  const withEdit = scans.filter((s) => s.fieldsEdited > 0).length;
  return { scans: scans.length, scansWithAnyEdit: withEdit, rate: rate(withEdit, scans.length) };
}

export interface CalibrationSummary {
  /** Rows carrying a confidence score. Rows without one are excluded here but still count towards accuracy. */
  scored: number;
  meanConfidenceWhenUnchanged: number | null;
  meanConfidenceWhenEdited: number | null;
  /**
   * Confident and wrong. The expensive failure: nothing on the screen warned
   * the owner to look harder, so this is the population that gets confirmed
   * without being checked.
   */
  falseHighConfidence: number;
  /**
   * Doubted and right. Not a harmless failure — every one of these is a
   * warning the owner was shown for nothing, and enough of them train people
   * to ignore the warning that matters. On the vision-fallback path it is
   * also a wasted API call.
   */
  falseLowConfidence: number;
  /** Denominators for the two above. */
  highConfidenceRows: number;
  lowConfidenceRows: number;
}

/**
 * Does a confidence score actually predict a wrong answer?
 *
 * This is the same question `tests/ocr-accuracy/confidence-calibration.ts`
 * asks of the corpus, asked of live receipts instead. If the two means below
 * sit on top of each other, the threshold in receiptScan.service is a random
 * tax on the API budget no matter what the corpus said, because the corpus is
 * 31 images and this is not.
 */
export function calibration(rows: CorrectionObservation[], threshold: number): CalibrationSummary {
  const scored = rows.filter((r) => r.confidence !== null);
  const unchanged = scored.filter((r) => !r.wasEdited).map((r) => r.confidence!);
  const edited = scored.filter((r) => r.wasEdited).map((r) => r.confidence!);
  const high = scored.filter((r) => r.confidence! >= threshold);
  const low = scored.filter((r) => r.confidence! < threshold);

  return {
    scored: scored.length,
    meanConfidenceWhenUnchanged: mean(unchanged),
    meanConfidenceWhenEdited: mean(edited),
    falseHighConfidence: high.filter((r) => r.wasEdited).length,
    falseLowConfidence: low.filter((r) => !r.wasEdited).length,
    highConfidenceRows: high.length,
    lowConfidenceRows: low.length,
  };
}

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface ThresholdCandidate {
  threshold: number;
  /** Rows that would be flagged as doubtful. */
  fires: number;
  /** Of those, how many were genuinely wrong. */
  catchesEdited: number;
  /** Of those, how many were right all along — the cost of firing. */
  wastedOnUnchanged: number;
  /** Genuinely wrong rows this threshold would let through. */
  missesEdited: number;
}

/**
 * What each candidate threshold would have bought, swept across the plausible
 * range.
 *
 * The same sweep the corpus harness prints, over real receipts. Nothing here
 * picks a winner: the corpus calibration deliberately shipped 75 rather than
 * the corpus-optimal value, on the grounds that a threshold fitted to the data
 * sits one point away from being wrong. That reasoning does not stop applying
 * because the sample got bigger, so this reports the trade and leaves the
 * choice to a person.
 */
export function sweepThresholds(rows: CorrectionObservation[], candidates: number[]): ThresholdCandidate[] {
  const scored = rows.filter((r) => r.confidence !== null);
  const totalEdited = scored.filter((r) => r.wasEdited).length;

  return candidates.map((threshold) => {
    const fires = scored.filter((r) => r.confidence! < threshold);
    const catchesEdited = fires.filter((r) => r.wasEdited).length;
    return {
      threshold,
      fires: fires.length,
      catchesEdited,
      wastedOnUnchanged: fires.length - catchesEdited,
      missesEdited: totalEdited - catchesEdited,
    };
  });
}

export interface ThresholdRecommendation {
  /** Highest confidence at which a field still got corrected. */
  worstCorrect: number | null;
  /** Lowest confidence at which a field was left alone. */
  bestUntouched: number | null;
  /**
   * True when every corrected field scored below every untouched one, leaving
   * an empty band between them. Almost never true on real data, and saying so
   * plainly is the point of reporting it.
   */
  separates: boolean;
  /**
   * The middle of that empty band, or null when there is no band.
   *
   * Deliberately the MIDPOINT and not the value that catches the most errors.
   * The corpus calibration shipped 75 over the higher-scoring alternative
   * because a threshold fitted to the data sits one point away from being
   * wrong if the next receipt lands slightly differently. A larger sample
   * makes the band better measured; it does not make the edge of it a safer
   * place to stand.
   */
  midpoint: number | null;
  /** How much of the range the two populations share. 0 is clean separation. */
  overlap: number;
  scored: number;
}

/**
 * Where the threshold would sit if it were chosen the way the shipped one was.
 *
 * This does not fit a threshold to maximise anything. It looks for the gap
 * between "the most confident reading anyone still had to correct" and "the
 * least confident reading anyone accepted", and proposes the middle of it.
 *
 * On real data those two populations usually OVERLAP, and that is a finding
 * rather than a failure: it means confidence alone cannot cleanly separate
 * good reads from bad ones at any threshold, and the honest response is to
 * lean on the triggers that rest on their own evidence — an empty read, a
 * missing total, items that do not sum — rather than to pick a number that
 * looks decisive. `receiptScan.service` already treats confidence as the
 * weakest of its four triggers for that reason.
 */
export function recommendThreshold(rows: CorrectionObservation[]): ThresholdRecommendation {
  const scored = rows.filter((r) => r.confidence !== null);
  const edited = scored.filter((r) => r.wasEdited).map((r) => r.confidence!);
  const untouched = scored.filter((r) => !r.wasEdited).map((r) => r.confidence!);

  if (edited.length === 0 || untouched.length === 0) {
    return { worstCorrect: null, bestUntouched: null, separates: false, midpoint: null, overlap: 0, scored: scored.length };
  }

  const worstCorrect = Math.max(...edited);
  const bestUntouched = Math.min(...untouched);
  const separates = worstCorrect < bestUntouched;

  return {
    worstCorrect,
    bestUntouched,
    separates,
    midpoint: separates ? Math.round((worstCorrect + bestUntouched) / 2) : null,
    overlap: separates ? 0 : worstCorrect - bestUntouched,
    scored: scored.length,
  };
}

export interface ErrorCluster {
  /** What was read, and what it should have been. */
  originalValue: string | null;
  finalValue: string | null;
  /** For item-level fields, the line this keeps happening on. */
  itemName: string | null;
  count: number;
}

/**
 * The mistakes that keep happening.
 *
 * A one-off misread is noise and there is nothing to do about it. The same
 * misreading forty times is a rule waiting to be written — a vendor whose name
 * always comes back mangled, an item the categoriser always files wrong — and
 * those are the only corrections worth a human's attention. Sorted by
 * frequency and cut by `minCount` for exactly that reason.
 *
 * Item-level clusters key on the ITEM NAME as well as the pair, because
 * "Uncategorized -> Ingredients" as one bucket of 300 rows says nothing
 * actionable, while "pandesal: Uncategorized -> Ingredients, 40 times" is a
 * rule.
 */
export function recurringErrors(rows: CorrectionObservation[], field: string, minCount = 2): ErrorCluster[] {
  const edited = rows.filter((r) => r.field === field && r.wasEdited);
  const byPair = new Map<string, ErrorCluster>();

  for (const row of edited) {
    // Item name is part of the key only where there is one; for receipt-level
    // fields it is null and drops out of the grouping entirely.
    const key = JSON.stringify([row.itemName, row.originalValue, row.finalValue]);
    const existing = byPair.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byPair.set(key, { originalValue: row.originalValue, finalValue: row.finalValue, itemName: row.itemName, count: 1 });
    }
  }

  return [...byPair.values()].filter((c) => c.count >= minCount).sort((a, b) => b.count - a.count);
}

export interface TrendPoint {
  /** ISO date of the bucket's first day. */
  bucket: string;
  reviewed: number;
  edited: number;
  unchangedRate: number | null;
}

/**
 * Accuracy over time, bucketed by week.
 *
 * Weeks rather than days because receipt volume at this scale is low enough
 * that daily buckets would be mostly noise — a day with three scans and one
 * correction is not a 67% accuracy day, it is three scans.
 */
export function accuracyTrend(rows: CorrectionObservation[], field?: string): TrendPoint[] {
  const scoped = field ? rows.filter((r) => r.field === field) : rows;
  const byWeek = new Map<string, { reviewed: number; edited: number }>();

  for (const row of scoped) {
    const bucket = weekStart(row.createdAt);
    const b = byWeek.get(bucket) ?? { reviewed: 0, edited: 0 };
    b.reviewed += 1;
    if (row.wasEdited) b.edited += 1;
    byWeek.set(bucket, b);
  }

  return [...byWeek.entries()]
    .map(([bucket, b]) => ({ bucket, reviewed: b.reviewed, edited: b.edited, unchangedRate: rate(b.reviewed - b.edited, b.reviewed) }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Monday of the row's week, in UTC, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay is 0 for Sunday, which belongs to the week that started six days
  // earlier rather than to the one starting the next day.
  const daysSinceMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - daysSinceMonday);
  return utc.toISOString().slice(0, 10);
}
