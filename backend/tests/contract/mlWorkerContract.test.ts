import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * TS↔Python contract test: drives the REAL sidecar (ml/worker/server.py)
 * with the real pinned venv, over real HTTP. This is the test that fails when
 * either side drifts from if-contract-v1 — the integration tests mock the
 * client precisely because this file covers the wire.
 *
 * Skipped (loudly, not silently green) when the ml venv has not been created;
 * CI and dev machines create it with:
 *   python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PYTHON = path.join(REPO_ROOT, "ml/.venv/bin/python");
const SERVER = path.join(REPO_ROOT, "ml/worker/server.py");
const PORT = 8399;
const BASE = `http://127.0.0.1:${PORT}`;

const available = existsSync(PYTHON) && existsSync(SERVER);

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
  const response = await fetch(`${BASE}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe.skipIf(!available)("ml worker contract (if-contract-v1)", () => {
  let worker: ChildProcess;

  beforeAll(async () => {
    worker = spawn(PYTHON, [SERVER, "--port", String(PORT)], { stdio: "ignore" });
    const deadline = Date.now() + 15_000;
    // Poll health until the interpreter has imported sklearn and bound the port.
    for (;;) {
      try {
        const health = await fetch(`${BASE}/health`);
        if (health.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("ml worker did not become healthy in 15s");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, 20_000);

  afterAll(() => {
    worker?.kill();
  });

  it("reports its versions on /health", async () => {
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health).toMatchObject({ status: "ok", contractVersion: "if-contract-v1", modelVersion: "iforest-v1" });
    expect(health.sklearnVersion).toBeTruthy();
  });

  it("scores a valid batch with one entry per row, ids preserved", async () => {
    const { status, json } = await post(request(60));
    expect(status).toBe(200);
    expect(json.contractVersion).toBe("if-contract-v1");
    expect(json.trainedRows).toBe(60);
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
    const huge = { padding: "x".repeat(1_100_000) };
    const response = await fetch(`${BASE}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(huge),
    });
    expect(response.status).toBe(413);
  });
});

// When the venv is absent we still want the suite to say so rather than
// silently passing an empty file.
describe.skipIf(available)("ml worker contract (environment)", () => {
  it("is skipped because ml/.venv is not set up (see ml/README.md)", () => {
    expect(available).toBe(false);
  });
});
