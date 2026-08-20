import { z } from "zod";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * HTTP client for the Python scoring sidecar (ml/worker/server.py).
 *
 * FAIL OPEN IS THE ONLY FAILURE MODE. Every path out of here that is not a
 * fully validated 200 returns `null`, and the caller treats null as "no ML
 * opinion this pass" — the deterministic detectors are unaffected, the
 * analysis job completes, and nothing user-facing changes. A broken sidecar
 * can cost shadow findings; it can never cost an import, a record, or a job.
 *
 * The circuit breaker exists because the sidecar is polled from a worker that
 * runs every few seconds: without it, a dead sidecar would add a 5-second
 * timeout to every PROFILE_REFRESH job until someone noticed. Three straight
 * failures open the circuit for 60 seconds.
 */

export const IF_CONTRACT_VERSION = "if-contract-v1";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 1_000_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;

const scoreResponseSchema = z.object({
  contractVersion: z.literal(IF_CONTRACT_VERSION),
  modelVersion: z.string().min(1).max(50),
  sklearnVersion: z.string().min(1).max(50),
  trainedRows: z.number().int().positive(),
  featureCount: z.number().int().positive(),
  scores: z
    .array(
      z.object({
        id: z.number().int(),
        decisionValue: z.number(),
        normalizedScore: z.number().min(0).max(1),
      }),
    )
    .max(5_000),
});

export type MlScoreResponse = z.infer<typeof scoreResponseSchema>;

const breaker = { failures: 0, openUntil: 0 };

/** Exposed for tests; production code has no reason to touch it. */
export function resetCircuitBreakerForTests() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function recordFailure(reason: string, detail?: unknown) {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
    breaker.failures = 0;
  }
  logger.warn({ reason, detail: detail === undefined ? undefined : String(detail).slice(0, 300) }, "ml worker call failed");
}

export async function scoreWithIsolationForest(
  rows: { id: number; features: number[] }[],
  featureNames: readonly string[],
  seed = 42,
): Promise<MlScoreResponse | null> {
  if (Date.now() < breaker.openUntil) return null;

  const body = JSON.stringify({ contractVersion: IF_CONTRACT_VERSION, seed, featureNames, rows });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    // A contract violation on our side is a bug, not an outage — log loudly,
    // but do not trip the breaker over it.
    logger.error({ bytes: Buffer.byteLength(body), rows: rows.length }, "ml scoring request exceeds size cap");
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.ML_WORKER_URL}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      recordFailure(`http ${response.status}`, await response.text().catch(() => ""));
      return null;
    }
    const parsed = scoreResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      recordFailure("malformed response", parsed.error.message);
      return null;
    }
    breaker.failures = 0;
    return parsed.data;
  } catch (error) {
    recordFailure("request error", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
