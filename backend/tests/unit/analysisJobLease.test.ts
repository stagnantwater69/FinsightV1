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
const transactionQueryRaw = vi.fn();
const transaction = vi.fn();
const businessProfileFindUnique = vi.fn(async () => ({ userId: 7 }));
const refreshOwnedCategoryStatistics = vi.fn(async () => []);
const refreshRecurringPatterns = vi.fn(async () => []);
const refreshTrendFindings = vi.fn(async () => []);
const refreshIsolationForestFindings = vi.fn(async () => []);
const detectAmountOutlierForExpense = vi.fn(async () => null);
const detectBehavioralNoveltyForExpense = vi.fn(async () => null);
const detectNearDuplicateForExpense = vi.fn(async () => null);
const detectVelocityForExpense = vi.fn(async () => null);
const notificationFindFirst = vi.fn(async () => null);
const notificationCreate = vi.fn();
const warn = vi.fn();

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    analysisJob: {
      update: (...args: unknown[]) => analysisJobUpdate(...args),
      updateMany: (...args: unknown[]) => analysisJobUpdateMany(...args),
    },
    businessProfile: { findUnique: (...args: unknown[]) => businessProfileFindUnique(...args) },
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: (...args: unknown[]) => warn(...args), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/services/anomalyDetection/categoryStatistics.service", () => ({
  refreshOwnedCategoryStatistics: (...args: unknown[]) => refreshOwnedCategoryStatistics(...args),
}));
vi.mock("../../src/services/anomalyDetection/recurring.service", () => ({
  refreshRecurringPatterns: (...args: unknown[]) => refreshRecurringPatterns(...args),
}));
vi.mock("../../src/services/anomalyDetection/trend.service", () => ({
  refreshTrendFindings: (...args: unknown[]) => refreshTrendFindings(...args),
}));
vi.mock("../../src/services/anomalyDetection/isolationForest.service", () => ({
  refreshIsolationForestFindings: (...args: unknown[]) => refreshIsolationForestFindings(...args),
}));
vi.mock("../../src/services/anomalyDetection/amountOutlier.service", () => ({
  detectAmountOutlierForExpense: (...args: unknown[]) => detectAmountOutlierForExpense(...args),
}));
vi.mock("../../src/services/anomalyDetection/behavioralNovelty.service", () => ({
  detectBehavioralNoveltyForExpense: (...args: unknown[]) => detectBehavioralNoveltyForExpense(...args),
}));
vi.mock("../../src/services/anomalyDetection/nearDuplicate.service", () => ({
  detectNearDuplicateForExpense: (...args: unknown[]) => detectNearDuplicateForExpense(...args),
}));
vi.mock("../../src/services/anomalyDetection/velocity.service", () => ({
  detectVelocityForExpense: (...args: unknown[]) => detectVelocityForExpense(...args),
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
  refreshRecurringPatterns.mockResolvedValue([]);
  refreshTrendFindings.mockResolvedValue([]);
  refreshIsolationForestFindings.mockResolvedValue([]);
  detectAmountOutlierForExpense.mockResolvedValue(null);
  detectBehavioralNoveltyForExpense.mockResolvedValue(null);
  detectNearDuplicateForExpense.mockResolvedValue(null);
  detectVelocityForExpense.mockResolvedValue(null);
  transactionQueryRaw.mockResolvedValue([{ id: CLAIMED.id }]);
  notificationFindFirst.mockResolvedValue(null);
  notificationCreate.mockResolvedValue({ id: 1 });
  transaction.mockImplementation(async (callback: (db: unknown) => Promise<unknown>) => callback({
    $queryRaw: (...args: unknown[]) => transactionQueryRaw(...args),
    notification: {
      findFirst: (...args: unknown[]) => notificationFindFirst(...args),
      create: (...args: unknown[]) => notificationCreate(...args),
    },
  }));
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

  it("runs every profile mutation behind a locked check of the exact lease", async () => {
    const writes = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const profileRefreshers = [
      [refreshOwnedCategoryStatistics, 4],
      [refreshRecurringPatterns, 4],
      [refreshTrendFindings, 4],
      [refreshIsolationForestFindings, 3],
    ] as const;
    profileRefreshers.forEach(([refresh, guardIndex], index) => {
      const write = writes[index]!;
      refresh.mockImplementationOnce(async (...args: unknown[]) => {
        const mutate = args[guardIndex] as (body: (db: unknown) => Promise<unknown>) => Promise<unknown>;
        await mutate(async () => {
          write();
          return [];
        });
        return [];
      });
    });

    await runAnalysisWorkerOnce();

    expect(transaction).toHaveBeenCalledTimes(4);
    expect(transactionQueryRaw).toHaveBeenCalledTimes(4);
    expect(writes.every((write) => write.mock.calls.length === 1)).toBe(true);
    const leaseSql = transactionQueryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(leaseSql.strings.join(" ")).toContain("AnalysisJob_Status\" = 'PROCESSING'");
    expect(leaseSql.values).toContain(CLAIMED.id);
    expect(leaseSql.values).toContain(CLAIMED.attemptCount);
  });

  it("stops before a detector mutation when the transaction lock says the lease was reclaimed", async () => {
    const staleWrite = vi.fn();
    transactionQueryRaw.mockResolvedValueOnce([]);
    refreshOwnedCategoryStatistics.mockImplementationOnce(async (...args: unknown[]) => {
      const mutate = args[4] as (body: () => Promise<unknown>) => Promise<unknown>;
      await mutate(async () => {
        staleWrite();
        return [];
      });
      return [];
    });

    await expect(runAnalysisWorkerOnce()).resolves.toBe(true);

    expect(staleWrite).not.toHaveBeenCalled();
    expect(refreshRecurringPatterns).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
    expect(
      analysisJobUpdateMany.mock.calls.some(
        ([args]) => (args as { data: { status?: string } }).data.status === "COMPLETE",
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("guards all transaction detectors and their notification write", async () => {
    queryRaw.mockResolvedValueOnce([{ ...CLAIMED, kind: "TRANSACTION", expenseRecordId: 91 }]);
    const detectors = [
      detectAmountOutlierForExpense,
      detectNearDuplicateForExpense,
      detectVelocityForExpense,
      detectBehavioralNoveltyForExpense,
    ];
    detectors.forEach((detector, index) => {
      detector.mockImplementationOnce(async (...args: unknown[]) => {
        const mutate = args[2] as (body: () => Promise<unknown>) => Promise<unknown>;
        await mutate(async () => null);
        return index === 0 ? { title: "Unusual amount", severity: "HIGH" } : null;
      });
    });

    await runAnalysisWorkerOnce();

    expect(transaction).toHaveBeenCalledTimes(5);
    expect(transactionQueryRaw).toHaveBeenCalledTimes(5);
    expect(notificationCreate).toHaveBeenCalledTimes(1);
  });
});
