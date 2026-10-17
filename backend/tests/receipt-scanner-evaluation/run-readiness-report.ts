import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildReadinessReport, CohortReadinessError, readinessExitCode, verifyDeclaredImages } from "./cohort-readiness";
import { localCorpusEntrySchema } from "./local-corpus-contract";

const USAGE = `Usage:
  npm run evaluate:receipt-scanner:readiness -- --output /private/readiness.json [options]

Options:
  --manifest PATH  Ground-truth JSON (default: existing OCR corpus)
  --images PATH    Image directory (default: existing corpus images)
  --output PATH    New aggregate JSON file; existing files are never overwritten
  --help           Show this help

This command imports no OCR or provider service and scores no images.
Exit 0: metadata coverage ready for local evaluation; 3: blocked evidence;
2: invalid input, integrity failure, or report could not be written.
Readiness never establishes receipt accuracy or verifies human consent/review.`;

interface ReadinessArguments { manifest: string; images: string; output: string }

export function parseReadinessArguments(argv: string[]): ReadinessArguments | "help" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const parsed: Partial<ReadinessArguments> = {
    manifest: resolve(__dirname, "../ocr-accuracy/ground-truth.json"),
    images: resolve(__dirname, "../ocr-accuracy/images"),
  };
  const seen = new Set<string>();
  const flags = new Map<string, keyof ReadinessArguments>([["--manifest", "manifest"], ["--images", "images"], ["--output", "output"]]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const key = flags.get(flag);
    const value = argv[index + 1];
    if (!key || seen.has(flag) || !value || value.startsWith("--")) throw new Error("Invalid readiness arguments");
    seen.add(flag);
    parsed[key] = isAbsolute(value) ? value : resolve(process.cwd(), value);
  }
  if (!parsed.output) throw new Error("An output path is required");
  return parsed as ReadinessArguments;
}

export function runReadinessReport(argv: string[]): number {
  try {
    const args = parseReadinessArguments(argv);
    if (args === "help") { process.stdout.write(`${USAGE}\n`); return 0; }
    const entries = localCorpusEntrySchema.array().parse(JSON.parse(readFileSync(args.manifest, "utf8")));
    verifyDeclaredImages(entries, args.images);
    const report = buildReadinessReport(entries);
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${report.status}: ${report.counts.eligibleSamples} eligible / ${report.counts.excludedSamples} excluded / ${report.counts.totalManifestEntries} total. Accuracy NOT_MEASURED. Aggregate report written.\n`);
    return readinessExitCode(report);
  } catch (error) {
    const code = error instanceof CohortReadinessError ? error.code : "READINESS_INPUT_OR_OUTPUT_INVALID";
    process.stderr.write(`${code}: Readiness stopped without an accuracy claim.\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = runReadinessReport(process.argv.slice(2));
