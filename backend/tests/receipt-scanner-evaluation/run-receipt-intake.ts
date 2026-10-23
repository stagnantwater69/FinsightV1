import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildManifest,
  buildPublicManifest,
  IntakeError,
  parseCsv,
  PUBLIC_TRANSCRIPTION_COLUMNS,
  RECEIPT_COLUMNS,
  toCsv,
  TRANSCRIPTION_COLUMNS,
} from "./receipt-intake";

/*
 *   npm run receipt-intake -- --init /private/ph-pilot   # blank sheets and a checklist
 *   npm run receipt-intake -- --dir /private/ph-pilot    # sheets + images -> ground-truth.json
 *
 *   npm run receipt-intake -- --init-public /private/public-set  # published, licensed images
 *   npm run receipt-intake -- --public /private/public-set
 *
 * Keep the folder OUTSIDE the repository: it holds consented receipt images.
 * Exit 0 wrote ground-truth.json; 3 the reviewers disagree (see
 * disagreements.txt, nothing written); 2 invalid input.
 */

const CHECKLIST = `Real-receipt intake checklist
==============================

For each receipt, before it goes in:
  1. The owner agreed, in writing, that this receipt may be used to test FinSight.
     Keep that record outside this folder.
  2. Cover names, phone numbers, addresses, card numbers and loyalty numbers in
     the photo. Save only the covered copy in images/. A second person checks it.
  3. Two people each type what they read into their own sheet, without looking
     at each other's: transcription-1.csv and transcription-2.csv.

receipts.csv (one row per image in images/):
  file              the image's name inside images/, e.g. r001.jpg
  receipt_group     same label for several photos of the SAME paper receipt
  vendor_template   same label for receipts from the same store/printer layout
  partition         CALIBRATION or HOLDOUT. Decide BEFORE running FinSight on it.
                    Keep a store's receipts all in one partition.
  cohort_tags       one or more, separated by ";": ${"CLEAN_PRINTED; STRESSED_OR_FADED; LONG; HANDWRITTEN_OR_HAND_ANNOTATED; FILIPINO_OR_MIXED_LANGUAGE; DAMAGED_OR_LOW_LIGHT"}
  language_tags     ENGLISH; FILIPINO; MIXED; OTHER
  jurisdiction      PH, OTHER or UNKNOWN (PH only if you know it is from the Philippines)
  lighting          NORMAL, LOW_LIGHT or UNKNOWN
  perspective       FRONTAL, SKEWED or UNKNOWN
  page_count        number of pages in the image, or blank if unknown
  handwriting       PRINTED, HANDWRITTEN_OR_ANNOTATED or UNKNOWN
  print_quality     CLEAR, FADED_OR_STRESSED or UNKNOWN
  consent_recorded  yes (step 1 done)
  redaction_reviewed yes (step 2 checked by a second person)
  notes             anything useful; not used for scoring

transcription-1.csv / transcription-2.csv (one row per image):
  file      same name as in receipts.csv
  reviewer  your name or initials (the same on every row; the two sheets must differ)
  vendor    store name as printed, or blank if none
  date      YYYY-MM-DD, or blank if none
  total     the printed total, e.g. 1250.50, or blank if none
  items     optional. Each item as  name | quantity | amount  separated by ";"
            e.g.  Rice 5kg | 1 | 320; Eggs | 12 | 96

Then run:  npm run receipt-intake -- --dir <this folder>
`;

const PUBLIC_CHECKLIST = `Published-receipt intake checklist
===================================

For real receipts from a published dataset whose licence allows this use.
They are scored separately from consented receipts and never count toward
the readiness check: their owners did not agree to this test.

  1. ATTRIBUTION.txt names the dataset, its author, where it came from and its
     licence (CC BY 4.0 requires this).
  2. Put the images in images/ unchanged.
  3. One person types what they read on each receipt into transcription.csv.
     Type only what is printed; never copy a value from FinSight's own reading.

transcription.csv (one row per image to use):
  file      the image's name inside images/
  reviewer  your name or initials (the same on every row)
  vendor    store name as printed, or blank if none
  date      YYYY-MM-DD, or blank if none
  total     the printed total, e.g. 1250.50, or blank if none
  items     optional. Each item as  name | quantity | amount  separated by ";"
  notes     anything useful; not used for scoring

Then run:  npm run receipt-intake -- --public <this folder>
`;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function init(dir: string, files: Record<string, string>): number {
  mkdirSync(path.join(dir, "images"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (existsSync(target)) {
      console.log(`kept existing ${name}`);
      continue;
    }
    writeFileSync(target, content, { mode: 0o600 });
    console.log(`wrote ${name}`);
  }
  console.log(`\nNext: read ${path.join(dir, "CHECKLIST.txt")}`);
  return 0;
}

function folder(dir: string) {
  const imagesDir = path.join(dir, "images");
  return {
    imagesDir,
    read: (name: string) => {
      const file = path.join(dir, name);
      if (!existsSync(file)) throw new IntakeError(`missing ${name} (run with --init first)`);
      return parseCsv(readFileSync(file, "utf8"));
    },
    readImage: (file: string) => {
      const resolved = path.resolve(imagesDir, file);
      if (!resolved.startsWith(path.resolve(imagesDir) + path.sep)) throw new IntakeError(`${file} is outside images/`);
      if (!existsSync(resolved)) throw new IntakeError(`images/${file} does not exist`);
      return readFileSync(resolved);
    },
  };
}

function runPublic(dir: string): number {
  const { imagesDir, read, readImage } = folder(dir);
  const attributionFile = path.join(dir, "ATTRIBUTION.txt");
  const entries = buildPublicManifest({
    transcription: read("transcription.csv"),
    attribution: existsSync(attributionFile) ? readFileSync(attributionFile, "utf8") : "",
    readImage,
  });
  if (entries.length === 0) throw new IntakeError("transcription.csv has no rows");
  const manifest = path.join(dir, "ground-truth.json");
  writeFileSync(manifest, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  console.log(`wrote ${manifest}: ${entries.length} published receipts, one reviewer each.`);
  console.log("\nNext, from backend/ (local Tesseract only; scored apart from consented receipts):");
  console.log(`  npm run evaluate:receipt-scanner:local -- --corpus all --manifest "${manifest}" --images "${imagesDir}" --output "${path.join(dir, "local-result.json")}"`);
  return 0;
}

function run(dir: string): number {
  const { imagesDir, read, readImage } = folder(dir);
  const result = buildManifest({
    receipts: read("receipts.csv"),
    first: read("transcription-1.csv"),
    second: read("transcription-2.csv"),
    readImage,
  });

  const report = path.join(dir, "disagreements.txt");
  if (result.disagreements.length > 0) {
    writeFileSync(report, `${result.disagreements.join("\n")}\n`, { mode: 0o600 });
    console.error(`${result.disagreements.length} field(s) where the two reviewers disagree; see ${report}.`);
    console.error("Agree on the correct reading, fix both sheets, and run again. Nothing was written.");
    return 3;
  }
  if (result.entries.length === 0) throw new IntakeError("receipts.csv has no rows");

  const manifest = path.join(dir, "ground-truth.json");
  writeFileSync(manifest, `${JSON.stringify(result.entries, null, 2)}\n`, { mode: 0o600 });
  const holdout = result.entries.filter((entry) => (entry as { developmentCohort?: { partition?: string } }).developmentCohort?.partition === "HOLDOUT").length;
  console.log(`wrote ${manifest}: ${result.entries.length} receipts (${holdout} holdout).`);
  console.log("\nNext, from backend/:");
  console.log(`  npm run evaluate:receipt-scanner:readiness -- --manifest "${manifest}" --images "${imagesDir}" --output "${path.join(dir, "readiness.json")}"`);
  console.log(`  npm run evaluate:receipt-scanner:local -- --representative-ph-holdout --manifest "${manifest}" --images "${imagesDir}" --thresholds <reviewed budgets.json> --output "${path.join(dir, "holdout-result.json")}"`);
  return 0;
}

function main(): number {
  const initDir = argument("--init");
  const initPublicDir = argument("--init-public");
  const dir = argument("--dir");
  const publicDir = argument("--public");
  if (initDir) {
    return init(initDir, {
      "receipts.csv": toCsv(RECEIPT_COLUMNS),
      "transcription-1.csv": toCsv(TRANSCRIPTION_COLUMNS),
      "transcription-2.csv": toCsv(TRANSCRIPTION_COLUMNS),
      "CHECKLIST.txt": CHECKLIST,
    });
  }
  if (initPublicDir) {
    return init(initPublicDir, {
      "transcription.csv": toCsv(PUBLIC_TRANSCRIPTION_COLUMNS),
      "CHECKLIST.txt": PUBLIC_CHECKLIST,
    });
  }
  if (!dir && !publicDir) {
    console.error("usage: npm run receipt-intake -- --init <folder> | --dir <folder> | --init-public <folder> | --public <folder>");
    return 2;
  }
  try {
    return publicDir ? runPublic(publicDir) : run(dir!);
  } catch (error) {
    if (error instanceof IntakeError) {
      console.error(`intake: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = main();
