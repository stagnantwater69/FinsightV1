import { describe, expect, it, vi } from "vitest";
import { abandonedRuns, containerNameFor, containerRunArgs, databaseUrlFor, removeOwnedContainer } from "../../scripts/test-db-run";

/** The isolated test runner may only ever create and remove its own container. */
describe("isolated test database runner", () => {
  it("names, labels and binds each run's container to loopback", () => {
    const args = containerRunArgs("abc123", 55501);

    expect(args).toContain(containerNameFor("abc123"));
    expect(args).toContain("finsight.test-run=abc123");
    expect(args).toContain("127.0.0.1:55501:5432");
    expect(args.some((arg) => /^0\.0\.0\.0:|^\d+:5432$/.test(arg))).toBe(false);
  });

  it("points the suite at the dedicated finsight_test database the setup guard requires", () => {
    expect(databaseUrlFor(55501)).toBe("postgresql://testuser:testpass@127.0.0.1:55501/finsight_test");
  });

  it("never uses a shared or protected container name", () => {
    expect(containerNameFor("abc123")).not.toMatch(/^finsight-(test-db|phase2-db-audit)$/);
  });

  it("records the runner's process so a later run can find what it left behind", () => {
    expect(containerRunArgs("abc123", 55501, 4321)).toContain("finsight.test-run.pid=4321");
  });

  it("treats only this host's runs whose process is gone as abandoned", () => {
    const alive = new Set([100]);
    const stale = abandonedRuns(
      [
        { runId: "live", pid: 100, host: "box/win32" },
        { runId: "killed", pid: 200, host: "box/win32" },
        // Same daemon, other process table: its pid cannot be checked from here.
        { runId: "from-wsl", pid: 300, host: "box/linux" },
      ],
      (pid) => alive.has(pid),
      "box/win32",
    );

    expect(stale).toEqual(["killed"]);
  });

  it("removes the container only when its label names this run", () => {
    const remove = vi.fn();

    expect(removeOwnedContainer("abc123", () => "abc123", remove)).toBe(true);
    expect(remove).toHaveBeenCalledWith("finsight-test-run-abc123");

    remove.mockClear();
    expect(removeOwnedContainer("abc123", () => "someone-else", remove)).toBe(false);
    expect(removeOwnedContainer("abc123", () => null, remove)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});
