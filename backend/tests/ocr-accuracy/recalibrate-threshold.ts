/**
 * Should LOW_CONFIDENCE still be 75?
 *
 *   npx tsx tests/ocr-accuracy/recalibrate-threshold.ts [--days 90]
 *
 * The threshold in `receiptScan.service.ts` decides when tesseract is
 * second-guessed by a vision model. It was chosen from 31 corpus images, two
 * of which were real photographs — the calibration report says so itself, and
 * calls n=2 the honest limit of the exercise. Confirmed receipts are the way
 * out of that, and this script is what reads them.
 *
 * IT PRINTS A RECOMMENDATION AND CHANGES NOTHING. No constant is rewritten, no
 * config is updated, nothing here reaches into the running system. That is
 * deliberate and is the difference between a feedback loop and an unsupervised
 * one: a threshold that moves on its own is a threshold nobody reviewed, fitted
 * to whatever the last few weeks of receipts happened to look like, and its
 * behaviour on the day it drifts is not attributable to any change anyone made.
 * Someone reads this, decides, and edits the constant in a commit that can be
 * pointed at afterwards.
 */
import { recommendThreshold, sweepThresholds, calibration, type CorrectionObservation } from "../../src/lib/extractionMetrics";
import { loadCorrections } from "../../src/services/extractionFeedback.service";

/** Kept in step with receiptScan/extraction.ts's LOW_CONFIDENCE by hand — see the note below. */
const SHIPPED = 88;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

(async () => {
  const days = arg("days", 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = (await loadCorrections({ since })) as CorrectionObservation[];

  const rec = recommendThreshold(rows);

  console.log(`\nConfidence recalibration, last ${days} days`);
  console.log(`${rows.length} reviewed fields, ${rec.scored} of them carrying a confidence score\n`);

  if (rec.scored < 100) {
    /*
     * A refusal, not a warning printed above an answer.
     *
     * The corpus calibration's own conclusion was that 31 images could not
     * support the precision it was being asked for. Printing a recommendation
     * from an even smaller live sample and captioning it "preliminary" would
     * be worse than printing nothing, because the number gets remembered and
     * the caption does not.
     */
    console.log(`Not enough data to recommend anything (${rec.scored} scored rows, want at least 100).`);
    console.log(`Keep ${SHIPPED}. Re-run once more receipts have been confirmed.`);
    return;
  }

  if (rec.worstCorrect === null || rec.bestUntouched === null) {
    console.log("No recommendation: the sample contains only corrections, or only confirmations.");
    console.log(`Keep ${SHIPPED}.`);
    return;
  }

  console.log(`  most confident reading still corrected: ${rec.worstCorrect}`);
  console.log(`  least confident reading left alone:     ${rec.bestUntouched}`);

  if (rec.separates) {
    console.log(`\n  The two populations separate cleanly. Empty band: ${rec.worstCorrect}-${rec.bestUntouched}.`);
    console.log(`  Midpoint: ${rec.midpoint}   (currently shipping ${SHIPPED})`);
    if (rec.midpoint !== null && Math.abs(rec.midpoint - SHIPPED) <= 5) {
      console.log(`  Within 5 points of the shipped value — no change worth making.`);
    } else {
      console.log(`  Worth considering a move to ${rec.midpoint}. Read the trade-off table below first.`);
    }
  } else {
    /*
     * The expected outcome on real data, and not a failure of the method.
     *
     * Overlap means no threshold cleanly separates good reads from bad, so
     * any value is a trade rather than a discovery. Reporting that honestly
     * matters more than producing a number: it says the vision fallback
     * should keep leaning on the triggers that carry their own proof — an
     * empty read, a missing total, items that do not sum — and that
     * confidence remains the weakest of the four.
     */
    console.log(`\n  The two populations OVERLAP by ${rec.overlap} points.`);
    console.log(`  No threshold separates corrected from confirmed readings cleanly, so any`);
    console.log(`  value here is a trade-off rather than a discovery. Pick from the table.`);
  }

  const calib = calibration(rows, SHIPPED);
  console.log(`\n  At the shipped ${SHIPPED}:`);
  console.log(`    confident and WRONG: ${calib.falseHighConfidence} of ${calib.highConfidenceRows}`);
  console.log(`    doubted and RIGHT:   ${calib.falseLowConfidence} of ${calib.lowConfidenceRows}`);

  console.log("\n  thresh  fires  catches-wrong  wasted-on-right  misses-wrong");
  for (const s of sweepThresholds(rows, [50, 60, 65, 70, 75, 80, 85, 88, 90])) {
    const marker = s.threshold === SHIPPED ? " <- shipped" : "";
    console.log(
      `  ${String(s.threshold).padStart(6)}  ${String(s.fires).padStart(5)}  ${String(s.catchesEdited).padStart(13)}  ` +
        `${String(s.wastedOnUnchanged).padStart(15)}  ${String(s.missesEdited).padStart(12)}${marker}`,
    );
  }

  console.log(`\nNothing was changed. To act on this, edit LOW_CONFIDENCE in`);
  console.log(`src/services/receiptScan/extraction.ts and re-run the corpus assessment to check`);
  console.log(`the change against fixed images before it ships.\n`);
})();
