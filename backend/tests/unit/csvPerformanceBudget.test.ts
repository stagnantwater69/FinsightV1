import { describe, expect, it } from "vitest";
import {
  CSV_PHASES,
  CSV_SCENARIOS,
  DEFAULT_CSV_PERFORMANCE_BUDGET,
  LOCAL_REFERENCE_P95_MS,
  evaluateCsvPerformanceBudget,
  parseCsvPerformanceBudget,
} from "../load/csv-performance-budget.mjs";

function summaries(sampleCount = 5, p95For = (scenario: string, phase: string) => (
  DEFAULT_CSV_PERFORMANCE_BUDGET.scenarios[scenario][phase]
)) {
  return Object.fromEntries(CSV_SCENARIOS.map((scenario: string) => [
    scenario,
    Object.fromEntries(CSV_PHASES.map((phase: string) => [
      phase,
      { count: sampleCount, p95: p95For(scenario, phase) },
    ])),
  ]));
}

describe("CSV performance budget", () => {
  it("derives local regression defaults from the recorded reference with three-times headroom", () => {
    for (const scenario of CSV_SCENARIOS) {
      for (const phase of CSV_PHASES) {
        expect(DEFAULT_CSV_PERFORMANCE_BUDGET.scenarios[scenario][phase]).toBe(
          Math.max(100, LOCAL_REFERENCE_P95_MS[scenario][phase] * 3),
        );
      }
    }
  });

  it("merges a focused override without discarding the other local defaults", () => {
    const config = parseCsvPerformanceBudget({
      minimumSamples: 7,
      scenarios: { small: { stageMs: 125 } },
    });

    expect(config.minimumSamples).toBe(7);
    expect(config.scenarios.small.stageMs).toBe(125);
    expect(config.scenarios.small.reviewMs).toBe(DEFAULT_CSV_PERFORMANCE_BUDGET.scenarios.small.reviewMs);
    expect(config.scenarios["30k-rows"].terminalMs).toBe(
      DEFAULT_CSV_PERFORMANCE_BUDGET.scenarios["30k-rows"].terminalMs,
    );
  });

  it("lets BENCH_MIN_SAMPLES override the file value", () => {
    expect(parseCsvPerformanceBudget({ minimumSamples: 9 }, 6).minimumSamples).toBe(6);
  });

  it.each([
    [{ unexpected: true }, "Unknown CSV performance budget field"],
    [{ scenarios: { typo: { stageMs: 100 } } }, "Unknown CSV performance scenario"],
    [{ scenarios: { small: { typoMs: 100 } } }, "Unknown CSV performance phase"],
    [{ scenarios: { small: { stageMs: 0 } } }, "must be a positive finite number"],
    [{ minimumSamples: 4 }, "minimumSamples must be an integer of at least 5"],
    [{ minimumSamples: 5.5 }, "minimumSamples must be an integer of at least 5"],
  ])("rejects an invalid configuration", (input, message) => {
    expect(() => parseCsvPerformanceBudget(input)).toThrow(message);
  });

  it("passes when every phase has enough samples and stays within budget", () => {
    const config = parseCsvPerformanceBudget();
    const evaluation = evaluateCsvPerformanceBudget(summaries(), config);

    expect(evaluation.status).toBe("pass");
    expect(evaluation.passed).toBe(true);
    expect(evaluation.totals).toEqual({ passed: 20, failed: 0, insufficient: 0 });
  });

  it("fails a measured p95 above its configured budget", () => {
    const config = parseCsvPerformanceBudget();
    const report = summaries(5, (scenario, phase) => (
      scenario === "wide" && phase === "reviewMs"
        ? config.scenarios.wide.reviewMs + 1
        : config.scenarios[scenario][phase]
    ));
    const evaluation = evaluateCsvPerformanceBudget(report, config);

    expect(evaluation.status).toBe("fail");
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks).toContainEqual(expect.objectContaining({
      scenario: "wide",
      phase: "reviewMs",
      status: "fail",
    }));
  });

  it("reports an under-sampled phase instead of treating its low p95 as a pass", () => {
    const config = parseCsvPerformanceBudget();
    const report = summaries(5);
    report.small.stageMs = { count: 4, p95: 1 };
    const evaluation = evaluateCsvPerformanceBudget(report, config);

    expect(evaluation.status).toBe("insufficient_samples");
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks).toContainEqual(expect.objectContaining({
      scenario: "small",
      phase: "stageMs",
      status: "insufficient_samples",
      sampleCount: 4,
      minimumSamples: 5,
    }));
  });

  it("reports a missing phase as having no samples", () => {
    const config = parseCsvPerformanceBudget();
    const report = summaries(5);
    delete report.invalid.confirmMs;
    const evaluation = evaluateCsvPerformanceBudget(report, config);

    expect(evaluation.checks).toContainEqual(expect.objectContaining({
      scenario: "invalid",
      phase: "confirmMs",
      status: "insufficient_samples",
      sampleCount: 0,
      measuredP95Ms: null,
    }));
  });
});
