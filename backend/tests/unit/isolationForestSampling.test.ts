import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which records the Isolation Forest pass scores once a profile's year of
 * history exceeds the 2,000-row cap. It used to keep the oldest 2,000, so a
 * busy business's recent spending was never scored at all.
 */

type Row = { id: number; categoryId: number; vendor: string | null; description: string; amount: number; date: Date; source: string };
type FindManyArgs = { orderBy: Array<Record<string, "asc" | "desc">>; take: number };

let ledger: Row[] = [];
const scoreWithIsolationForest = vi.fn(async (_rows: { id: number; features: number[] }[]) => null);

// Behaves like the real query for the fields this pass uses: sort by the given
// keys, then apply `take`.
function findMany({ orderBy, take }: FindManyArgs) {
  const sorted = [...ledger].sort((a, b) => {
    for (const key of orderBy) {
      const [field, direction] = Object.entries(key)[0]!;
      const left = field === "date" ? a.date.getTime() : a.id;
      const right = field === "date" ? b.date.getTime() : b.id;
      if (left !== right) return direction === "asc" ? left - right : right - left;
    }
    return 0;
  });
  return Promise.resolve(sorted.slice(0, take));
}

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    businessProfile: { findFirst: vi.fn(async () => ({ id: 1 })) },
    expenseRecord: { findMany: (args: FindManyArgs) => findMany(args) },
  },
}));
vi.mock("../../src/config/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("../../src/services/anomalyDetection/mlWorkerClient", () => ({
  scoreWithIsolationForest: (rows: { id: number; features: number[] }[]) => scoreWithIsolationForest(rows),
}));
vi.mock("../../src/services/anomalyDetection/finding.service", () => ({ saveFinding: vi.fn() }));
vi.mock("../../src/services/anomalyDetection/mutationGuard", () => ({ runAnalysisMutation: vi.fn() }));

const { refreshIsolationForestFindings } = await import("../../src/services/anomalyDetection/isolationForest.service");
const { DEFAULT_DETECTION_CONFIG } = await import("../../src/services/anomalyDetection/config");
const enabled = {
  ...DEFAULT_DETECTION_CONFIG,
  featureFlags: { ...DEFAULT_DETECTION_CONFIG.featureFlags, isolationForest: true },
};

function ledgerOf(count: number): Row[] {
  const start = Date.now() - 300 * 86_400_000;
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    categoryId: (index % 4) + 1,
    vendor: `Vendor ${index % 9}`,
    description: `Purchase ${index % 13}`,
    amount: 100 + (index % 17) * 5,
    // Ten rows per hour, oldest first, all inside the 365-day window.
    date: new Date(start + Math.floor(index / 10) * 3_600_000),
    source: "MANUAL",
  }));
}

describe("isolation forest history sampling", () => {
  beforeEach(() => scoreWithIsolationForest.mockClear());

  it("scores the most recent 2,000 records when the year holds more", async () => {
    ledger = ledgerOf(2_500);
    await refreshIsolationForestFindings(7, 1, enabled);

    const scored = scoreWithIsolationForest.mock.calls[0]![0].map((row) => row.id);
    expect(scored).toHaveLength(2_000);
    expect(scored[0]).toBe(501);
    expect(scored.at(-1)).toBe(2_500);
  });

  it("hands the matrix over in chronological order", async () => {
    ledger = ledgerOf(2_500).reverse();
    await refreshIsolationForestFindings(7, 1, enabled);

    const scored = scoreWithIsolationForest.mock.calls[0]![0].map((row) => row.id);
    expect(scored).toEqual([...scored].sort((a, b) => a - b));
  });

  it("scores the whole history when it fits under the cap", async () => {
    ledger = ledgerOf(150);
    await refreshIsolationForestFindings(7, 1, enabled);

    expect(scoreWithIsolationForest.mock.calls[0]![0]).toHaveLength(150);
  });
});
