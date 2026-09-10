import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectReceiptCorners } from "../../src/lib/edgeDetection";
import { assessReceiptLikelihood } from "../../src/lib/receiptLikelihood";
import { extractReceipt, parseReceiptFields } from "../../src/services/ocr.service";
import { selectOcrCandidate } from "../../src/services/receiptScan/ocrCandidateSelection";
import { scoreAmount, scoreDate, scoreVendor } from "../ocr-accuracy/scoring";

interface Entry {
  id: string;
  file: string;
  processedFile?: string;
  /** Explicit provenance; historical fixtures with no record stay unknown. */
  captureSource?: "manual-camera" | "native-document-scanner" | "gallery";
  captureMode?: "standard" | "long";
  kind: "receipt" | "non-receipt";
  writing: "printed" | "handwritten" | "mixed" | "none";
  expectedDocumentCount: number;
  releaseGateEligible: boolean;
  sourceStatus: string;
  expected?: { date: string | null; vendor: string | null; amount: number | null };
}

const HERE = __dirname;
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8")) as Entry[];

function pct(n: number, d: number) {
  return d === 0 ? null : n / d;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

async function run(entry: Entry) {
  const file = resolve(HERE, entry.file);
  const buffer = readFileSync(file);
  const started = performance.now();
  const detection = await detectReceiptCorners(buffer);
  const detectionLatencyMs = performance.now() - started;
  const original = await extractReceipt(buffer);
  const processed = entry.processedFile
    ? await extractReceipt(readFileSync(resolve(HERE, entry.processedFile)))
    : null;
  const selected = selectOcrCandidate(original, processed);
  const likelihood = assessReceiptLikelihood({ rawText: selected.result.text, candidates: detection.candidates });
  const expected = entry.expected;
  const scoreFields = (text: string) => {
    if (!expected) return null;
    const parsed = parseReceiptFields(text);
    return {
      date: scoreDate(expected.date, parsed.date),
      vendor: scoreVendor(expected.vendor, parsed.vendor),
      amount: scoreAmount(expected.amount, parsed.amount),
    };
  };
  const originalFields = scoreFields(original.text);
  const processedFields = processed ? scoreFields(processed.text) : null;
  const fields = scoreFields(selected.result.text);
  const comparison = originalFields && processedFields ? {
    // +1 gains a correct field; -1 loses it; 0 keeps its correctness status.
    // Absent ground truth remains unmeasurable rather than a false success.
    date: originalFields.date === "n/a" ? null : Number(processedFields.date === "correct") - Number(originalFields.date === "correct"),
    vendor: originalFields.vendor === "n/a" ? null : Number(processedFields.vendor === "correct") - Number(originalFields.vendor === "correct"),
    amount: originalFields.amount === "n/a" ? null : Number(processedFields.amount === "correct") - Number(originalFields.amount === "correct"),
  } : null;
  return {
    id: entry.id,
    kind: entry.kind,
    writing: entry.writing,
    releaseGateEligible: entry.releaseGateEligible,
    sourceStatus: entry.sourceStatus,
    captureSource: entry.captureSource ?? "unknown",
    captureMode: entry.captureMode ?? "unknown",
    detectionLatencyMs,
    expectedDocumentCount: entry.expectedDocumentCount,
    actualDocumentCount: detection.candidates?.length ?? (detection.corners ? 1 : 0),
    likelihood,
    selectedSource: selected.source,
    fields,
    originalFields,
    processedFields,
    processedMinusOriginal: comparison,
  };
}

(async () => {
  const results = [];
  for (const entry of manifest) results.push(await run(entry));
  const eligible = results.filter((result) => result.releaseGateEligible);
  const receipts = eligible.filter((result) => result.kind === "receipt");
  const nonReceipts = eligible.filter((result) => result.kind === "non-receipt");
  const trueDocuments = receipts.filter((result) => result.actualDocumentCount > 0).length;
  const falseDocuments = nonReceipts.filter((result) => result.actualDocumentCount > 0).length;
  const metrics = {
    releaseGateEligibleSamples: eligible.length,
    documentPrecision: pct(trueDocuments, trueDocuments + falseDocuments),
    documentRecall: pct(trueDocuments, receipts.length),
    obviousNonReceiptFalseTriggerRate: pct(
      nonReceipts.filter((result) => result.likelihood.outcome !== "obvious-non-receipt").length,
      nonReceipts.length,
    ),
    multiReceiptCountAccuracy: pct(
      eligible.filter((result) => result.actualDocumentCount === result.expectedDocumentCount).length,
      eligible.length,
    ),
    handwrittenHardRejectRate: pct(
      receipts.filter((result) => result.writing !== "printed" && result.likelihood.outcome === "obvious-non-receipt").length,
      receipts.filter((result) => result.writing !== "printed").length,
    ),
    analysisLatencyP95Ms: percentile(results.map((result) => result.detectionLatencyMs), 0.95),
  };
  const summarize = (group: typeof results) => {
    const fieldDeltas = (field: "date" | "vendor" | "amount") => {
      const values = group.flatMap(result => {
        const value = result.processedMinusOriginal?.[field];
        return value == null ? [] : [value];
      });
      return {
        pairedScoredFields: values.length,
        improved: values.filter(value => value > 0).length,
        regressed: values.filter(value => value < 0).length,
        unchanged: values.filter(value => value === 0).length,
        accuracyDelta: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      };
    };
    return {
      samples: group.length,
      pairedSamples: group.filter(result => result.processedFields !== null).length,
      date: fieldDeltas("date"), vendor: fieldDeltas("vendor"), amount: fieldDeltas("amount"),
      /*
       * Where the candidate selector took the processed reading and that
       * reading lost a field the original had — the one failure mode the
       * selector exists to prevent, counted rather than argued about.
       */
      selectedWorseReading: group.filter(result =>
        result.selectedSource === "processed" &&
        Object.values(result.processedMinusOriginal ?? {}).some(value => value != null && value < 0)).length,
    };
  };
  const groupComparisons = (entries: typeof results) => Array.from(new Set(entries.map(result => `${result.captureSource}/${result.captureMode}`))).sort().map(key => ({
    group: key,
    ...summarize(entries.filter(result => `${result.captureSource}/${result.captureMode}` === key)),
  }));
  const captureComparison = {
    diagnosticAllSamples: groupComparisons(results),
    releaseGateEligibleOnly: groupComparisons(eligible),
  };
  writeFileSync(join(HERE, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), metrics, captureComparison, results }, null, 2) + "\n");

  const format = (value: number | null) => value === null ? "Not measurable" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Receipt scanner evaluation",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Samples run: **${results.length}**; release-gate-eligible: **${eligible.length}**.`,
    "",
    eligible.length === 0
      ? "> No sample is currently marked release-gate-eligible. These results exercise the harness but do not validate production thresholds."
      : "Release metrics below include only reviewed, consented samples marked eligible.",
    "",
    "| Metric | Result |",
    "|---|---:|",
    `| Document precision | ${format(metrics.documentPrecision)} |`,
    `| Document recall | ${format(metrics.documentRecall)} |`,
    `| Obvious non-receipt false-trigger rate | ${format(metrics.obviousNonReceiptFalseTriggerRate)} |`,
    `| Multi-receipt count accuracy | ${format(metrics.multiReceiptCountAccuracy)} |`,
    `| Handwritten hard-reject rate | ${format(metrics.handwrittenHardRejectRate)} |`,
    `| Detector latency p95 | ${metrics.analysisLatencyP95Ms?.toFixed(1) ?? "Not measurable"} ms |`,
    "",
    "## Original versus processed capture diagnostics",
    "",
    "These groups include all fixtures for debugging and are not release-gate evidence. Unknown provenance is never inferred from filenames. Deltas compare the same image pair against the same ground truth; positive values gain correct fields and negative values lose them. Missing pairs or ground truth are not measurable.",
    "",
    "| Capture source / mode | Samples | Paired samples | Date delta | Vendor delta | Amount delta |",
    "|---|---:|---:|---:|---:|---:|",
    ...captureComparison.diagnosticAllSamples.map(group => {
      const delta = (value: number | null) => value === null ? "Not measurable" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
      return `| ${group.group} | ${group.samples} | ${group.pairedSamples} | ${delta(group.date.accuracyDelta)} | ${delta(group.vendor.accuracyDelta)} | ${delta(group.amount.accuracyDelta)} |`;
    }),
    "",
    "Set optional `captureSource` and `captureMode` only from recorded capture provenance, and `processedFile` to the corresponding corrected image. JSON includes per-field gains/regressions and a separate eligible-only breakdown. No receipt text or images are included in the report.",
    "",
    "Add consented samples to `manifest.json`, verify ground truth independently, then set `releaseGateEligible` to true.",
  ];
  writeFileSync(join(HERE, "REPORT.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
