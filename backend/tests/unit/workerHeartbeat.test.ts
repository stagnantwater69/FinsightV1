import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_HEARTBEAT_PREFIX,
  workerHeartbeatPath,
  writeWorkerHeartbeat,
} from "../../src/lib/workerHeartbeat";

/*
 * The container probe reads this file's mtime to decide whether the worker is
 * alive. The shell loop it replaces only tested that a pid existed, so these
 * pin the two properties that make the new one worth trusting: the worker can
 * actually refresh it, and failing to refresh it never takes the worker down.
 */
describe("worker liveness heartbeat", () => {
  it("writes the prefix the entrypoint bridge hands over on, and moves the mtime", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "finsight-heartbeat-")), "heartbeat");

    expect(await writeWorkerHeartbeat(file)).toBe(true);
    expect(await readFile(file, "utf8")).toMatch(new RegExp(`^${WORKER_HEARTBEAT_PREFIX} `));
    const first = (await stat(file)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await writeWorkerHeartbeat(file)).toBe(true);
    expect((await stat(file)).mtimeMs).toBeGreaterThan(first);
  });

  it("reports failure instead of throwing when the directory is not there", async () => {
    // The ordinary case outside a container: no health directory exists, and a
    // worker running locally must not die over a file only a probe reads.
    await expect(writeWorkerHeartbeat("/nonexistent-finsight-health/heartbeat")).resolves.toBe(false);
  });

  it("follows the health directory the entrypoint was given, with the same default", async () => {
    expect(workerHeartbeatPath({ RECEIPT_WORKER_HEALTH_DIR: "/run/finsight/worker-health" }))
      .toBe("/run/finsight/worker-health/heartbeat");
    expect(workerHeartbeatPath({})).toBe("/tmp/finsight-worker-health/heartbeat");
  });
});
