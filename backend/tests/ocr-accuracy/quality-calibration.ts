/**
 * Does image quality predict a bad read?
 *
 *   npx tsx tests/ocr-accuracy/quality-calibration.ts
 *
 * Same discipline as confidence-calibration.ts, for the same reason: a
 * "retake this photo" prompt is only worth showing if the measurement behind
 * it actually separates the receipts OCR reads from the ones it does not. If
 * sharp and blurry images score alike, any threshold is just an insult to
 * people whose photographs were fine.
 *
 * Writes quality-calibration.json next to this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessImageQuality } from "../../src/lib/imageQuality";
import { extractReceipt, parseLineItems, parseReceiptFields } from "../../src/services/ocr.service";
import { scoreAmount, scoreDate, scoreItems, scoreVendor, type ExpectedItem } from "./scoring";

const HERE = __dirname;
const IMAGES = join(HERE, "images");

interface Entry {
  id: string;
  file: string;
  kind: string;
  conditions: string;
  needs_review?: boolean;
  expected: { date: string | null; vendor: string | null; amount: number | null; items?: ExpectedItem[] | null };
}

(async () => {
  const all: Entry[] = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8"));
  const corpus = all.filter((e) => !e.needs_review);
  const rows = [];

  for (const entry of corpus) {
    process.stdout.write(`  ${entry.id.padEnd(34)} `);
    const buffer = readFileSync(join(IMAGES, entry.file));

    const quality = await assessImageQuality(buffer);
    const ocr = await extractReceipt(buffer);
    const parsed = parseReceiptFields(ocr.text);
    const items = parseLineItems(ocr.text);

    const verdicts = [
      scoreDate(entry.expected.date, parsed.date),
      scoreVendor(entry.expected.vendor, parsed.vendor),
      scoreAmount(entry.expected.amount, parsed.amount),
    ];
    const itemScore = entry.expected.items ? scoreItems(entry.expected.items, items) : null;
    const anyError =
      verdicts.some((v) => v === "wrong" || v === "missed") ||
      (itemScore !== null && (itemScore.matched < itemScore.expected || itemScore.falsePositives > 0));

    const row = {
      id: entry.id,
      kind: entry.kind,
      conditions: entry.conditions,
      sharpness: quality?.sharpness ?? null,
      brightness: quality?.brightness ?? null,
      glare: quality?.glare ?? null,
      anyError,
    };
    rows.push(row);
    console.log(
      `sharp=${(row.sharpness ?? 0).toFixed(0).padStart(6)}  ` +
        `bright=${(row.brightness ?? 0).toFixed(0).padStart(3)}  ` +
        `glare=${((row.glare ?? 0) * 100).toFixed(1).padStart(5)}%  ` +
        (anyError ? "HAS ERROR" : "clean"),
    );
  }

  writeFileSync(join(HERE, "quality-calibration.json"), JSON.stringify(rows, null, 2) + "\n");

  const clean = rows.filter((r) => !r.anyError);
  const broken = rows.filter((r) => r.anyError);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const fmt = (xs: number[]) =>
    xs.length ? `n=${xs.length} mean=${mean(xs).toFixed(0)} min=${Math.min(...xs).toFixed(0)} max=${Math.max(...xs).toFixed(0)}` : "n=0";

  const sharp = (rs: typeof rows) => rs.map((r) => r.sharpness).filter((x): x is number => x !== null);

  console.log("\n=== Sharpness (Laplacian variance) ===");
  console.log(`  read cleanly:      ${fmt(sharp(clean))}`);
  console.log(`  had an error:      ${fmt(sharp(broken))}`);

  console.log("\n=== If a photo were rejected below a sharpness threshold ===");
  console.log("  thresh   rejects  correctly-rejected  wrongly-rejected  still-missed");
  const candidates = [10, 25, 50, 100, 200, 400, 800];
  for (const t of candidates) {
    const fires = rows.filter((r) => (r.sharpness ?? Infinity) < t);
    const right = fires.filter((r) => r.anyError).length;
    const wrong = fires.filter((r) => !r.anyError).length;
    console.log(
      `  ${String(t).padStart(6)}   ${String(fires.length).padStart(7)}  ${String(right).padStart(18)}  ` +
        `${String(wrong).padStart(16)}  ${String(broken.length - right).padStart(12)}`,
    );
  }

  console.log("\n=== The images that read badly ===");
  for (const r of broken) {
    console.log(`  ${r.id.padEnd(34)} sharp=${(r.sharpness ?? 0).toFixed(0).padStart(6)}  ${r.conditions}`);
  }
})();
