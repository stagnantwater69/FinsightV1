import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These mocks intercept every child_process call the pipeline could make and
// every scratch-database lifecycle call, so this test never spawns docker,
// never spawns prisma, and never touches a real database — hosted or
// otherwise.
const execFileSyncMock = vi.fn();
const execSyncMock = vi.fn();
const createScratchDatabaseMock = vi.fn();
const teardownScratchDatabaseMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

vi.mock("../../scripts/migrate-workflow/scratchDb", () => ({
  createScratchDatabase: (...args: unknown[]) => createScratchDatabaseMock(...args),
  teardownScratchDatabase: (...args: unknown[]) => teardownScratchDatabaseMock(...args),
}));

const FAKE_SCRATCH = {
  runId: "fakerun",
  containerName: "finsight-migration-scratch-fakerun",
  host: "127.0.0.1" as const,
  port: 55555,
  databaseUrl: "postgresql://scratch:scratch@127.0.0.1:55555/postgres",
  directUrl: "postgresql://scratch:scratch@127.0.0.1:55555/postgres",
};

describe("migrate:validate pipeline halts on the first failing step", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execSyncMock.mockReset();
    createScratchDatabaseMock.mockReset();
    teardownScratchDatabaseMock.mockReset();
    // Container-status check used by step 5.
    execSyncMock.mockReturnValue("finsight-test-db\n");
    createScratchDatabaseMock.mockResolvedValue(FAKE_SCRATCH);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("aborts before creating a scratch database when `prisma migrate diff --from-empty` fails", async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("simulated: prisma migrate diff --from-empty failed");
    });

    const { runValidationPipeline } = await import("../../scripts/migrate-workflow/validate");
    await expect(runValidationPipeline()).rejects.toThrow(/simulated/);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(createScratchDatabaseMock).not.toHaveBeenCalled();
    expect(teardownScratchDatabaseMock).not.toHaveBeenCalled();
  });

  it("aborts before creating a scratch database when `prisma validate` fails", async () => {
    execFileSyncMock
      .mockImplementationOnce(() => "") // step 1 diff succeeds
      .mockImplementationOnce(() => {
        throw new Error("simulated: prisma validate failed");
      });

    const { runValidationPipeline } = await import("../../scripts/migrate-workflow/validate");
    await expect(runValidationPipeline()).rejects.toThrow(/simulated/);

    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(createScratchDatabaseMock).not.toHaveBeenCalled();
  });

  it("tears down the scratch database and halts when `prisma migrate status` fails", async () => {
    execFileSyncMock
      .mockImplementationOnce(() => "") // step 1 diff
      .mockImplementationOnce(() => "") // step 2 validate
      .mockImplementationOnce(() => {
        throw new Error("simulated: prisma migrate status failed");
      });

    const { runValidationPipeline } = await import("../../scripts/migrate-workflow/validate");
    await expect(runValidationPipeline()).rejects.toThrow(/simulated/);

    expect(createScratchDatabaseMock).toHaveBeenCalledTimes(1);
    // The failing status step must prevent the test-run step from executing.
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
    // But teardown (the finally block) must still run.
    expect(teardownScratchDatabaseMock).toHaveBeenCalledWith(FAKE_SCRATCH.containerName);
  });

  it("halts and tears down when `npm test` against finsight_test fails", async () => {
    execFileSyncMock
      .mockImplementationOnce(() => "") // step 1 diff
      .mockImplementationOnce(() => "") // step 2 validate
      .mockImplementationOnce(() => "") // step 4 migrate status
      .mockImplementationOnce(() => {
        throw new Error("simulated: npm test failed");
      });

    const { runValidationPipeline } = await import("../../scripts/migrate-workflow/validate");
    await expect(runValidationPipeline()).rejects.toThrow(/simulated/);

    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
    expect(teardownScratchDatabaseMock).toHaveBeenCalledWith(FAKE_SCRATCH.containerName);
  });

  it("runs all steps and tears down on a full success", async () => {
    execFileSyncMock.mockImplementation(() => "");

    const { runValidationPipeline } = await import("../../scripts/migrate-workflow/validate");
    await expect(runValidationPipeline()).resolves.toBeUndefined();

    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
    expect(createScratchDatabaseMock).toHaveBeenCalledTimes(1);
    expect(teardownScratchDatabaseMock).toHaveBeenCalledWith(FAKE_SCRATCH.containerName);
  });

  it("refuses to run the test step (and never repurposes finsight-test-db as scratch space) if the test-db container is not up", async () => {
    execFileSyncMock
      .mockImplementationOnce(() => "")
      .mockImplementationOnce(() => "")
      .mockImplementationOnce(() => "");
    execSyncMock.mockReturnValue(""); // container not found

    const { runValidationPipeline } = await import("../../scripts/migrate-workflow/validate");
    await expect(runValidationPipeline()).rejects.toThrow(/finsight-test-db container is not running/);

    // Only the first three prisma steps ran; npm test was never invoked.
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
    expect(teardownScratchDatabaseMock).toHaveBeenCalledWith(FAKE_SCRATCH.containerName);
  });
});
