// Types for csv-performance-budget.mjs, which the load harness runs as plain
// JavaScript. Its scenario and phase tables are dictionaries keyed by name.
type PhaseTable = Record<string, number>;

export const CSV_SCENARIOS: readonly string[];
export const CSV_PHASES: readonly string[];
export const LOCAL_REFERENCE_P95_MS: Readonly<Record<string, PhaseTable>>;
export const DEFAULT_CSV_PERFORMANCE_BUDGET: Readonly<{ minimumSamples: number; scenarios: Readonly<Record<string, PhaseTable>> }>;

export interface CsvPerformanceBudget {
  minimumSamples: number;
  scenarios: Record<string, PhaseTable>;
}

export interface CsvPerformanceCheck {
  scenario: string;
  phase: string;
  status: "pass" | "fail" | "insufficient_samples";
  sampleCount: number;
  minimumSamples: number;
  measuredP95Ms: number | null;
  budgetMs: number;
}

export function parseCsvPerformanceBudget(input?: unknown, minimumSamplesOverride?: number): CsvPerformanceBudget;

export function evaluateCsvPerformanceBudget(
  scenarioSummaries: unknown,
  config: CsvPerformanceBudget,
): {
  status: "pass" | "fail" | "insufficient_samples";
  passed: boolean;
  totals: { passed: number; failed: number; insufficient: number };
  checks: CsvPerformanceCheck[];
};
