import { AnomalyFindingFeedback, AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async (token: string) => token === "valid-token"
    ? { data: { user: { id: authUserId.value } }, error: null }
    : { data: { user: null }, error: new Error("bad token") } } } };
});

import request from "supertest";
import { app } from "../../src/app";
import { saveFinding } from "../../src/services/anomalyDetection/finding.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
  await saveFinding({
    fingerprint: "http-test", businessProfileId: ctx.profile.id,
    type: AnomalyFindingType.TREND_CHANGE, severity: AnomalyFindingSeverity.MEDIUM,
    score: 0.75, method: "test", title: "Test finding", reasons: ["Test reason"], detectorVersion: "test-v1",
  });
});
afterAll(disconnectDb);

describe("anomaly finding HTTP API", () => {
  it("lists, summarizes, and reviews an owned finding", async () => {
    const list = await request(app).get("/api/v1/insights/findings")
      .set(...AUTH).query({ businessProfileId: ctx.profile.id, status: "OPEN" });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const summary = await request(app).get("/api/v1/insights/findings/summary")
      .set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(summary.status).toBe(200);
    expect(summary.body.open).toBe(1);

    const reviewed = await request(app).patch(`/api/v1/insights/findings/${list.body.items[0].id}/review`)
      .set(...AUTH).send({ status: AnomalyFindingStatus.DISMISSED, feedback: AnomalyFindingFeedback.EXPECTED_TRANSACTION });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe(AnomalyFindingStatus.DISMISSED);
  });

  it("does not expose findings from another business", async () => {
    const other = await makeOwnerWithProfile({ name: "Other" });
    const response = await request(app).get("/api/v1/insights/findings")
      .set(...AUTH).query({ businessProfileId: other.profile.id });
    expect(response.status).toBe(404);
  });
});
