/**
 * Adds real receipt photographs to the accuracy corpus.
 *
 *   1. Drop photos into tests/ocr-accuracy/inbox/
 *   2. npx tsx tests/ocr-accuracy/ingest-images.ts
 *   3. Open ground-truth.json and CORRECT the drafted entries
 *
 * Why this exists: the corpus is 31 images and only 3 are real photographs,
 * which is the biggest single weakness in every accuracy figure FinSight
 * reports. More real receipts is the fix, and the thing standing in the way is
 * not the images — it is transcribing the true date, vendor, total and every
 * line item for each one by hand.
 *
 * So this drafts each entry by running the CURRENT pipeline and writing down
 * what it read, leaving a human to correct it rather than type it from
 * nothing. Correcting a mostly-right draft is minutes; transcribing from
 * scratch is the reason corpora stop growing.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TRAP THIS DESIGN HAS TO AVOID, stated plainly because it would quietly
 * destroy the value of the whole corpus:
 *
 * Ground truth drafted FROM the system's own output is not ground truth. It is
 * a record of what the system currently does. If an unreviewed draft is scored
 * against, the system is graded against its own behaviour and can never fail —
 * an accuracy figure that only ever goes up because it is measuring nothing.
 *
 * Every drafted entry is therefore marked `needs_review: true`, and
 * run-assessment.ts SKIPS those entries and says how many it skipped. An
 * entry starts counting only when a person has deleted that flag, which is
 * the act of saying "I checked this against the paper myself".
 * ────────────────────────────────────────────────────────────────────────
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { extractReceipt, overallConfidence, parseLineItems, parseReceiptFields } from "../../src/services/ocr.service";

const HERE = __dirname;
const INBOX = join(HERE, "inbox");
const IMAGES = join(HERE, "images");
const GROUND_TRUTH = join(HERE, "ground-truth.json");

const SUPPORTED = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".tif", ".tiff"]);

/** Filesystem-safe, collision-free id derived from the original filename. */
function makeId(file: string, taken: Set<string>): string {
  const base = file
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  let id = `real-${base || "receipt"}`;
  let n = 2;
  while (taken.has(id)) id = `real-${base || "receipt"}-${n++}`;
  return id;
}

(async () => {
  if (!existsSync(INBOX)) {
    mkdirSync(INBOX, { recursive: true });
    console.log(`Created ${INBOX}\n\nDrop receipt photos in there and run this again.`);
    return;
  }

  const files = readdirSync(INBOX).filter((f) => SUPPORTED.has(extname(f).toLowerCase()));
  if (files.length === 0) {
    console.log(`No images in ${INBOX}\n\nSupported: ${[...SUPPORTED].join(", ")}`);
    return;
  }

  const corpus = JSON.parse(readFileSync(GROUND_TRUTH, "utf8")) as Record<string, unknown>[];
  const taken = new Set(corpus.map((e) => String(e.id)));
  const alreadyIngested = new Set(corpus.map((e) => String(e.file)));

  console.log(`Found ${files.length} image(s) in inbox/\n`);
  let added = 0;

  for (const file of files) {
    if (alreadyIngested.has(file)) {
      console.log(`  ${file.padEnd(34)} already in the corpus — skipped`);
      continue;
    }

    const id = makeId(file, taken);
    taken.add(id);
    const buffer = readFileSync(join(INBOX, file));

    let draft: Record<string, unknown>;
    try {
      const ocr = await extractReceipt(buffer);
      const parsed = parseReceiptFields(ocr.text);
      const items = parseLineItems(ocr.text);
      console.log(
        `  ${file.padEnd(34)} read at ${overallConfidence(ocr)}% — ` +
          `date=${parsed.date ?? "—"} total=${parsed.amount ?? "—"} items=${items.length}`,
      );
      draft = {
        date: parsed.date,
        vendor: parsed.vendor,
        amount: parsed.amount,
        items: items.map((i) => ({ name: i.name, quantity: i.quantity, amount: i.amount })),
      };
    } catch (err) {
      console.log(`  ${file.padEnd(34)} could not be read: ${(err as Error).message}`);
      // Still worth adding — an image the pipeline cannot read at all is
      // exactly the kind this corpus most needs. It just needs the answers
      // typed in fully rather than corrected.
      draft = { date: null, vendor: null, amount: null, items: [] };
    }

    copyFileSync(join(INBOX, file), join(IMAGES, file));
    corpus.push({
      id,
      file,
      kind: "real",
      // Written by whoever took the photo. Used in the report to explain WHY
      // an image is hard, which is what turns a failure into a fixable one.
      conditions: "TODO describe: lighting, creases, angle, thermal or inkjet, cropping",
      needs_review: true,
      expected: draft,
    });
    added++;
  }

  if (added === 0) {
    console.log("\nNothing new to add.");
    return;
  }

  writeFileSync(GROUND_TRUTH, JSON.stringify(corpus, null, 2) + "\n");

  console.log(`\nDrafted ${added} entr${added === 1 ? "y" : "ies"} into ground-truth.json.`);
  console.log(`
NOT YET COUNTED. Each drafted entry says what FinSight READ, which is a guess,
not the truth — scoring against it would grade the system on its own homework.

For each new entry in ground-truth.json:
  1. Check every value against the actual receipt and fix what is wrong.
     Use null where the receipt genuinely does not show something (a cropped
     header has no vendor — that is "not in the image", not a failure).
  2. Fill in "conditions" — it is what makes a failure diagnosable later.
  3. DELETE the "needs_review": true line.

Then: npx tsx tests/ocr-accuracy/run-assessment.ts`);
})();
