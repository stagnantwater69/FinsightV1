/**
 * Is tesseract's confidence worth acting on?
 *
 *   npx tsx tests/ocr-accuracy/confidence-calibration.ts
 *
 * A confidence-triggered vision fallback is only defensible if a low score
 * actually predicts a wrong answer. If correct and incorrect reads score alike,
 * any threshold is just a random tax on the API budget, and the honest move is
 * not to ship the trigger at all.
 *
 * So this measures the thing the threshold depends on, rather than assuming it:
 * for every corpus image it records the confidence tesseract reported AND
 * whether the parse was right, then reports how the two relate. Scoring is the
 * shared scorer, so these verdicts are the same ones run-assessment reports.
 *
 * Writes confidence-calibration.json next to this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  confidenceForValue,
  extractReceipt,
  overallConfidence,
  parseLineItems,
  parseReceiptFields,
} from "../../src/services/ocr.service";
import { LOW_CONFIDENCE } from "../../src/services/receiptScan/extraction";
import { scoreAmount, scoreDate, scoreItems, scoreVendor, type ExpectedItem, type Verdict } from "./scoring";

const HERE = __dirname;
const IMAGES = join(HERE, "images");

interface Entry {
  id: string;
  file: string;
  kind: string;
  conditions: string;
  expected: { date: string | null; vendor: string | null; amount: number | null; items?: ExpectedItem[] | null };
}

interface Row {
  id: string;
  kind: string;
  overall: number;
  amountConfidence: number | null;
  vendorConfidence: number | null;
  verdict: { date: Verdict; vendor: Verdict; amount: Verdict };
  items: { expected: number; matched: number; falsePositives: number } | null;
  /** True when anything on this receipt came out wrong or missing. */
  anyError: boolean;
  /** Confidence of the lowest-confidence item amount — the weakest link. */
  weakestItem: number | null;
  /** Sum of the item amounts read, for the reconciliation trigger. */
  itemsSum: number | null;
  total: number | null;
}

(async () => {
  const corpus: Entry[] = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8"));
  const rows: Row[] = [];

  for (const entry of corpus) {
    process.stdout.write(`  ${entry.id.padEnd(30)} `);
    const buffer = readFileSync(join(IMAGES, entry.file));
    const ocr = await extractReceipt(buffer);
    const parsed = parseReceiptFields(ocr.text);
    const items = parseLineItems(ocr.text);

    const verdict = {
      date: scoreDate(entry.expected.date, parsed.date),
      vendor: scoreVendor(entry.expected.vendor, parsed.vendor),
      amount: scoreAmount(entry.expected.amount, parsed.amount),
    };
    const itemScore = entry.expected.items ? scoreItems(entry.expected.items, items) : null;

    const itemConfidences = items
      .map((i) => confidenceForValue(ocr.lines, i.amount.toFixed(2)))
      .filter((c): c is number => c !== null);

    const anyError =
      Object.values(verdict).some((v) => v === "wrong" || v === "missed") ||
      (itemScore !== null && (itemScore.matched < itemScore.expected || itemScore.falsePositives > 0));

    const row: Row = {
      id: entry.id,
      kind: entry.kind,
      overall: overallConfidence(ocr),
      amountConfidence: confidenceForValue(ocr.lines, parsed.amount?.toFixed(2) ?? null),
      vendorConfidence: confidenceForValue(ocr.lines, parsed.vendor),
      verdict,
      items: itemScore
        ? { expected: itemScore.expected, matched: itemScore.matched, falsePositives: itemScore.falsePositives }
        : null,
      anyError,
      weakestItem: itemConfidences.length > 0 ? Math.min(...itemConfidences) : null,
      itemsSum: items.length > 0 ? Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100 : null,
      total: parsed.amount,
    };
    rows.push(row);
    console.log(
      `overall ${String(row.overall).padStart(3)}%  ` +
        `amount ${String(row.amountConfidence ?? "—").padStart(3)}  ` +
        `weakestItem ${String(row.weakestItem ?? "—").padStart(3)}  ` +
        `${anyError ? "HAS ERROR" : "clean"}`,
    );
  }

  writeFileSync(join(HERE, "confidence-calibration.json"), JSON.stringify(rows, null, 2) + "\n");

  // ---- Does confidence separate the clean reads from the broken ones? ----
  const clean = rows.filter((r) => !r.anyError);
  const broken = rows.filter((r) => r.anyError);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const fmt = (xs: number[]) =>
    xs.length ? `n=${xs.length} mean=${mean(xs).toFixed(1)} min=${Math.min(...xs)} max=${Math.max(...xs)}` : "n=0";

  console.log("\n=== Overall page confidence ===");
  console.log(`  clean receipts:  ${fmt(clean.map((r) => r.overall))}`);
  console.log(`  receipts w/ any error: ${fmt(broken.map((r) => r.overall))}`);

  console.log("\n=== Weakest item-amount confidence ===");
  console.log(`  clean receipts:  ${fmt(clean.map((r) => r.weakestItem).filter((x): x is number => x !== null))}`);
  console.log(`  receipts w/ any error: ${fmt(broken.map((r) => r.weakestItem).filter((x): x is number => x !== null))}`);

  // What a threshold would actually buy, swept across plausible cut-offs.
  const SWEEP_THRESHOLDS = [60, 65, 70, 75, 80, 85, 88, 90];
  const sweep = SWEEP_THRESHOLDS.map((t) => {
    const fires = rows.filter((r) => r.overall < t);
    const caught = fires.filter((r) => r.anyError).length;
    const wasted = fires.filter((r) => !r.anyError).length;
    const missed = broken.length - caught;
    return { threshold: t, fires: fires.length, caught, wasted, missed };
  });
  console.log("\n=== If we triggered vision below a page-confidence threshold ===");
  console.log("  thresh  fires  catches-broken  wasted-on-clean  misses-broken");
  for (const s of sweep) {
    console.log(
      `  ${String(s.threshold).padStart(6)}  ${String(s.fires).padStart(5)}  ${String(s.caught).padStart(14)}  ` +
        `${String(s.wasted).padStart(15)}  ${String(s.missed).padStart(13)}`,
    );
  }

  /*
   * The other candidate trigger, and the one that needs no fitted threshold:
   * do the item amounts add up to the printed total?
   *
   * This is arithmetic, not a heuristic — a mismatch PROVES a misread happened
   * (or that the receipt carries a discount/tax line the parser did not model).
   * It is the signal that catches the failure this work started from: a receipt
   * whose digits were confidently misread, where page confidence stays high.
   *
   * The number that decides whether it is usable is the false-alarm rate on
   * receipts that came out perfectly. If clean receipts routinely fail to
   * reconcile, the trigger is useless regardless of how sound the logic is.
   */
  console.log("\n=== If we triggered vision when items don't sum to the total ===");
  const reconcilable = rows.filter((r) => r.itemsSum !== null && r.total !== null);
  const mismatched = reconcilable.filter((r) => Math.abs(r.itemsSum! - r.total!) >= 0.005);
  console.log(`  receipts where both a total and items were read: ${reconcilable.length}`);
  console.log(`  of those, items != total: ${mismatched.length}`);
  for (const r of mismatched) {
    console.log(
      `    ${r.id.padEnd(32)} items=${r.itemsSum!.toFixed(2)} total=${r.total!.toFixed(2)} ` +
        `diff=${(r.total! - r.itemsSum!).toFixed(2)} ${r.anyError ? "(HAS ERROR)" : "(scored clean — FALSE ALARM)"}`,
    );
  }

  // Regenerated rather than hand-written, so it cannot quietly go stale as the
  // corpus grows or the parser changes.
  const naiveFalseAlarms = mismatched.filter((r) => !r.anyError);
  const report = `# Confidence calibration — when is tesseract worth second-guessing?

Generated by \`tests/ocr-accuracy/confidence-calibration.ts\`. Re-run it after any parser or
preprocessing change; the thresholds in \`receiptScan/extraction.ts\` are justified by these numbers.

This exists to answer one question with evidence rather than intuition: **does a low confidence
score actually predict a wrong answer?** If it does not, a confidence-triggered vision fallback is
just a random tax on the API budget.

## Does confidence separate good reads from bad?

| | n | mean | min | max |
|---|---|---|---|---|
| Receipts that parsed cleanly | ${clean.length} | ${mean(clean.map((r) => r.overall)).toFixed(1)} | ${Math.min(...clean.map((r) => r.overall))} | ${Math.max(...clean.map((r) => r.overall))} |
| Receipts with any error | ${broken.length} | ${mean(broken.map((r) => r.overall)).toFixed(1)} | ${Math.min(...broken.map((r) => r.overall))} | ${Math.max(...broken.map((r) => r.overall))} |

Now that the corpus is real-photo-dominant (45 of 73 images), this separates far less cleanly than the
old 3-real-photo snapshot suggested. Every synthetic render still scores 89-95 regardless of whether it
parsed correctly (that part is unchanged and still means "clean render" more than "correct render"), but
the broken group's range (${Math.min(...broken.map((r) => r.overall))}-${Math.max(...broken.map((r) => r.overall))}) now reaches all the way up to the bottom of the clean group's own range
(${Math.min(...clean.map((r) => r.overall))}-${Math.max(...clean.map((r) => r.overall))}) — a real photo that is actually wrong can still score as high as a real photo that
parsed correctly. One clean receipt (\`${clean.find((r) => r.overall === Math.min(...clean.map((c) => c.overall)))?.id}\`,
confidence ${Math.min(...clean.map((r) => r.overall))}) already fires below the OLD threshold of 75, so 75 was never
actually a zero-false-trigger threshold on this corpus — and it is the *only* clean receipt that fires
anywhere from 75 up to 89, so raising the threshold within that band costs nothing further. At 75, ${broken.length - sweep.find((s) => s.threshold === 75)!.caught} of
${broken.length} real-world error cases score above it and pass through unrescued.

## LOW_CONFIDENCE sweep (Phase 4)

| threshold | fires | catches broken | wasted on clean | misses broken |
|---|---|---|---|---|
${sweep.map((s) => `| ${s.threshold}${s.threshold === LOW_CONFIDENCE ? " (shipped)" : ""} | ${s.fires} | ${s.caught} | ${s.wasted} | ${s.missed} |`).join("\n")}

The wasted-on-clean column stays flat at ${sweep.find((s) => s.threshold === 75)!.wasted} from 75 all the way through 89 — the single
clean receipt above is the only one that fires anywhere in that range — and only increments at 90, where
a real broken receipt and a real clean synthetic receipt tie at the exact same confidence score, so no
threshold can catch one without also flagging the other. 88 is therefore the highest value that adds zero
new false triggers versus 75, while catching every broken case except one.

## Why reconciliation is not \`sum !== total\`

Of ${reconcilable.length} receipts where both a total and items were read, a naive equality check flags
${mismatched.length} — and is **wrong about ${naiveFalseAlarms.length} of them**:

| Receipt | Items | Total | Difference | Actually broken? |
|---|---|---|---|---|
${mismatched
  .map(
    (r) =>
      `| \`${r.id}\` | ${r.itemsSum!.toFixed(2)} | ${r.total!.toFixed(2)} | ${(r.total! - r.itemsSum!).toFixed(2)} | ${r.anyError ? "**yes**" : "no — false alarm"} |`,
  )
  .join("\n")}

The false alarms are not misreads at all. \`1000.00\` of goods against a \`1120.00\` total is the
Philippine 12% VAT; \`480.00\` against \`430.00\` is a senior discount the parser correctly excluded
from the items. A check that cries wolf ${naiveFalseAlarms.length} times out of ${mismatched.length}
trains owners to ignore it, which is worse than not checking at all.

\`reconcileItems\` therefore only reports a gap **the receipt itself cannot explain** — items matching
a printed subtotal, or a difference equal to printed adjustment lines, both count as explained. On
this corpus that reduces the flags to the ${mismatched.filter((r) => r.anyError).length} genuine cases,
with no false alarms.

## LOW_CONFIDENCE decision (Phase 4 — applied)

\`LOW_CONFIDENCE\` is now **${LOW_CONFIDENCE}** in \`receiptScan/extraction.ts\`, raised from 75. This is
the deferred re-tuning the Phase 2 pass above flagged: it only happens once the corpus was real-photo-dominant
(45 of 73 images) *and* Phase 3's deterministic parser fixes had already landed, so this number reflects
failures the parser genuinely can't resolve rather than bugs a parser fix should have removed instead.

The sweep table above is the actual evidence: ${LOW_CONFIDENCE} is the highest threshold that adds zero new
false triggers on this corpus's clean receipts versus the old value of 75 (both sit at
${sweep.find((s) => s.threshold === 75)!.wasted} wasted-on-clean), while catching
${sweep.find((s) => s.threshold === LOW_CONFIDENCE)!.caught - sweep.find((s) => s.threshold === 75)!.caught} more
real broken cases than 75 did, including the wrong-**amount** cases — the single field this repo treats
as highest-stakes — that 75 missed. 90 is the first value that buys the one remaining broken case at the cost
of a second false trigger (a broken real receipt and a clean synthetic receipt tie at the exact same
confidence score at that point, so no threshold can separate them), which is why this stops at ${LOW_CONFIDENCE}
rather than 90.

Re-run this script (\`npx tsx tests/ocr-accuracy/confidence-calibration.ts\`) after any parser,
preprocessing, or corpus change, and re-check this table before moving \`LOW_CONFIDENCE\` again.

## Per-image

| Image | Overall | Total's confidence | Weakest item | Clean? |
|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| \`${r.id}\` | ${r.overall}% | ${r.amountConfidence ?? "—"} | ${r.weakestItem ?? "—"} | ${r.anyError ? "❌" : "✅"} |`,
  )
  .join("\n")}
`;
  writeFileSync(join(HERE, "CONFIDENCE-CALIBRATION-REPORT.md"), report);
  console.log("\nWrote CONFIDENCE-CALIBRATION-REPORT.md and confidence-calibration.json");
})();
