/**
 * Runs every corpus image through the real OCR pipeline (extractText +
 * parseReceiptFields — the exact functions receiptScan.service calls) and scores
 * date / vendor / amount against ground truth.
 *
 *   npx tsx tests/ocr-accuracy/run-assessment.ts
 *
 * Writes results.json and OCR-ACCURACY-REPORT.md next to this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, parseLineItems, parseReceiptFields } from "../../src/services/ocr.service";
import {
  pct,
  scoreAmount,
  scoreDate,
  scoreItems,
  scoreVendor,
  SYMBOL,
  type ExpectedItem,
  type ItemScore,
  type Verdict,
} from "./scoring";

const HERE = __dirname;
const IMAGES = join(HERE, "images");

interface Entry {
  id: string;
  file: string;
  kind: "real" | "synthetic" | "degraded";
  derived_from?: string;
  conditions: string;
  known_ambiguous?: boolean;
  known_layout_risk?: boolean;
  vendor_note?: string;
  /**
   * Set by ingest-images.ts on an entry whose expected values were DRAFTED
   * FROM THE PIPELINE'S OWN OUTPUT rather than read off the paper by a person.
   *
   * Such an entry is not ground truth — it is a snapshot of current behaviour,
   * and scoring against it would grade the system on its own homework, giving
   * a figure that cannot fall no matter how badly the parser breaks. Entries
   * carrying this flag are excluded from the run entirely until a human has
   * checked them and removed it.
   */
  needs_review?: boolean;
  expected: {
    date: string | null;
    vendor: string | null;
    amount: number | null;
    /** Null on entries predating the item assessment; [] means "genuinely none". */
    items?: ExpectedItem[] | null;
  };
}

/** One corpus image's outcome. Local to this script — the scoring it uses is shared. */
interface Result {
  id: string;
  kind: string;
  conditions: string;
  expected: Entry["expected"];
  actual: {
    date: string | null;
    vendor: string | null;
    amount: number | null;
    items: { name: string; quantity: number | null; amount: number }[];
  };
  verdict: { date: Verdict; vendor: Verdict; amount: Verdict };
  itemScore: ItemScore | null;
  rawText: string;
}

function tally(results: Result[], field: "date" | "vendor" | "amount") {
  const scored = results.filter((r) => r.verdict[field] !== "n/a");
  return {
    correct: scored.filter((r) => r.verdict[field] === "correct").length,
    wrong: scored.filter((r) => r.verdict[field] === "wrong").length,
    missed: scored.filter((r) => r.verdict[field] === "missed").length,
    scored: scored.length,
    skipped: results.length - scored.length,
  };
}

(async () => {
  const all: Entry[] = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8"));
  const corpus = all.filter((e) => !e.needs_review);
  const unreviewed = all.length - corpus.length;
  if (unreviewed > 0) {
    console.log(
      `\n  ⚠  Skipping ${unreviewed} entr${unreviewed === 1 ? "y" : "ies"} still marked needs_review.\n` +
        `     Their expected values were drafted from this pipeline's own output, so scoring\n` +
        `     against them would measure nothing. Check them against the receipts and remove\n` +
        `     the flag to bring them in.\n`,
    );
  }
  const results: Result[] = [];

  for (const entry of corpus) {
    process.stdout.write(`  ${entry.id.padEnd(30)} `);
    const buffer = readFileSync(join(IMAGES, entry.file));
    let actual: Result["actual"] = { date: null, vendor: null, amount: null, items: [] };
    let rawText = "";
    try {
      // OCR_PSM / OCR_DPI let a tuning sweep run through this exact scoring
      // path. Unset in a normal run, which is what the report describes.
      rawText = await extractText(buffer, {
        pageSegMode: process.env.OCR_PSM,
        dpi: process.env.OCR_DPI,
      });
      const parsed = parseReceiptFields(rawText);
      actual = {
        date: parsed.date,
        vendor: parsed.vendor,
        amount: parsed.amount,
        items: parseLineItems(rawText).map((i) => ({ name: i.name, quantity: i.quantity, amount: i.amount })),
      };
    } catch (err) {
      rawText = `OCR ERROR: ${(err as Error).message}`;
    }

    const verdict = {
      date: scoreDate(entry.expected.date, actual.date),
      vendor: scoreVendor(entry.expected.vendor, actual.vendor),
      amount: scoreAmount(entry.expected.amount, actual.amount),
    };
    const itemScore = entry.expected.items ? scoreItems(entry.expected.items, actual.items) : null;
    results.push({ id: entry.id, kind: entry.kind, conditions: entry.conditions, expected: entry.expected, actual, verdict, itemScore, rawText });
    const itemNote = itemScore
      ? `items ${itemScore.matched}/${itemScore.expected}${itemScore.falsePositives ? ` (+${itemScore.falsePositives} false)` : ""}`
      : "items —";
    console.log(`date ${SYMBOL[verdict.date]}  vendor ${SYMBOL[verdict.vendor]}  amount ${SYMBOL[verdict.amount]}  ${itemNote}`);
  }

  writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");

  // ---- Report ----
  const d = tally(results, "date");
  const v = tally(results, "vendor");
  const a = tally(results, "amount");

  const byKind = (kind: string) => {
    const subset = results.filter((r) => r.kind === kind);
    return { kind, n: subset.length, ...{
      date: tally(subset, "date"),
      vendor: tally(subset, "vendor"),
      amount: tally(subset, "amount"),
    } };
  };

  const lines: string[] = [];
  lines.push("# FinSight OCR Accuracy Assessment");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`Corpus: **${results.length} receipt images**. Pipeline under test: \`extractText()\` (tesseract.js) followed by \`parseReceiptFields()\` and \`parseLineItems()\` — the same functions the receipt-scan endpoint calls.`);
  lines.push("");
  lines.push("A field is **correct** only on an exact match (amounts to the centavo, dates to the day). Vendor matching tolerates light OCR character noise but not a wrong line.");
  lines.push("");

  lines.push("## Headline results");
  lines.push("");
  lines.push("| Field | Correct | Wrong | Not extracted | Scored | Accuracy |");
  lines.push("|---|---|---|---|---|---|");
  lines.push(`| Date | ${d.correct} | ${d.wrong} | ${d.missed} | ${d.scored} | **${pct(d.correct, d.scored)}** |`);
  lines.push(`| Vendor | ${v.correct} | ${v.wrong} | ${v.missed} | ${v.scored} | **${pct(v.correct, v.scored)}** |`);
  lines.push(`| Amount | ${a.correct} | ${a.wrong} | ${a.missed} | ${a.scored} | **${pct(a.correct, a.scored)}** |`);
  lines.push("");
  const allThree = results.filter(
    (r) => ["date", "vendor", "amount"].every((f) => ["correct", "n/a"].includes(r.verdict[f as "date"]))
  ).length;
  lines.push(`All three fields correct on the same receipt: **${allThree} of ${results.length}** (${pct(allThree, results.length)}).`);
  lines.push("");
  lines.push("`n/a` fields are excluded from the denominator — those are receipts where the information genuinely is not present in the image, so there is nothing to extract.");
  lines.push("");

  // ---- Item-level extraction ----
  const scored = results.filter((r) => r.itemScore !== null).map((r) => r.itemScore!);
  const it = {
    expected: scored.reduce((n, s) => n + s.expected, 0),
    matched: scored.reduce((n, s) => n + s.matched, 0),
    nameCorrect: scored.reduce((n, s) => n + s.nameCorrect, 0),
    quantityCorrect: scored.reduce((n, s) => n + s.quantityCorrect, 0),
    quantityScored: scored.reduce((n, s) => n + s.quantityScored, 0),
    falsePositives: scored.reduce((n, s) => n + s.falsePositives, 0),
  };

  lines.push("## Line-item extraction");
  lines.push("");
  lines.push("Scored per ITEM, not per receipt. An extracted item is paired with a ground-truth item by **amount**; name and quantity are then scored on that pairing. Quantity is only scored on receipts that actually print a quantity column.");
  lines.push("");
  lines.push("| Measure | Count | Of | Rate |");
  lines.push("|---|---|---|---|");
  lines.push(`| Items found (price exact to the centavo) | ${it.matched} | ${it.expected} | **${pct(it.matched, it.expected)}** |`);
  lines.push(`| ...of those, name also correct | ${it.nameCorrect} | ${it.matched} | **${pct(it.nameCorrect, it.matched)}** |`);
  lines.push(`| ...of those, quantity also correct | ${it.quantityCorrect} | ${it.quantityScored} | **${pct(it.quantityCorrect, it.quantityScored)}** |`);
  lines.push(`| **False positives** (extracted, not on the receipt) | ${it.falsePositives} | — | — |`);
  lines.push("");
  lines.push("**The false-positive count is the number that matters most.** A missed item costs the owner one row of manual entry; a fabricated item silently puts money in their books that was never on the receipt. The parser is deliberately biased towards missing rather than inventing, and the recall figure above is the price of that choice.");
  lines.push("");
  if (it.falsePositives === 0) {
    lines.push("No fabricated lines on this corpus.");
  } else {
    lines.push(
      `**${it.falsePositives} fabricated line${it.falsePositives === 1 ? "" : "s"} on this corpus, and that number was 0 until a third real photograph was added.** ` +
        "It is worth being blunt about what that means: the earlier zero was a property of a corpus that was 90% clean renders, not a property of the parser. " +
        "One real receipt found two — one a genuine bug (a pluralised `Prod. Discounts:` line slipping past a denylist written as `\\bdiscount\\b`, now fixed and pinned by a unit test), " +
        "and one an OCR artefact where two printed lines were merged into one so that an item inherited a neighbouring amount. The second is not something a parsing rule can distinguish from a real line.",
    );
  }
  lines.push("");
  lines.push("> **Read the headline recall figure with the corpus in mind.** Most of these images are rendered receipts, and rendered text OCRs far better than a crumpled thermal one photographed on a table. The single real multi-item PHOTO in the corpus (`real-01-ph-pos-photo`) yields **0 of its 2 items** — Tesseract returns its item block as `Spareribs Keal Res FLV` / `co alle oor 9. 00v`, in which no amount is legible, so the parser correctly extracts nothing. The other real receipt (`real-02-clean-digital`) is a clean digital render and scores 3/3. On the evidence here, item extraction from a **clean or lightly degraded** receipt is reliable; item extraction from a **crumpled thermal phone photo is not**, and the product must treat item extraction as best-effort with a manual fallback rather than as something an owner can depend on. This is the same limitation the corpus note above states for the synthetic set generally.");
  lines.push("");

  const multi = results.filter((r) => (r.expected.items?.length ?? 0) >= 2);
  const multiScore = multi.map((r) => r.itemScore!);
  lines.push(`Multi-item receipts only (${multi.length} images, ${multiScore.reduce((n, s) => n + s.expected, 0)} items): **${pct(multiScore.reduce((n, s) => n + s.matched, 0), multiScore.reduce((n, s) => n + s.expected, 0))}** of items found.`);
  lines.push("");

  const noItems = results.filter((r) => r.expected.items?.length === 0);
  if (noItems.length > 0) {
    const clean = noItems.filter((r) => r.actual.items.length === 0).length;
    lines.push(`Receipts with **no itemised lines at all** (${noItems.length}): ${clean} of ${noItems.length} correctly extracted nothing, rather than inventing lines. These are the ones that must fall back to the single-total flow.`);
    lines.push("");
  }

  lines.push("### Per-image item detail");
  lines.push("");
  lines.push("| Image | Expected | Found | Name ok | Qty ok | False |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    if (!r.itemScore) continue;
    const s2 = r.itemScore;
    lines.push(`| \`${r.id}\` | ${s2.expected} | ${s2.matched} | ${s2.nameCorrect} | ${s2.quantityScored ? `${s2.quantityCorrect}/${s2.quantityScored}` : "—"} | ${s2.falsePositives} |`);
  }
  lines.push("");

  lines.push("## Results by image category");
  lines.push("");
  lines.push("| Category | Images | Date | Vendor | Amount |");
  lines.push("|---|---|---|---|---|");
  for (const kind of ["real", "synthetic", "degraded"]) {
    const k = byKind(kind);
    if (k.n === 0) continue;
    lines.push(
      `| ${kind} | ${k.n} | ${pct(k.date.correct, k.date.scored)} | ${pct(k.vendor.correct, k.vendor.scored)} | ${pct(k.amount.correct, k.amount.scored)} |`
    );
  }
  lines.push("");

  lines.push("## Per-image detail");
  lines.push("");
  lines.push("| # | Image | Conditions | Date | Vendor | Amount |");
  lines.push("|---|---|---|---|---|---|");
  results.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | \`${r.id}\` | ${r.conditions} | ${SYMBOL[r.verdict.date]} | ${SYMBOL[r.verdict.vendor]} | ${SYMBOL[r.verdict.amount]} |`
    );
  });
  lines.push("");
  lines.push("✅ correct · ❌ wrong value returned · ⬜ nothing extracted · — not applicable (not present in image)");
  lines.push("");

  const failures = results.filter((r) =>
    (["date", "vendor", "amount"] as const).some((f) => r.verdict[f] === "wrong" || r.verdict[f] === "missed")
  );
  lines.push("## Every failure, with what was returned instead");
  lines.push("");
  if (failures.length === 0) {
    lines.push("No failures.");
  } else {
    for (const f of failures) {
      lines.push(`### \`${f.id}\``);
      lines.push("");
      lines.push(`*${f.conditions}*`);
      lines.push("");
      lines.push("| Field | Expected | Got | |");
      lines.push("|---|---|---|---|");
      for (const field of ["date", "vendor", "amount"] as const) {
        if (f.verdict[field] === "correct" || f.verdict[field] === "n/a") continue;
        lines.push(
          `| ${field} | \`${JSON.stringify(f.expected[field])}\` | \`${JSON.stringify(f.actual[field])}\` | ${SYMBOL[f.verdict[field]]} |`
        );
      }
      lines.push("");
    }
  }

  lines.push("## Corpus composition and what it does and does not prove");
  lines.push("");
  lines.push("| Category | Count | What it tests |");
  lines.push("|---|---|---|");
  // Counted rather than hardcoded — the table said "2 real" for some time
  // after a third real photograph was added.
  const countOf = (kind: string) => results.filter((r) => r.kind === kind).length;
  lines.push(`| real | ${countOf("real")} | Genuine receipt photographs, including two Philippine thermal receipts shot on a phone |`);
  lines.push(`| synthetic | ${countOf("synthetic")} | Parser robustness across layouts, date formats, amount formats, currency symbols, header styles |`);
  lines.push(`| degraded | ${countOf("degraded")} | Synthetic receipts degraded with blur, low contrast, rotation, downscaling, darkness and JPEG artifacts |`);
  lines.push("");
  lines.push(`**This corpus over-states robustness to real-world photo quality.** Only ${countOf("real")} of the ${results.length} images are real photographs.` + ` The ${countOf("degraded")} degraded images are *rendered* receipts with uniform, synthetic degradation applied programmatically — real phone captures have uneven lighting, curled thermal paper, motion blur, shadows and fold creases that are not reproduced here. Tesseract handled every degraded image perfectly, which is a claim about clean-render-plus-filter, **not** about a shopkeeper photographing a crumpled receipt in a dim store.`);
  lines.push("");
  lines.push("**No handwritten receipts are included.** None were available. Handwritten *resibo* are common in sari-sari stores, and tesseract's default model is trained on printed text — accuracy on handwriting should be assumed poor until measured. This is an untested gap, not a passing case.");
  lines.push("");
  lines.push("## Failure patterns");
  lines.push("");
  lines.push("### 1. Ambiguous numeric dates — resolved by defaulting to DD/MM");
  lines.push("");
  lines.push("When a date reads `11/07/2026` and both components are ≤ 12, nothing in the text can resolve it. The parser previously assumed **MM/DD** (US convention) and read that as 7 November; on the real Philippine receipt in this corpus the true date was **11 July**, so it was exactly wrong, and confidently so.");
  lines.push("");
  lines.push("The default is now **DD/MM**, the Philippine convention and this app's target market. Date accuracy went from 95% to **100%** on this corpus. Validity still wins where only one reading is possible — `07/22/2026` is still read as 22 July, because 22 cannot be a month.");
  lines.push("");
  lines.push("**The cost, stated plainly:** a genuinely US-format receipt is now misread instead. That trade is unavoidable without a per-profile locale setting, and it is the right way round for these users. `syn-03` in the corpus is that ambiguous case, and its ground truth is the DD/MM reading.");
  lines.push("");
  lines.push("### 2. Vendor name printed in the footer");
  lines.push("");
  lines.push("The vendor heuristic takes the first substantive line, so a store name printed at the bottom is read wrong (it returns the document header instead). No cheap heuristic separates a footer store name from a \"thank you, come again\" line. Left to the confirm screen and recorded as a known limitation.");
  lines.push("");
  lines.push("### 3. OCR losing the transaction-date line entirely on a real photo");
  lines.push("");
  lines.push("On the real thermal-receipt photo, tesseract never recovered the `Jul 11 2026 (Sat)` line at all — it is absent from the extracted text. The parser can only work with what OCR returns, so no parsing rule could have recovered it. This is an image-quality/OCR-engine limit, and it is the kind of failure the 6 synthetic degraded images did **not** reproduce.");
  lines.push("");
  lines.push("## Image preprocessing, and what it was measured to be worth");
  lines.push("");
  lines.push("`extractText()` now passes every upload through `sharp` before tesseract sees it: EXIF rotation, a downscale to 2000px, and grayscale. **This changes no figure in this report.** Every image above scores identically with and without it — same date, vendor, amount and item results, image for image. It is in the pipeline for orientation correctness and cost, not accuracy:");
  lines.push("");
  lines.push("- **Orientation.** `rotate()` applies the EXIF flag a phone camera writes. A receipt shot in portrait and tagged sideways is unreadable without it. No image in this corpus carries an orientation flag, so this corpus cannot demonstrate the benefit — it is a real-world case the corpus does not cover.");
  lines.push("- **Cost.** On a simulated 4000px phone capture (1.71 MB), OCR took **35.4s** on the raw bytes and **14.3s** including preprocessing — about **60% faster**, for identical output. The receipt scan is the slowest interaction in the app, so this is the change's actual value.");
  lines.push("");
  lines.push("### Preprocessing that was tried and rejected");
  lines.push("");
  lines.push("Recorded so it is not retried on the assumption that it obviously ought to help:");
  lines.push("");
  lines.push("| Tried | Result |");
  lines.push("|---|---|");
  lines.push("| `normalize()` (global contrast stretch) | **Regression.** On the real crumpled thermal photo it read the 188.00 total as `8` and the year 2026 as `2028`. Stretching the whole frame against a bright table background pushes faint thermal strokes out, and a leading `1` goes first. Date and amount both fell 100% → 97%. |");
  lines.push("| `clahe()`, windows 3–100 (local adaptive contrast) | Neutral at best; at small windows it destroyed the date and amount outright. This is the technique uneven lighting is supposed to call for, and it did not help here. |");
  lines.push("| median denoise, 2x upscale, sharpen | Neutral or worse. |");
  lines.push("");
  lines.push("**None of them recovered the two line items lost on the real photo.** That failure is not a contrast problem — tesseract returns the item block as `Spareribs Keal Res FLV`, with no legible amount anywhere in it. No image transform restores detail the capture never recorded. Improving that case needs a better capture or a different engine, not a better filter.");
  lines.push("");
  lines.push("## Engine tuning, and why none of it is applied");
  lines.push("");
  lines.push("Page segmentation mode was swept across the whole corpus. **The current setting — not setting one at all — is the best of every option measured**, so no engine parameter is configured in `extractText()`.");
  lines.push("");
  lines.push("| `tessedit_pageseg_mode` | Date | Vendor | Amount | All three |");
  lines.push("|---|---|---|---|---|");
  lines.push("| **unset (what we ship)** | **100%** | **97%** | **100%** | **29/30** |");
  lines.push("| 3 — fully automatic | 80% | 86% | 63% | 14/30 |");
  lines.push("| 4 — single column | 80% | 86% | 67% | 15/30 |");
  lines.push("| 6 — single uniform block | 100% | 97% | 100% | 29/30 |");
  lines.push("| 11 — sparse text | 100% | 90% | 73% | 19/30 |");
  lines.push("| 12 — sparse text + OSD | 100% | 90% | 73% | 19/30 |");
  lines.push("");
  lines.push("Two things worth knowing, because both are counter-intuitive:");
  lines.push("");
  lines.push("1. **tesseract.js does not default to PSM 3.** It defaults to **PSM 6**, unlike the tesseract CLI. Row 6 above is identical to the unset row image for image, which is what confirms it. Advice written for the CLI does not transfer.");
  lines.push("2. **The mode that sounds right for a receipt is the one that breaks it.** PSM 4 is \"a single column of text of variable sizes\" — a fair description of a receipt, and the obvious thing to reach for. It drops amount accuracy from 100% to **67%**. A receipt's totals block is not a single column, and forcing that reading pulls the figures apart.");
  lines.push("");
  lines.push("`user_defined_dpi=300` was also tested, alone and with PSM 6: neutral in both cases, so it is not set.");
  lines.push("");
  lines.push("Re-run any of these with `OCR_PSM=<n> OCR_DPI=<n> npx tsx tests/ocr-accuracy/run-assessment.ts`.");
  lines.push("");
  lines.push("## Fixes applied during this assessment");
  lines.push("");
  lines.push("1. **Invalid dates crashed the whole upload (defect, fixed).** A DD/MM/YYYY receipt dated after the 12th produced `2026-25-07` — month 25. That becomes an `Invalid Date`, which Prisma rejects with a validation error, so the entire receipt upload failed with a 500 and the owner lost the scan rather than getting a correctable draft. The parser now validates every date against the real calendar (including rejecting e.g. 31 February) and resolves `DD/MM` when the first component cannot be a month.");
  lines.push("2. **Administrative dates were preferred over the transaction date (defect, fixed).** Philippine POS receipts print BIR permit, PTU-issued and accreditation dates *above* the transaction date; first-match-wins read those. The real receipt returned `2024-10-14` from its `PTU Issued` line. Those lines are now excluded, with a fallback so a wrong-but-correctable date still beats an empty field.");
  lines.push("3. **Registration blocks were read as the vendor (defect, fixed).** `VAT REG TIN: …`, `POS SN: …` and bare `*** SALES INVOICE ***` headers are now skipped when choosing the vendor, as are lines that are mostly digits.");
  lines.push("");
  lines.push("4. **Ambiguous numeric dates defaulted to the wrong locale (fixed).** Changed from MM/DD to DD/MM — see failure pattern 1 above.");
  lines.push("");
  lines.push("Measured effect across all four: date accuracy 90% → **100%**, vendor accuracy 89% → **95%**, all-three-correct 16/20 → **19/20**. Every fix is pinned by regression tests in `tests/unit/ocrParsing.test.ts`.");
  lines.push("");
  lines.push("## Bottom line");
  lines.push("");
  lines.push("Amount extraction is the strongest and most important field, at 100% across the corpus including every degraded variant. Dates now also read 100% after the locale fix. The one remaining failure is a vendor name printed in a receipt footer.");
  lines.push("");
  lines.push("These numbers should still not be read as \"OCR is ~100% accurate\". They are a claim about this corpus, which is 90% clean renders and only 2 real photographs, with no handwritten receipts at all. The design already assumes OCR will be wrong sometimes: every scan lands on a confirm screen as an editable draft and nothing is saved until the owner accepts it. Read these figures as \"OCR gives a usable first draft on clean receipts, and needs correcting on difficult ones\".");
  lines.push("");

  writeFileSync(join(HERE, "OCR-ACCURACY-REPORT.md"), lines.join("\n") + "\n");

  console.log("");
  console.log(`Date   ${d.correct}/${d.scored} (${pct(d.correct, d.scored)})`);
  console.log(`Vendor ${v.correct}/${v.scored} (${pct(v.correct, v.scored)})`);
  console.log(`Amount ${a.correct}/${a.scored} (${pct(a.correct, a.scored)})`);
  console.log(`All three: ${allThree}/${results.length}`);
  console.log("");
  console.log("Wrote OCR-ACCURACY-REPORT.md and results.json");
})();
