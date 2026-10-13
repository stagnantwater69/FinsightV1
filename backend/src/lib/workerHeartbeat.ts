import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/*
 * The worker's liveness heartbeat.
 *
 * The container health probe (docker/worker-readiness.sh) reads this file's
 * mtime. It used to be touched by a shell loop in worker-entrypoint.sh whose
 * only test was `kill -0 $worker_pid`, so a worker whose event loop had
 * stopped turning went on reporting healthy for as long as a process object
 * existed — nothing restarted it, and the queues it owned stayed stopped.
 *
 * Written from a timer inside the worker instead, the mtime means the JS
 * runtime is still scheduling work.
 *
 * WHAT IT STILL DOES NOT PROVE: that the queues are draining. A responsive
 * loop claiming nothing looks exactly like a busy one. Catching that needs a
 * progress deadline tuned against the longest legitimate pass — a large CSV
 * import runs for minutes — which is a separate decision, not a default worth
 * guessing at here.
 */

/** Matches the default in docker/worker-entrypoint.sh. */
const DEFAULT_HEALTH_DIR = "/tmp/finsight-worker-health";

/**
 * The prefix the entrypoint's bridge loop watches for.
 *
 * The shell keeps the file fresh during boot — Prisma's connection setup and
 * the migration guard run before the first write, and the worker image allows
 * only a 5s start period — then stands down once it sees this, so the two
 * never both claim to be the heartbeat.
 */
export const WORKER_HEARTBEAT_PREFIX = "node";

export function workerHeartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.RECEIPT_WORKER_HEALTH_DIR ?? DEFAULT_HEALTH_DIR, "heartbeat");
}

/**
 * Refreshes the heartbeat. Resolves false when it could not be written.
 *
 * Never throws: outside a container the health directory simply does not
 * exist, and a worker running locally must not die over a file only a probe
 * reads.
 */
export async function writeWorkerHeartbeat(path: string): Promise<boolean> {
  try {
    await writeFile(path, `${WORKER_HEARTBEAT_PREFIX} ${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}
