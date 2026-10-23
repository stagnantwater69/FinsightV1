import { createHash } from "node:crypto";
import { COHORT_TAGS } from "./policy-v1-contract";
import { localCorpusEntrySchema, type LocalCorpusEntry } from "./local-corpus-contract";

/*
 * Turns a real-receipt collection into the private manifest the readiness
 * check and the representative-holdout evaluation read (see README.md,
 * "Check representative Philippine receipt evidence").
 *
 * People fill in three spreadsheets instead of hand-writing JSON:
 *
 *   receipts.csv         one row per redacted image: its group, template,
 *                        partition, tags, capture conditions and the consent
 *                        and redaction-review answers.
 *   transcription-1.csv  what reviewer 1 reads on each receipt, typed
 *   transcription-2.csv  independently by reviewer 2.
 *
 * Every field the two reviewers disagree on is reported, and nothing is
 * written until they agree: the evaluator's ground truth must be the
 * reconciled reading, never one person's. Opaque IDs are derived by hashing
 * the labels people typed, so the manifest carries no names.
 */

export const RECEIPT_COLUMNS = [
  "file", "receipt_group", "vendor_template", "partition", "cohort_tags", "language_tags",
  "jurisdiction", "lighting", "perspective", "page_count", "handwriting", "print_quality",
  "consent_recorded", "redaction_reviewed", "notes",
] as const;

export const TRANSCRIPTION_COLUMNS = ["file", "reviewer", "vendor", "date", "total", "items"] as const;
export const PUBLIC_TRANSCRIPTION_COLUMNS = [...TRANSCRIPTION_COLUMNS, "notes"] as const;

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  const keys = header.map((cell) => cell.trim().toLowerCase());
  return body.map((cells) => Object.fromEntries(keys.map((key, index) => [key, (cells[index] ?? "").trim()])));
}

export function toCsv(columns: readonly string[], rows: Record<string, string>[] = []): string {
  const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column] ?? "")).join(","))].join("\n") + "\n";
}

/** A stable opaque ID for a label someone typed: no names reach the manifest. */
export function opaqueId(prefix: string, label: string): string {
  return `${prefix}_${createHash("sha256").update(label.trim().toLowerCase()).digest("hex").slice(0, 20)}`;
}

export interface TranscribedItem {
  name: string;
  quantity: number | null;
  amount: number;
}

export interface Transcription {
  vendor: string | null;
  date: string | null;
  total: number | null;
  items: TranscribedItem[] | null;
}

export class IntakeError extends Error {}

function money(value: string, where: string): number {
  const cleaned = value.replace(/[₱,\s]|PHP/gi, "");
  const amount = Number(cleaned);
  if (cleaned === "" || !Number.isFinite(amount)) throw new IntakeError(`${where}: "${value}" is not an amount`);
  return Math.round(amount * 100) / 100;
}

/** `name | quantity | amount` per item, items separated by ";" or new lines. Blank means "not transcribed". */
export function parseItems(value: string, where: string): TranscribedItem[] | null {
  if (value.trim() === "") return null;
  return value.split(/;|\n/).map((part) => part.trim()).filter(Boolean).map((part, index) => {
    const pieces = part.split("|").map((piece) => piece.trim());
    if (pieces.length !== 3 || !pieces[0]) {
      throw new IntakeError(`${where}, item ${index + 1}: write it as "name | quantity | amount" (quantity may be blank)`);
    }
    return {
      name: pieces[0],
      quantity: pieces[1] === "" ? null : money(pieces[1]!, `${where}, item ${index + 1} quantity`),
      amount: money(pieces[2]!, `${where}, item ${index + 1} amount`),
    };
  });
}

export function parseTranscription(row: Record<string, string>, where: string): Transcription {
  const date = row.date ?? "";
  if (date !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new IntakeError(`${where}: date "${date}" must be YYYY-MM-DD, or blank when the receipt has none`);
  }
  return {
    vendor: row.vendor ? row.vendor : null,
    date: date || null,
    total: row.total ? money(row.total, `${where} total`) : null,
    items: parseItems(row.items ?? "", where),
  };
}

const normalizeText = (value: string | null) => value?.replace(/\s+/g, " ").trim().toLowerCase() ?? null;

/** Every field the two readings differ on, as human-readable lines. */
export function disagreements(first: Transcription, second: Transcription): string[] {
  const out: string[] = [];
  if (normalizeText(first.vendor) !== normalizeText(second.vendor)) out.push(`vendor: "${first.vendor ?? ""}" vs "${second.vendor ?? ""}"`);
  if (first.date !== second.date) out.push(`date: ${first.date ?? "(none)"} vs ${second.date ?? "(none)"}`);
  if (first.total !== second.total) out.push(`total: ${first.total ?? "(none)"} vs ${second.total ?? "(none)"}`);
  const a = first.items;
  const b = second.items;
  if ((a === null) !== (b === null)) {
    out.push(`items: only one reviewer transcribed them`);
  } else if (a && b) {
    if (a.length !== b.length) out.push(`items: ${a.length} lines vs ${b.length} lines`);
    a.slice(0, Math.min(a.length, b.length)).forEach((item, index) => {
      const other = b[index]!;
      if (normalizeText(item.name) !== normalizeText(other.name) || item.quantity !== other.quantity || item.amount !== other.amount) {
        out.push(`item ${index + 1}: "${item.name} | ${item.quantity ?? ""} | ${item.amount}" vs "${other.name} | ${other.quantity ?? ""} | ${other.amount}"`);
      }
    });
  }
  return out;
}

function yes(value: string | undefined): boolean {
  return /^(y|yes|true|1)$/i.test(value?.trim() ?? "");
}

function tagList<T extends string>(value: string, allowed: readonly T[], where: string): T[] {
  const tags = value.split(/[;|]/).map((tag) => tag.trim().toUpperCase()).filter(Boolean);
  for (const tag of tags) {
    if (!allowed.includes(tag as T)) throw new IntakeError(`${where}: "${tag}" is not one of ${allowed.join(", ")}`);
  }
  if (tags.length === 0) throw new IntakeError(`${where}: give at least one of ${allowed.join(", ")}`);
  return [...new Set(tags)] as T[];
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], where: string): T {
  const upper = (value ?? "").trim().toUpperCase() || "UNKNOWN";
  if (!allowed.includes(upper as T)) throw new IntakeError(`${where}: "${value}" is not one of ${allowed.join(", ")}`);
  return upper as T;
}

export interface IntakeInput {
  receipts: Record<string, string>[];
  first: Record<string, string>[];
  second: Record<string, string>[];
  /** Reads a redacted image's bytes by its `file` path, relative to the image folder. */
  readImage: (file: string) => Buffer;
}

export interface IntakeResult {
  entries: LocalCorpusEntry[];
  /** One line per field the reviewers disagree on, prefixed with the file. */
  disagreements: string[];
}

export function buildManifest({ receipts, first, second, readImage }: IntakeInput): IntakeResult {
  const byFile = (rows: Record<string, string>[], sheet: string) => {
    const map = new Map<string, Record<string, string>>();
    for (const row of rows) {
      if (!row.file) throw new IntakeError(`${sheet}: a row has no file`);
      if (map.has(row.file)) throw new IntakeError(`${sheet}: ${row.file} appears twice`);
      map.set(row.file, row);
    }
    return map;
  };
  const firstByFile = byFile(first, "transcription-1.csv");
  const secondByFile = byFile(second, "transcription-2.csv");
  byFile(receipts, "receipts.csv");

  const reviewerOf = (rows: Record<string, string>[], sheet: string) => {
    const names = new Set(rows.map((row) => row.reviewer?.trim().toLowerCase()).filter(Boolean));
    if (names.size !== 1) throw new IntakeError(`${sheet}: every row needs the same reviewer name`);
    return [...names][0]!;
  };
  const reviewer1 = reviewerOf(first, "transcription-1.csv");
  const reviewer2 = reviewerOf(second, "transcription-2.csv");
  if (reviewer1 === reviewer2) throw new IntakeError("the two transcriptions must come from two different people");

  const entries: LocalCorpusEntry[] = [];
  const conflicts: string[] = [];
  const seenHashes = new Map<string, string>();

  for (const row of receipts) {
    const file = row.file ?? "";
    const where = `receipts.csv, ${file}`;
    if (!yes(row.consent_recorded)) throw new IntakeError(`${where}: consent_recorded must be "yes" before a receipt can be used`);
    if (!yes(row.redaction_reviewed)) throw new IntakeError(`${where}: redaction_reviewed must be "yes" (a person checked the redaction)`);
    const a = firstByFile.get(file);
    const b = secondByFile.get(file);
    if (!a || !b) throw new IntakeError(`${where}: missing from ${!a ? "transcription-1.csv" : "transcription-2.csv"}`);

    const readingA = parseTranscription(a, `transcription-1.csv, ${row.file}`);
    const readingB = parseTranscription(b, `transcription-2.csv, ${row.file}`);
    const differences = disagreements(readingA, readingB);
    conflicts.push(...differences.map((line) => `${row.file}: ${line}`));

    const bytes = readImage(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const duplicate = seenHashes.get(sha);
    if (duplicate) throw new IntakeError(`${where}: same image bytes as ${duplicate}`);
    seenHashes.set(sha, file);

    const pageCountText = row.page_count?.trim() ?? "";
    const pageCount = pageCountText === "" ? null : Number(pageCountText);
    if (pageCount !== null && !(Number.isInteger(pageCount) && pageCount > 0)) {
      throw new IntakeError(`${where}: page_count must be a whole number or blank`);
    }
    if (!row.receipt_group || !row.vendor_template) throw new IntakeError(`${where}: receipt_group and vendor_template are required`);

    const entry = {
      id: `real_${sha.slice(0, 24)}`,
      file,
      kind: "real" as const,
      conditions: row.notes ?? "",
      needs_review: differences.length > 0,
      provenance: {
        label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED" as const,
        consentRecorded: true as const,
        anonymizationReviewed: true as const,
        groundTruthReviewerCount: 2,
      },
      developmentCohort: {
        receiptGroupId: opaqueId("grp", row.receipt_group),
        vendorTemplateId: opaqueId("tpl", row.vendor_template),
        sourceSha256: sha,
        partition: oneOf(row.partition, ["CALIBRATION", "HOLDOUT"] as const, `${where} partition`),
        cohortTags: tagList(row.cohort_tags ?? "", COHORT_TAGS, `${where} cohort_tags`),
        languageTags: tagList(row.language_tags ?? "", ["ENGLISH", "FILIPINO", "MIXED", "OTHER"] as const, `${where} language_tags`),
        reviewerIds: [opaqueId("rev", reviewer1), opaqueId("rev", reviewer2)] as [string, string],
        captureConditions: {
          jurisdiction: oneOf(row.jurisdiction, ["PH", "OTHER", "UNKNOWN"] as const, `${where} jurisdiction`),
          lighting: oneOf(row.lighting, ["NORMAL", "LOW_LIGHT", "UNKNOWN"] as const, `${where} lighting`),
          perspective: oneOf(row.perspective, ["FRONTAL", "SKEWED", "UNKNOWN"] as const, `${where} perspective`),
          pageCount,
          handwriting: oneOf(row.handwriting, ["PRINTED", "HANDWRITTEN_OR_ANNOTATED", "UNKNOWN"] as const, `${where} handwriting`),
          printQuality: oneOf(row.print_quality, ["CLEAR", "FADED_OR_STRESSED", "UNKNOWN"] as const, `${where} print_quality`),
        },
      },
      expected: { vendor: readingA.vendor, date: readingA.date, amount: readingA.total, items: readingA.items },
    };
    const parsed = localCorpusEntrySchema.safeParse(entry);
    if (!parsed.success) throw new IntakeError(`${where}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    entries.push(parsed.data);
  }

  for (const file of [...firstByFile.keys(), ...secondByFile.keys()]) {
    if (!receipts.some((row) => row.file === file)) throw new IntakeError(`${file} is transcribed but not listed in receipts.csv`);
  }
  return { entries, disagreements: conflicts };
}

export interface PublicIntakeInput {
  /** One person's reading of each image; the sheet also lists the images. */
  transcription: Record<string, string>[];
  /** Where the images come from and under which licence, as the licence requires. */
  attribution: string;
  readImage: (file: string) => Buffer;
}

/*
 * Real receipts from a published, licensed dataset rather than from owners
 * who agreed to this test. They are labelled PUBLIC_LICENSED_REAL_SINGLE_REVIEW
 * and carry no development cohort, so the evaluator scores them separately
 * and the readiness check keeps excluding them: only consented,
 * double-reviewed receipts can support a representative claim.
 */
export function buildPublicManifest({ transcription, attribution, readImage }: PublicIntakeInput): LocalCorpusEntry[] {
  if (attribution.trim() === "") throw new IntakeError("ATTRIBUTION.txt must name the dataset, its author and its licence");
  const names = new Set(transcription.map((row) => row.reviewer?.trim().toLowerCase()).filter(Boolean));
  if (names.size !== 1) throw new IntakeError("transcription.csv: every row needs the same reviewer name");

  const entries: LocalCorpusEntry[] = [];
  const seenFiles = new Set<string>();
  const seenHashes = new Map<string, string>();
  for (const row of transcription) {
    const file = row.file ?? "";
    const where = `transcription.csv, ${file}`;
    if (!file) throw new IntakeError("transcription.csv: a row has no file");
    if (seenFiles.has(file)) throw new IntakeError(`transcription.csv: ${file} appears twice`);
    seenFiles.add(file);
    const reading = parseTranscription(row, where);
    if (reading.vendor === null && reading.date === null && reading.total === null) {
      throw new IntakeError(`${where}: nothing typed; remove the row or fill in what the receipt shows`);
    }

    const bytes = readImage(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const duplicate = seenHashes.get(sha);
    if (duplicate) throw new IntakeError(`${where}: same image bytes as ${duplicate}`);
    seenHashes.set(sha, file);

    const parsed = localCorpusEntrySchema.safeParse({
      id: `public_${sha.slice(0, 24)}`,
      file,
      kind: "real",
      conditions: row.notes ?? "",
      needs_review: false,
      provenance: {
        label: "PUBLIC_LICENSED_REAL_SINGLE_REVIEW",
        sourceAttributionRecorded: true,
        licenseAttributionRecorded: true,
        groundTruthReviewerCount: 1,
      },
      expected: { vendor: reading.vendor, date: reading.date, amount: reading.total, items: reading.items },
    });
    if (!parsed.success) throw new IntakeError(`${where}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    entries.push(parsed.data);
  }
  return entries;
}
