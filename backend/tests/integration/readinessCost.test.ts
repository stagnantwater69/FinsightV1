import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app";
import { env } from "../../src/config/env";
import { observeRequestTiming, type CompletedRequestTiming } from "../../src/lib/requestTiming";
import { disconnectDb, resetDb } from "../setup/testDb";

/**
 * The readiness probe answers an unauthenticated production caller from one
 * query. The operational counters (about twenty more) run only for a caller
 * who may see them.
 */
const original = { NODE_ENV: env.NODE_ENV, HEALTH_DETAIL_TOKEN: env.HEALTH_DETAIL_TOKEN };
let finished: CompletedRequestTiming[] = [];
let stopObserving: () => void = () => {};

beforeEach(async () => {
  await resetDb();
  Object.assign(env, { NODE_ENV: "production", HEALTH_DETAIL_TOKEN: "probe-token-for-tests" });
  finished = [];
  stopObserving = observeRequestTiming((timing) => finished.push(timing));
});

afterEach(() => {
  stopObserving();
  Object.assign(env, original);
});

afterAll(disconnectDb);

describe("readiness cost", () => {
  it("answers an unauthenticated production probe with one query and no counters", async () => {
    const response = await request(app).get("/api/v1/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready", database: "ok" });
    expect(finished).toHaveLength(1);
    expect(finished[0]!.dbOperations).toBe(1);
  });

  it("still runs every counter for a caller with the detail token", async () => {
    const response = await request(app).get("/api/v1/health/ready").set("x-health-token", "probe-token-for-tests");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ready", database: "ok", queuedReceiptScans: 0, stalledAccountDeletions: 0 });
    expect(finished[0]!.dbOperations).toBeGreaterThan(10);
  });

  it("treats a wrong token like no token", async () => {
    const response = await request(app).get("/api/v1/health").set("x-health-token", "wrong");

    expect(response.body).toEqual({ status: "ready", database: "ok" });
    expect(finished[0]!.dbOperations).toBe(1);
  });
});
