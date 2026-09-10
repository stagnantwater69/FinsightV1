import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IF_CONTRACT_VERSION,
  resetCircuitBreakerForTests,
  scoreWithIsolationForest,
} from "../../src/services/anomalyDetection/mlWorkerClient";

/*
 * WHAT THIS PROTECTS. The client fails open by design — anything that is not a
 * fully validated 200 returns null and the isolation-forest pass quietly does
 * nothing. That is the right failure mode for an outage, and a trap for the
 * response SCHEMA: a field made required here is a deploy-order constraint
 * enforced by silence. `durationMs` is an observational timing metric that
 * nothing reads to make a decision, so a worker that does not report it must
 * still be scored from, not dropped.
 *
 * The live wire format is covered by tests/contract/mlWorkerContract.test.ts
 * against the real sidecar. This file covers what the client ACCEPTS, which is
 * deliberately wider than what the current sidecar sends.
 */

const okBody = (extra: Record<string, unknown> = {}) => ({
  contractVersion: IF_CONTRACT_VERSION,
  modelVersion: "iforest-1",
  sklearnVersion: "1.5.0",
  trainedRows: 120,
  featureCount: 3,
  scores: [
    { id: 1, decisionValue: -0.12, normalizedScore: 0.81 },
    { id: 2, decisionValue: 0.04, normalizedScore: 0.22 },
  ],
  ...extra,
});

const rows = [
  { id: 1, features: [1, 2, 3] },
  { id: 2, features: [4, 5, 6] },
];

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ml worker score response schema", () => {
  beforeEach(() => resetCircuitBreakerForTests());
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a response WITHOUT durationMs, so an older worker still scores", async () => {
    stubFetch(okBody());
    const result = await scoreWithIsolationForest(rows, ["a", "b", "c"]);
    expect(result).not.toBeNull();
    expect(result!.durationMs).toBeUndefined();
    expect(result!.scores).toHaveLength(2);
    expect(result!.modelVersion).toBe("iforest-1");
  });

  it("still accepts and carries durationMs when the worker reports it", async () => {
    stubFetch(okBody({ durationMs: 37.5 }));
    const result = await scoreWithIsolationForest(rows, ["a", "b", "c"]);
    expect(result!.durationMs).toBe(37.5);
  });

  it("rejects a durationMs that is present but not a non-negative number", async () => {
    for (const durationMs of [-1, "37", null]) {
      resetCircuitBreakerForTests();
      stubFetch(okBody({ durationMs }));
      expect(await scoreWithIsolationForest(rows, ["a", "b", "c"])).toBeNull();
    }
  });

  it("still rejects a response that breaks the contract in a load-bearing way", async () => {
    for (const broken of [
      okBody({ contractVersion: "if-contract-v0" }),
      okBody({ trainedRows: 0 }),
      okBody({ scores: [{ id: 1, decisionValue: -0.1, normalizedScore: 1.5 }] }),
    ]) {
      resetCircuitBreakerForTests();
      stubFetch(broken);
      expect(await scoreWithIsolationForest(rows, ["a", "b", "c"])).toBeNull();
    }
  });
});
