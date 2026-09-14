import { resolve } from "node:path";
import { ZodError } from "zod";
import { buildPolicyV1Report, reportSummary, writePolicyV1Report } from "./policy-v1-report";
import { EvaluationInputError, EvaluationPaths, loadAndValidateInputs } from "./policy-v1-validation";

const USAGE = `Usage:
  npm run evaluate:receipt-scanner:policy-v1 -- \\
    --manifest /external/intake.csv \\
    --pairs /external/pairs.csv \\
    --artifact-map /external/artifact-map.json \\
    --seal /external/seal.json \\
    --ground-truth-bundle /external/ground-truth.bundle \\
    --results /external/scored-results.json \\
    --output /external/aggregate-report.json

Policy-v1 accepts LOCAL_TESSERACT results only. Cloud and other provider results
require a new sealed evidence contract; this command never calls an OCR provider.`;

const VALUE_FLAGS: Map<string, keyof EvaluationPaths> = new Map([
  ["--manifest", "manifestPath"],
  ["--pairs", "pairLabelsPath"],
  ["--artifact-map", "artifactMapPath"],
  ["--seal", "sealPath"],
  ["--ground-truth-bundle", "groundTruthBundlePath"],
  ["--results", "resultsPath"],
  ["--output", "outputPath"],
]);

export function parsePolicyV1Args(argv: string[]): EvaluationPaths | "help" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const values: Partial<Record<keyof EvaluationPaths, string>> = {
    repositoryRoot: resolve(__dirname, "../../.."),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const key = VALUE_FLAGS.get(argument);
    if (!key) throw new EvaluationInputError("CLI_ARGUMENT_INVALID", "An unknown command-line argument was supplied");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new EvaluationInputError("CLI_VALUE_MISSING", "A command-line option is missing its value");
    if (values[key] !== undefined && key !== "repositoryRoot") throw new EvaluationInputError("CLI_ARGUMENT_DUPLICATE", "A command-line option was supplied more than once");
    values[key] = value;
    index += 1;
  }
  const required: Array<keyof EvaluationPaths> = [
    "manifestPath",
    "pairLabelsPath",
    "artifactMapPath",
    "sealPath",
    "groundTruthBundlePath",
    "resultsPath",
    "outputPath",
  ];
  if (required.some((key) => typeof values[key] !== "string")) {
    throw new EvaluationInputError("CLI_ARGUMENT_REQUIRED", "All external input and output paths are required");
  }
  return values as unknown as EvaluationPaths;
}

export function runPolicyV1Cli(argv: string[]): number {
  try {
    const options = parsePolicyV1Args(argv);
    if (options === "help") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const input = loadAndValidateInputs(options);
    const report = buildPolicyV1Report(input);
    writePolicyV1Report(report, options.outputPath);
    process.stdout.write(`${reportSummary(report)}\nAggregate report written to the caller-supplied output path.\n`);
    return 0;
  } catch (error) {
    if (error instanceof EvaluationInputError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof ZodError) {
      process.stderr.write("INPUT_SCHEMA_INVALID: An external JSON input does not match the policy-v1 contract.\n");
      return 1;
    }
    process.stderr.write("EVALUATION_FAILED: The evaluator stopped without writing a report.\n");
    return 1;
  }
}

if (require.main === module) process.exitCode = runPolicyV1Cli(process.argv.slice(2));
