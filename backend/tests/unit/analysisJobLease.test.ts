import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `claimJob` reclaims a PROCESSING job whose heartbeat is older than the
 * five-minute lease. Nothing refreshed that heartbeat once processing began,
 * and a PROFILE_REFRESH is not quick — it rebuilds category statistics,
 * recurring patterns and trends for a whole profile. So passing five minutes
 * meant a second worker started the same profile, and both finished with an
 * update keyed on the job id alone: the survivor was whoever wrote last, over
 * the same CategoryStatistics rows.
 *
 * Prisma is stubbed so the lease arithmetic can be driven directly, the same
 * way the receipt worker's lease behaviour is pinned.
 */

const analysisJobUpdate = vi.fn();
const analysisJobUpdateMany = vi.fn(async () => ({ count: 1 }));
const queryRaw = vi.fn();
const businessProfileFindUnique = vi.fn(async () => ({ userId: 7 }));
const refreshOwnedCategoryStatistics = vi.fn(async () => []);
const warn = vi.fn();

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    analysisJob: {
      update: (...args: unknown[]) => analysisJobUpdate(...args),
      updateMany: (...args: unknown[]) => analysisJobUpdateMany(...args),
    },
    businessProfile: { findUnique: (...args: unknown[]) => businessProfileFindUnique(...args) },
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: (...args: unknown[]) => warn(...args), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/services/anomalyDetection/categoryStatistics.service", () => ({
  refreshOwnedCategoryStatistics: (...args: unknown[]) => refreshOwnedCategoryStatistics(...args),
}));
vi.mock("../../src/services/anomalyDetection/recurring.service", () => ({
  refreshRecurringPatterns: vi.fn(async () => []),
}));
vi.mock("../../src/services/anomalyDetection/trend.service", () => ({
  refreshTrendFindings: vi.fn(async () => []),
}));
vi.mock("../../src/services/anomalyDetection/isolationForest.service", () => ({
  refreshIsolationForestFindings: vi.fn(async () => []),
}));
vi.mock("../../src/services/anomalyDetection/amountOutlier.service", () => ({
  detectAmountOutlierForExpense: vi.fn(async () => null),
}));
vi.mock("../../src/services/anomalyDetection/behavioralNovelty.service", () => ({
  detectBehavioralNoveltyForExpense: vi.fn(async () => null),
}));
vi.mock("../../src/services/anomalyDetection/nearDuplicate.service", () => ({
  detectNearDuplicateForExpense: vi.fn(async () => null),
}));
vi.mock("../../src/services/anomalyDetection/velocity.service", () => ({
  detectVelocityForExpense: vi.fn(async () => null),
}));

const { runAnalysisWorkerOnce } = await import("../../src/services/anomalyDetection/job.service");

const CLAIMED = { id: 42, businessProfileId: 3, expenseRecordId: null, kind: "PROFILE_REFRESH", attemptCount: 2 };

/** Every write this worker makes has to name the lease it holds, not just the row. */
function expectLeaseGuard(where: unknown) {
  expect(where).toMatchObject({ id: CLAIMED.id, attemptCount: CLAIMED.attemptCount });
  const workerId = (where as { workerId: unknown }).workerId;
  expect(workerId).toBeTypeOf("string");
  expect(workerId as string).toMatch(/^analysis-/);
}

beforeEach(() => {
  vi.clearAllMocks();
  analysisJobUpdateMany.mockResolvedValue({ count: 1 });
  businessProfileFindUnique.mockResolvedValue({ userId: 7 });
  refreshOwnedCategoryStatistics.mockResolvedValue([]);
  queryRaw.mockResolvedValue([CLAIMED]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("analysis job lease", () => {
  it("refreshes the heartbeat while a long refresh is still running", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    refreshOwnedCategoryStatistics.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve([]); }),
    );

    const run = runAnalysisWorkerOnce();
    // Past the heartbeat interval, still well inside the lease.
    await vi.advanceTimersByTimeAsync(31_000);

    const beats = analysisJobUpdateMany.mock.calls.filter(
      ([args]) => (args as { data: Record<string, unknown> }).data.heartbeatAt !== undefined
        && (args as { data: Record<string, unknown> }).data.status === undefined,
    );
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expectLeaseGuard((beats[0]![0] as { where: unknown }).where);

    release();
    await run;
  });

  it("guards the completion with the lease instead of the id alone", async () => {
    await runAnalysisWorkerOnce();

    const completion = analysisJobUpdateMany.mock.calls.find(
      ([args]) => (args as { data: { status?: string } }).data.status === "COMPLETE",
    );
    expect(completion).toBeDefined();
    expectLeaseGuard((completion![0] as { where: unknown }).where);
    // The unguarded `update({ where: { id } })` must be gone, not merely
    // accompanied by a guarded one.
    expect(analysisJobUpdate).not.toHaveBeenCalled();
  });

  it("says so, and writes nothing more, when a newer worker already took the job", async () => {
    analysisJobUpdateMany.mockResolvedValue({ count: 0 });

    await expect(runAnalysisWorkerOnce()).resolves.toBe(true);

    expect(warn).toHaveBeenCalled();
    expect(analysisJobUpdate).not.toHaveBeenCalled();
  });

  it("guards the failure path too, so a reclaimed job is not rescheduled twice", async () => {
    refreshOwnedCategoryStatistics.mockRejectedValue(new Error("detector exploded"));

    await runAnalysisWorkerOnce();

    const failure = analysisJobUpdateMany.mock.calls.find(
      ([args]) => (args as { data: { status?: string } }).data.status === "PENDING",
    );
    expect(failure).toBeDefined();
    expectLeaseGuard((failure![0] as { where: unknown }).where);
  });
});
