import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validateDevelopmentCohort, type DevelopmentPartition } from "./development-cohort";
import { buildReadinessReport, CohortReadinessError, representativeEntries, verifyDeclaredImages } from "./cohort-readiness";
import { extractText, shutdownOcr } from "../../src/services/ocr.service";
import {
  buildLocalQualityReport,
  entriesForScope,
  evaluateEntry,
  localCorpusEntrySchema,
  localQualityThresholdsSchema,
  type LocalQualityReport,
} from "./local-quality-gate";

const HERE = __dirname;
const DEFAULT_MANIFEST = resolve(HERE, "../ocr-accuracy/ground-truth.json");
const DEFAULT_IMAGES = resolve(HERE, "../ocr-accuracy/images");
const DEFAULT_THRESHOLDS = join(HERE, "local-quality-thresholds.json");
const DEFAULT_OUTPUT = join(HERE, "local-quality-results.json");

interface Arguments {
  scope: LocalQualityReport["corpus"]["requestedScope"];
  manifestPath: string;
  imageRoot: string;
  thresholdsPath: string;
  outputPath: string;
  partition: DevelopmentPartition | "ALL";
  representativePhHoldout: boolean;
}

const USAGE = `Usage:
  npm run evaluate:receipt-scanner:local -- [options]

Options:
  --corpus synthetic|all|anonymized-real  Corpus to execute (default: synthetic)
  --partition all|calibration|holdout      Declared development cohort (default: all)
  --representative-ph-holdout              Only explicitly declared consented PH holdout
  --manifest PATH                         Ground-truth JSON (default: existing OCR corpus)
  --images PATH                           Image directory (default: existing OCR corpus images)
  --thresholds PATH                       Gate budget JSON
  --output PATH                           Aggregate machine-readable JSON output
  --help                                  Show this help

The command runs bundled local Tesseract only. It never calls Gemini, Veryfi,
OpenRouter, Azure, or another external OCR provider.`;

function absolutePath(value: string, flag: string): string {
  if (!value) throw new Error(`${flag} requires a path`);
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function parseArgs(argv: string[]): Arguments | "help" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const parsed: Arguments = {
    scope: "synthetic",
    manifestPath: DEFAULT_MANIFEST,
    imageRoot: DEFAULT_IMAGES,
    thresholdsPath: DEFAULT_THRESHOLDS,
    outputPath: DEFAULT_OUTPUT,
    partition: "ALL",
    representativePhHoldout: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--representative-ph-holdout") {
      parsed.representativePhHoldout = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--corpus") {
      if (value !== "synthetic" && value !== "all" && value !== "anonymized-real") {
        throw new Error("--corpus must be synthetic, all, or anonymized-real");
      }
      parsed.scope = value;
    } else if (flag === "--partition") {
      if (value !== "all" && value !== "calibration" && value !== "holdout") {
        throw new Error("--partition must be all, calibration, or holdout");
      }
      parsed.partition = value.toUpperCase() as Arguments["partition"];
    } else if (flag === "--manifest") parsed.manifestPath = absolutePath(value ?? "", flag);
    else if (flag === "--images") parsed.imageRoot = absolutePath(value ?? "", flag);
    else if (flag === "--thresholds") parsed.thresholdsPath = absolutePath(value ?? "", flag);
    else if (flag === "--output") parsed.outputPath = absolutePath(value ?? "", flag);
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  if (parsed.representativePhHoldout) { parsed.scope = "anonymized-real"; parsed.partition = "HOLDOUT"; }
  return parsed;
}

function formatPercent(value: number | null): string {
  return value === null ? "not measured" : `${(value * 100).toFixed(1)}%`;
}

export async function runLocalQualityGate(argv: string[]): Promise<number> {
  let args: Arguments | "help";
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments"}\n\n${USAGE}\n`);
    return 2;
  }
  if (args === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const allEntries = localCorpusEntrySchema.array().parse(JSON.parse(readFileSync(args.manifestPath, "utf8")));
    validateDevelopmentCohort(allEntries);
    const thresholds = localQualityThresholdsSchema.parse(JSON.parse(readFileSync(args.thresholdsPath, "utf8")));
    const reviewedEntries = allEntries.filter((entry) => !entry.needs_review);
    const readiness = args.representativePhHoldout ? buildReadinessReport(allEntries) : undefined;
    const attemptedEntries = args.representativePhHoldout ? representativeEntries(allEntries)
      : entriesForScope(reviewedEntries, args.scope).filter((entry) => args.partition === "ALL" || entry.developmentCohort?.partition === args.partition);
    if (!args.representativePhHoldout && args.partition !== "ALL" && attemptedEntries.length === 0) {
      throw new Error("Requested development partition has no eligible samples; holdout evidence is unavailable.");
    }
    if (args.representativePhHoldout && attemptedEntries.length > 0 && (
      thresholds.profile.includedProvenance.length !== 1
      || thresholds.profile.includedProvenance[0] !== "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED"
    )) throw new CohortReadinessError("REPRESENTATIVE_THRESHOLD_PROFILE_INVALID", "Representative evaluation requires a separately reviewed consented-real threshold profile.");
    const missing = attemptedEntries.filter((entry) => !existsSync(resolve(args.imageRoot, entry.file)));
    if (missing.length > 0) {
      throw new Error(`${missing.length} corpus image(s) are missing. Restore them locally or regenerate the synthetic corpus before running the gate.`);
    }
    verifyDeclaredImages(allEntries, args.imageRoot);

    const observations = [];
    for (const [index, entry] of attemptedEntries.entries()) {
      process.stdout.write(`OCR sample ${index + 1}/${attemptedEntries.length} ... `);
      const observation = await evaluateEntry(entry, args.imageRoot, extractText);
      observations.push(observation);
      process.stdout.write(`${observation.outcome.toLowerCase()} ${observation.latencyMs.toFixed(0)} ms\n`);
    }
    const report = buildLocalQualityReport({
      allEntries,
      attemptedEntries,
      observations,
      thresholds,
      requestedScope: args.scope,
      requestedPartition: args.partition,
      representativeReadiness: readiness,
    });
    mkdirSync(dirname(args.outputPath), { recursive: true });
    writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: args.representativePhHoldout ? "wx" : "w" });
    chmodSync(args.outputPath, 0o600);

    process.stdout.write([
      `Gate: ${report.gate.status}`,
      `Samples: ${report.metrics.samples}; failures: ${report.metrics.failures}`,
      `Accuracy: vendor ${formatPercent(report.metrics.accuracy.vendor.value)}, date ${formatPercent(report.metrics.accuracy.date.value)}, total ${formatPercent(report.metrics.accuracy.total.value)}, items ${formatPercent(report.metrics.accuracy.items.value)}`,
      `Latency: p50 ${report.metrics.latencyMs.p50?.toFixed(0) ?? "not measured"} ms; p95 ${report.metrics.latencyMs.p95?.toFixed(0) ?? "not measured"} ms`,
      `Anonymized real evidence: ${report.corpus.anonymizedRealEvidence}`,
      ...(readiness ? [`Representative evidence: ${readiness.status}; ${readiness.counts.eligibleSamples} eligible, ${readiness.counts.excludedSamples} excluded of ${readiness.counts.totalManifestEntries}`] : []),
      `Report: ${args.outputPath}`,
    ].join("\n") + "\n");
    if (readiness && readiness.status !== "READY_FOR_LOCAL_EVALUATION") return 3;
    return report.gate.status === "PASS" ? 0 : 1;
  } catch (error) {
    if (args.representativePhHoldout) {
      const code = error instanceof CohortReadinessError ? error.code : "REPRESENTATIVE_INPUT_OR_OUTPUT_INVALID";
      process.stderr.write(`${code}: Representative evaluation stopped without an accuracy claim.\n`);
    } else process.stderr.write(`LOCAL_OCR_GATE_FAILED: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    return 2;
  } finally {
    await shutdownOcr();
  }
}

if (require.main === module) {
  runLocalQualityGate(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
