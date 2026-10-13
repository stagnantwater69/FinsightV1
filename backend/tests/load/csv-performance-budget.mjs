export const CSV_SCENARIOS = ["small", "near-5mb", "wide", "invalid", "30k-rows"];
export const CSV_PHASES = ["stageMs", "reviewMs", "confirmMs", "terminalMs"];

export const LOCAL_REFERENCE_P95_MS = Object.freeze({
  small: Object.freeze({ stageMs: 45, reviewMs: 18, confirmMs: 42, terminalMs: 43 }),
  "near-5mb": Object.freeze({ stageMs: 465, reviewMs: 113, confirmMs: 329, terminalMs: 329 }),
  wide: Object.freeze({ stageMs: 79, reviewMs: 39, confirmMs: 64, terminalMs: 64 }),
  invalid: Object.freeze({ stageMs: 22, reviewMs: 22, confirmMs: 55, terminalMs: 55 }),
  "30k-rows": Object.freeze({ stageMs: 221, reviewMs: 436, confirmMs: 140, terminalMs: 10_208 }),
});

const LOCAL_HEADROOM_MULTIPLIER = 3;
const LOCAL_NOISE_FLOOR_MS = 100;

export const DEFAULT_CSV_PERFORMANCE_BUDGET = Object.freeze({
  minimumSamples: 5,
  scenarios: Object.freeze(Object.fromEntries(CSV_SCENARIOS.map((scenario) => [
    scenario,
    Object.freeze(Object.fromEntries(CSV_PHASES.map((phase) => [
      phase,
      Math.max(LOCAL_NOISE_FLOOR_MS, LOCAL_REFERENCE_P95_MS[scenario][phase] * LOCAL_HEADROOM_MULTIPLIER),
    ]))),
  ]))),
});

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function minimumSampleCount(value) {
  if (!Number.isInteger(value) || value < 5) throw new Error("minimumSamples must be an integer of at least 5");
  return value;
}

function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

export function parseCsvPerformanceBudget(input = {}, minimumSamplesOverride) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const root = objectValue(parsed, "CSV performance budget");
  const allowedRootKeys = new Set(["minimumSamples", "scenarios"]);
  for (const key of Object.keys(root)) {
    if (!allowedRootKeys.has(key)) throw new Error(`Unknown CSV performance budget field: ${key}`);
  }

  const configuredMinimum = minimumSamplesOverride ?? root.minimumSamples ?? DEFAULT_CSV_PERFORMANCE_BUDGET.minimumSamples;
  const minimumSamples = minimumSampleCount(configuredMinimum);
  const scenarioOverrides = root.scenarios === undefined ? {} : objectValue(root.scenarios, "scenarios");
  for (const scenario of Object.keys(scenarioOverrides)) {
    if (!CSV_SCENARIOS.includes(scenario)) throw new Error(`Unknown CSV performance scenario: ${scenario}`);
  }

  const scenarios = Object.fromEntries(CSV_SCENARIOS.map((scenario) => {
    const phaseOverrides = scenarioOverrides[scenario] === undefined
      ? {}
      : objectValue(scenarioOverrides[scenario], `scenarios.${scenario}`);
    for (const phase of Object.keys(phaseOverrides)) {
      if (!CSV_PHASES.includes(phase)) throw new Error(`Unknown CSV performance phase: ${scenario}.${phase}`);
    }
    return [scenario, Object.fromEntries(CSV_PHASES.map((phase) => [
      phase,
      positiveNumber(
        phaseOverrides[phase] ?? DEFAULT_CSV_PERFORMANCE_BUDGET.scenarios[scenario][phase],
        `scenarios.${scenario}.${phase}`,
      ),
    ]))];
  }));

  return { minimumSamples, scenarios };
}

export function evaluateCsvPerformanceBudget(scenarioSummaries, config) {
  const checks = [];
  for (const scenario of CSV_SCENARIOS) {
    for (const phase of CSV_PHASES) {
      const summary = scenarioSummaries?.[scenario]?.[phase];
      const sampleCount = Number.isInteger(summary?.count) ? summary.count : 0;
      const measuredP95Ms = typeof summary?.p95 === "number" && Number.isFinite(summary.p95)
        ? summary.p95
        : null;
      const budgetMs = config.scenarios[scenario][phase];
      let status = "pass";
      if (sampleCount < config.minimumSamples || measuredP95Ms === null) status = "insufficient_samples";
      else if (measuredP95Ms > budgetMs) status = "fail";
      checks.push({ scenario, phase, status, sampleCount, minimumSamples: config.minimumSamples, measuredP95Ms, budgetMs });
    }
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const insufficient = checks.filter((check) => check.status === "insufficient_samples").length;
  return {
    status: failed > 0 ? "fail" : insufficient > 0 ? "insufficient_samples" : "pass",
    passed: failed === 0 && insufficient === 0,
    totals: { passed: checks.length - failed - insufficient, failed, insufficient },
    checks,
  };
}
