import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  buildPublicManifest,
  disagreements,
  IntakeError,
  parseCsv,
  parseItems,
  toCsv,
} from "../receipt-scanner-evaluation/receipt-intake";
import { localCorpusEntrySchema } from "../receipt-scanner-evaluation/local-corpus-contract";
import { validateDevelopmentCohort } from "../receipt-scanner-evaluation/development-cohort";
import { representativeExclusion } from "../receipt-scanner-evaluation/cohort-readiness";

const IMAGES: Record<string, Buffer> = {
  "r001.jpg": Buffer.from("redacted receipt one"),
  "r002.jpg": Buffer.from("redacted receipt two"),
};

function receiptRow(file: string, overrides: Record<string, string> = {}) {
  return {
    file,
    receipt_group: `paper-${file}`,
    vendor_template: "sari-sari-store-a",
    partition: "HOLDOUT",
    cohort_tags: "CLEAN_PRINTED; FILIPINO_OR_MIXED_LANGUAGE",
    language_tags: "MIXED",
    jurisdiction: "PH",
    lighting: "LOW_LIGHT",
    perspective: "",
    page_count: "1",
    handwriting: "PRINTED",
    print_quality: "FADED_OR_STRESSED",
    consent_recorded: "yes",
    redaction_reviewed: "yes",
    notes: "",
    ...overrides,
  };
}

function transcription(reviewer: string, file: string, overrides: Record<string, string> = {}) {
  return {
    file,
    reviewer,
    vendor: "Aling Nena Store",
    date: "2026-10-01",
    total: "₱1,250.50",
    items: "Rice 5kg | 1 | 320; Eggs | 12 | 96",
    ...overrides,
  };
}

const input = (overrides: Partial<Parameters<typeof buildManifest>[0]> = {}) => ({
  receipts: [receiptRow("r001.jpg"), receiptRow("r002.jpg")],
  first: [transcription("Ana", "r001.jpg"), transcription("Ana", "r002.jpg")],
  second: [transcription("Ben", "r001.jpg"), transcription("Ben", "r002.jpg")],
  readImage: (file: string) => IMAGES[file]!,
  ...overrides,
});

describe("receipt intake", () => {
  it("writes entries the evaluator's own schema and cohort validation accept", () => {
    const { entries, disagreements: conflicts } = buildManifest(input());
    expect(conflicts).toEqual([]);
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(localCorpusEntrySchema.safeParse(entry).success).toBe(true);
    expect(() => validateDevelopmentCohort(entries)).not.toThrow();

    const [first] = entries as Array<Record<string, any>>;
    expect(first!.expected).toEqual({
      vendor: "Aling Nena Store",
      date: "2026-10-01",
      amount: 1250.5,
      items: [
        { name: "Rice 5kg", quantity: 1, amount: 320 },
        { name: "Eggs", quantity: 12, amount: 96 },
      ],
    });
    expect(first!.needs_review).toBe(false);
    expect(first!.developmentCohort.sourceSha256).toBe(createHash("sha256").update(IMAGES["r001.jpg"]!).digest("hex"));
    expect(first!.developmentCohort.captureConditions).toMatchObject({ lighting: "LOW_LIGHT", perspective: "UNKNOWN", pageCount: 1 });
  });

  it("carries no reviewer, store or group names into the manifest", () => {
    const text = JSON.stringify(buildManifest(input()).entries);
    for (const name of ["Ana", "Ben", "sari-sari-store-a", "paper-r001"]) expect(text).not.toContain(name);
  });

  it("reports every field the reviewers disagree on", () => {
    const { disagreements: conflicts } = buildManifest(input({
      second: [
        transcription("Ben", "r001.jpg", { total: "1205.50", date: "2026-10-02" }),
        transcription("Ben", "r002.jpg", { items: "Rice 5kg | 1 | 320" }),
      ],
    }));
    expect(conflicts).toEqual([
      "r001.jpg: date: 2026-10-01 vs 2026-10-02",
      "r001.jpg: total: 1250.5 vs 1205.5",
      "r002.jpg: items: 2 lines vs 1 lines",
    ]);
  });

  it("treats spacing and letter case in names as the same reading", () => {
    const a = { vendor: "Aling  Nena Store", date: null, total: 10, items: null };
    const b = { vendor: "aling nena store", date: null, total: 10, items: null };
    expect(disagreements(a, b)).toEqual([]);
  });

  it("refuses a receipt without recorded consent or a reviewed redaction", () => {
    expect(() => buildManifest(input({ receipts: [receiptRow("r001.jpg", { consent_recorded: "no" })] }))).toThrow(/consent/);
    expect(() => buildManifest(input({ receipts: [receiptRow("r001.jpg", { redaction_reviewed: "" })] }))).toThrow(/redaction/);
  });

  it("refuses one person transcribing twice, duplicate images and unknown tags", () => {
    expect(() => buildManifest(input({ second: [transcription("ana", "r001.jpg"), transcription("ana", "r002.jpg")] })))
      .toThrow(/two different people/);
    expect(() => buildManifest(input({ readImage: () => Buffer.from("same bytes") }))).toThrow(/same image bytes/);
    expect(() => buildManifest(input({ receipts: [receiptRow("r001.jpg", { cohort_tags: "BLURRY" })] }))).toThrow(IntakeError);
  });

  it("parses quoted CSV and writes it back", () => {
    const csv = toCsv(["file", "items"], [{ file: "r1.jpg", items: 'Coke, "Mismo" | 2 | 40' }]);
    expect(parseCsv(csv)).toEqual([{ file: "r1.jpg", items: 'Coke, "Mismo" | 2 | 40' }]);
    expect(parseCsv("﻿file,total\r\nr1.jpg,10\r\n")).toEqual([{ file: "r1.jpg", total: "10" }]);
  });

  it("reads item lines with a blank quantity and rejects malformed ones", () => {
    expect(parseItems("Service charge |  | 25", "x")).toEqual([{ name: "Service charge", quantity: null, amount: 25 }]);
    expect(parseItems("", "x")).toBeNull();
    expect(() => parseItems("Rice 320", "x")).toThrow(/name \| quantity \| amount/);
  });
});

describe("published receipt intake", () => {
  const publicInput = (overrides: Partial<Parameters<typeof buildPublicManifest>[0]> = {}) => ({
    transcription: [transcription("Ana", "r001.jpg"), transcription("Ana", "r002.jpg", { items: "" })],
    attribution: "Receipts dataset, Roboflow Universe, CC BY 4.0",
    readImage: (file: string) => IMAGES[file]!,
    ...overrides,
  });

  it("labels them public single-review so readiness keeps excluding them", () => {
    const entries = buildPublicManifest(publicInput());
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(localCorpusEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.provenance).toEqual({
        label: "PUBLIC_LICENSED_REAL_SINGLE_REVIEW",
        sourceAttributionRecorded: true,
        licenseAttributionRecorded: true,
        groundTruthReviewerCount: 1,
      });
      expect(entry.developmentCohort).toBeUndefined();
      expect(representativeExclusion(entry)).toBe("PUBLIC_SINGLE_REVIEW");
    }
    expect(() => validateDevelopmentCohort(entries)).not.toThrow();
    expect(entries[0]!.expected).toMatchObject({ vendor: "Aling Nena Store", date: "2026-10-01", amount: 1250.5 });
    expect(entries[1]!.expected.items).toBeNull();
    expect(JSON.stringify(entries)).not.toContain("Ana");
  });

  it("refuses missing attribution, mixed reviewers, empty readings and repeated images", () => {
    expect(() => buildPublicManifest(publicInput({ attribution: "  " }))).toThrow(/ATTRIBUTION/);
    expect(() => buildPublicManifest(publicInput({
      transcription: [transcription("Ana", "r001.jpg"), transcription("Ben", "r002.jpg")],
    }))).toThrow(/same reviewer/);
    expect(() => buildPublicManifest(publicInput({
      transcription: [transcription("Ana", "r001.jpg", { vendor: "", date: "", total: "", items: "" })],
    }))).toThrow(/nothing typed/);
    expect(() => buildPublicManifest(publicInput({ readImage: () => Buffer.from("same bytes") }))).toThrow(/same image bytes/);
  });
});
