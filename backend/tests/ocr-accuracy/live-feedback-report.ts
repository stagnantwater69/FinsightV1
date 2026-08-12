/**
 * What real receipts say about the extractor.
 *
 *   npx tsx tests/ocr-accuracy/live-feedback-report.ts [--days 30] [--threshold 75]
 *
 * The sibling scripts in this directory score a fixed corpus of 31 images with
 * hand-written ground truth. This one scores whatever owners actually scanned,
 * using their confirmations as the labels — the same questions, asked of a
 * sample that grows on its own and looks like real usage instead of like a
 * corpus somebody assembled.
 *
 * IT DOES NOT REPLACE THE CORPUS, and the two answer different questions. The
 * corpus is a fixed yardstick: run it before and after a parser change and the
 * difference is caused by the change, because the images did not move. This
 * report cannot do that — its sample shifts every week with whatever people
 * photographed, so a drop between two runs might be a worse parser or might be
 * a fortnight of crumpled thermal receipts. Use the corpus to judge a CHANGE
 * and this to find out what to change.
 *
 * The other limit, stated here because every number below inherits it: an
 * unedited field is not proof of a correct read. See lib/extractionMetrics.
 *
 * Writes live-feedback.json and LIVE-FEEDBACK-REPORT.md next to this file.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accuracyBySource,
  accuracyTrend,
  calibration,
  fieldAccuracy,
  perScanAccuracy,
  recurringErrors,
  scanCorrectionRate,
  sweepThresholds,
  type CorrectionObservation,
} from "../../src/lib/extractionMetrics";
import { loadCorrections } from "../../src/services/extractionFeedback.service";

const HERE = __dirname;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const num = (n: number | null) => (n === null ? "n/a" : n.toFixed(1));

(async () => {
  const days = arg("days", 30);
  const threshold = arg("threshold", 75);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = (await loadCorrections({ since })) as CorrectionObservation[];

  if (rows.length === 0) {
    /*
     * Not an error, and it must not read like one. This is the expected state
     * for a while: nothing is backfilled (the categoriser's original picks
     * were overwritten for every scan confirmed before the feature existed),
     * so the sample starts at zero and fills up as receipts are confirmed.
     */
    console.log(`No corrections recorded in the last ${days} days.`);
    console.log("Expected until confirmed scans accumulate — nothing was backfilled, by design.");
    return;
  }

  const byField = fieldAccuracy(rows);
  const bySource = accuracyBySource(rows);
  const scans = perScanAccuracy(rows);
  const correctionRate = scanCorrectionRate(rows);
  const calib = calibration(rows, threshold);
  const sweep = sweepThresholds(rows, [50, 60, 65, 70, 75, 80, 85, 90]);
  const trend = accuracyTrend(rows);

  console.log(`\n${rows.length} reviewed fields across ${scans.length} confirmed scans, last ${days} days\n`);

  console.log("=== Which fields does it get wrong most? ===");
  for (const f of byField) {
    console.log(`  ${f.field.padEnd(14)} ${pct(f.unchangedRate).padStart(7)} unchanged   (${f.edited}/${f.reviewed} corrected)`);
  }

  console.log("\n=== By who produced the reading ===");
  for (const s of bySource) {
    console.log(`  ${s.source.padEnd(14)} ${pct(s.unchangedRate).padStart(7)} unchanged   (${s.edited}/${s.reviewed} corrected)`);
  }

  console.log("\n=== How often does a receipt need fixing at all? ===");
  console.log(`  ${correctionRate.scansWithAnyEdit} of ${correctionRate.scans} scans needed at least one correction (${pct(correctionRate.rate)})`);

  console.log(`\n=== Is confidence worth acting on? (threshold ${threshold}) ===`);
  console.log(`  rows carrying a confidence score: ${calib.scored} of ${rows.length}`);
  console.log(`  mean confidence, field left alone: ${num(calib.meanConfidenceWhenUnchanged)}`);
  console.log(`  mean confidence, field corrected:  ${num(calib.meanConfidenceWhenEdited)}`);
  console.log(`  confident and WRONG: ${calib.falseHighConfidence} of ${calib.highConfidenceRows} high-confidence rows`);
  console.log(`  doubted and RIGHT:   ${calib.falseLowConfidence} of ${calib.lowConfidenceRows} low-confidence rows`);

  console.log("\n=== What each threshold would buy ===");
  console.log("  thresh  fires  catches-wrong  wasted-on-right  misses-wrong");
  for (const s of sweep) {
    console.log(
      `  ${String(s.threshold).padStart(6)}  ${String(s.fires).padStart(5)}  ${String(s.catchesEdited).padStart(13)}  ` +
        `${String(s.wastedOnUnchanged).padStart(15)}  ${String(s.missesEdited).padStart(12)}`,
    );
  }

  const clusters = {
    vendor: recurringErrors(rows, "vendor"),
    amount: recurringErrors(rows, "amount"),
    date: recurringErrors(rows, "date"),
    itemCategory: recurringErrors(rows, "itemCategory"),
  };

  console.log("\n=== Mistakes that keep happening ===");
  for (const [field, list] of Object.entries(clusters)) {
    if (list.length === 0) continue;
    console.log(`  ${field}:`);
    for (const c of list.slice(0, 10)) {
      const what = c.itemName ? `${c.itemName}: ` : "";
      console.log(`    ${String(c.count).padStart(4)}x  ${what}${c.originalValue ?? "(nothing)"} -> ${c.finalValue ?? "(removed)"}`);
    }
  }

  writeFileSync(
    join(HERE, "live-feedback.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), days, threshold, rows: rows.length, byField, bySource, correctionRate, calib, sweep, trend, clusters }, null, 2) + "\n",
  );

  // Regenerated rather than hand-written, so it cannot quietly go stale — the
  // same rule the corpus reports in this directory follow.
  const report = `# Live extraction feedback — what real receipts say

Generated by \`tests/ocr-accuracy/live-feedback-report.ts\` over the last **${days} days**
(${rows.length} reviewed fields, ${scans.length} confirmed scans).

> **These are upper bounds, not accuracy.** A field counts as correct here when the owner
> did not change it, which includes both "I checked it" and "I glanced and tapped". The
> confirm screen shows FinSight's answer first, so the measurement is biased towards
> agreement by construction. Corrections are the trustworthy half of this data;
> confirmations are the noisy half. See \`src/lib/extractionMetrics.ts\`.

> **This is not a substitute for the corpus.** \`run-assessment.ts\` scores fixed images with
> real ground truth, so a change in its numbers is caused by a change in the code. The sample
> here moves on its own every week. Judge a change with the corpus; find out *what to change*
> here.

## Which fields does it get wrong most?

| Field | Left unchanged | Corrected | Reviewed |
|---|---|---|---|
${byField.map((f) => `| \`${f.field}\` | ${pct(f.unchangedRate)} | ${f.edited} | ${f.reviewed} |`).join("\n")}

## By who produced the reading

| Source | Left unchanged | Corrected | Reviewed |
|---|---|---|---|
${bySource.map((s) => `| \`${s.source}\` | ${pct(s.unchangedRate)} | ${s.edited} | ${s.reviewed} |`).join("\n")}

## How often does a receipt need fixing at all?

**${correctionRate.scansWithAnyEdit} of ${correctionRate.scans}** confirmed scans needed at least one correction (${pct(correctionRate.rate)}).

This is the number that describes the product rather than the extractor. A scan where one
field of eleven was wrong is not "91% good" — it is a receipt the owner had to stop and fix.

## Is confidence worth acting on?

Measured at the shipped threshold of **${threshold}**.

| | |
|---|---|
| Rows carrying a confidence score | ${calib.scored} of ${rows.length} |
| Mean confidence where the field was left alone | ${num(calib.meanConfidenceWhenUnchanged)} |
| Mean confidence where the field was corrected | ${num(calib.meanConfidenceWhenEdited)} |
| **Confident and wrong** | ${calib.falseHighConfidence} of ${calib.highConfidenceRows} high-confidence rows |
| **Doubted and right** | ${calib.falseLowConfidence} of ${calib.lowConfidenceRows} low-confidence rows |

If those two means sit on top of each other, the threshold is not separating good reads from
bad ones and is only a tax on the API budget — whatever the corpus said, since the corpus is
31 images and this is not.

### What each threshold would buy

| Threshold | Fires | Catches wrong | Wasted on right | Misses wrong |
|---|---|---|---|---|
${sweep.map((s) => `| ${s.threshold} | ${s.fires} | ${s.catchesEdited} | ${s.wastedOnUnchanged} | ${s.missesEdited} |`).join("\n")}

Nothing here picks a winner. The corpus calibration deliberately shipped 75 rather than the
value that maximised its score, because a threshold fitted to its data sat one point away from
a correct read. A bigger sample does not retire that argument.

## Mistakes that keep happening

${
    Object.entries(clusters)
      .filter(([, list]) => list.length > 0)
      .map(
        ([field, list]) =>
          `### \`${field}\`\n\n| Times | Read as | Should have been |\n|---|---|---|\n` +
          list
            .slice(0, 15)
            .map((c) => `| ${c.count} | ${c.itemName ? `**${c.itemName}**: ` : ""}${c.originalValue ?? "_(nothing)_"} | ${c.finalValue ?? "_(removed)_"} |`)
            .join("\n"),
      )
      .join("\n\n") || "_Nothing has recurred yet._"
  }

A one-off misread is noise. The same misread forty times is a rule waiting to be written —
a vendor whose name always mangles the same way, an item the categoriser always misfiles.
Those are the only corrections worth a person's afternoon.

## Accuracy over time

| Week beginning | Left unchanged | Corrected | Reviewed |
|---|---|---|---|
${trend.map((t) => `| ${t.bucket} | ${pct(t.unchangedRate)} | ${t.edited} | ${t.reviewed} |`).join("\n")}
`;

  writeFileSync(join(HERE, "LIVE-FEEDBACK-REPORT.md"), report);
  console.log("\nWrote LIVE-FEEDBACK-REPORT.md and live-feedback.json");
})();
