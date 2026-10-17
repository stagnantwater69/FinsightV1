import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkWorkerPrerequisites, startOwnedWorker, withinWorkerStartupBudget, workerEnvironment, WORKER_BOOTSTRAP } from "../support/mlWorkerHarness";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const environment = workerEnvironment(REPO_ROOT);
const skipMissing = !environment.available && !environment.required;
let base: string;

function request(rows: number, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "if-contract-v1",
    seed: 42,
    featureNames: ["a", "b", "c"],
    rows: Array.from({ length: rows }, (_, index) => ({
      id: index + 1,
      features: [Math.sin(index), Math.cos(index * 2), (index % 9) / 3],
    })),
    ...overrides,
  };
}

async function post(body: unknown) {
  const response = await fetch(`${base}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: await response.json() };
}

describe.skipIf(skipMissing)("ml worker contract (if-contract-v1)", () => {
  let worker: Awaited<ReturnType<typeof startOwnedWorker>> | undefined;

  beforeAll(async () => {
    worker = await withinWorkerStartupBudget(
      () => { checkWorkerPrerequisites(environment); },
      (remainingMs) => startOwnedWorker(environment.python,
        (nonce) => ["-u", "-c", WORKER_BOOTSTRAP, environment.server, nonce], remainingMs),
    );
    base = worker.base;
  }, 20_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("reports its versions on /health", async () => {
    const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })).json();
    expect(health).toMatchObject({ status: "ok", contractVersion: "if-contract-v1", modelVersion: "iforest-v1" });
    const versions = checkWorkerPrerequisites(environment);
    expect(health.sklearnVersion).toBe(versions.sklearn);
    expect(health.numpyVersion).toBe(versions.numpy);
  });

  it("scores a valid batch with one entry per row, ids preserved", async () => {
    const { status, json } = await post(request(60));
    expect(status).toBe(200);
    expect(json.contractVersion).toBe("if-contract-v1");
    expect(json.trainedRows).toBe(60);
    expect(typeof json.durationMs).toBe("number");
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
    expect(json.scores).toHaveLength(60);
    expect(json.scores.map((entry: { id: number }) => entry.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    for (const entry of json.scores) {
      expect(entry.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(entry.normalizedScore).toBeLessThanOrEqual(1);
      expect(typeof entry.decisionValue).toBe("number");
    }
  });

  it("is deterministic for the same matrix and seed", async () => {
    const body = request(50);
    const first = await post(body);
    const second = await post(body);
    expect(first.json.scores).toEqual(second.json.scores);
  });

  it("ranks a planted outlier as the most anomalous row", async () => {
    const body = request(80);
    body.rows[0] = { id: 1, features: [80, -80, 80] };
    const { json } = await post(body);
    const planted = json.scores.find((entry: { id: number }) => entry.id === 1);
    expect(planted.normalizedScore).toBe(1);
    expect(planted.decisionValue).toBeLessThan(0);
  });

  it("rejects malformed and undersized requests with 4xx, never 500", async () => {
    expect((await post({ nonsense: true })).status).toBe(422);
    expect((await post(request(5))).status).toBe(422); // below MIN_ROWS
    expect((await post(request(30, { contractVersion: "if-contract-v9" }))).status).toBe(422);
    const widthMismatch = request(30);
    widthMismatch.rows[3] = { id: 4, features: [1, 2] };
    expect((await post(widthMismatch)).status).toBe(422);
    const nan = request(30);
    // JSON can't carry NaN; a string smuggle attempt must be rejected too.
    (nan.rows[2] as { features: unknown[] }).features = ["NaN", 1, 2];
    expect((await post(nan)).status).toBe(422);
  });

  it("rejects oversized bodies with 413", async () => {
    const huge = JSON.stringify({ padding: "x".repeat(1_100_000) });
    const result = await new Promise<{ status: number | undefined; body: string; continued: boolean }>((resolve, reject) => {
      let continued = false;
      const upload = httpRequest(`${base}/score`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(huge),
          Expect: "100-continue",
        },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 16_384) upload.destroy(new Error("Worker rejection response exceeded expected bounds"));
        });
        response.on("end", () => {
          upload.destroy();
          resolve({ status: response.statusCode, body, continued });
        });
        response.on("error", reject);
      });
      upload.on("error", reject);
      upload.on("continue", () => { continued = true; upload.end(huge); });
      upload.setTimeout(10_000, () => upload.destroy(new Error("Oversized worker request timed out")));
      // Wait for acceptance before writing; early 413 otherwise races a Windows TCP reset.
      upload.flushHeaders();
    });
    expect(result.status).toBe(413);
    expect(result.continued).toBe(false);
    expect(JSON.parse(result.body)).toEqual({ error: "body must be 1..1000000 bytes" });
  });
});

if (skipMissing) describe("ml worker contract (environment)", () => {
  it("reports unavailable pinned Python; strict verification requires FINSIGHT_REQUIRE_ML_WORKER_CONTRACT=1", () => {
    expect(environment.available).toBe(false);
  });
});
