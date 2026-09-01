import { AnomalyFindingSeverity, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { saveFinding } from "../../src/services/anomalyDetection/finding.service";
import { archiveBusinessProfile } from "../../src/services/businessProfile.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * HTTP-level coverage for GET /insights/reduction-opportunities.
 *
 * See docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md §8 for the response
 * contract and §14.2 for the required cases. Schema-level (zod) validation of
 * the response shape lives in tests/contract/reductionOpportunityContract.test.ts
 * — this file is about HTTP behavior: auth, ownership, validation, and
 * read-only-ness.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/reduction-opportunities";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities", "Transportation"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

async function addExpense(category: string, description: string, amount: number, dayOffset: number) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories[category]!,
    date: utcDayString(dayOffset),
    description,
    amount,
  });
}

describe("authentication", () => {
  it("rejects a request with no bearer token", async () => {
    const response = await request(app).get(ENDPOINT).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(401);
  });

  it("rejects a request with an invalid token", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set("Authorization", "Bearer not-a-real-token")
      .query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(401);
  });

  it("an authenticated owner can read their own opportunities", async () => {
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("period");
    expect(response.body).toHaveProperty("dataQuality");
    expect(response.body).toHaveProperty("opportunities");
    expect(response.body).toHaveProperty("detectorVersion");
  });
});

describe("ownership isolation", () => {
  it("cannot read another owner's business profile", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: other.profile.id });
    // Consistent with the rest of the app's not-found convention (see
    // backend/src/lib/ownership.ts): a foreign id and a nonexistent id must be
    // indistinguishable, so this must be 404, never 403.
    expect(response.status).toBe(404);
  });

  it("returns the same 404 for a foreign profile as for a nonexistent one", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    const foreign = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: other.profile.id });
    const nonexistent = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: 999999 });
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.status).toBe(404);
  });

  it("does not leak another owner's related record ids", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    await expenses.createExpenseRecord(other.user.id, {
      businessProfileId: other.profile.id,
      categoryId: other.categories.Inventory!,
      date: utcDayString(0),
      description: "Someone else's big purchase",
      amount: 90000,
    });

    // The caller's own profile is empty, so opportunities must be empty too —
    // nothing from the other owner's profile may surface here.
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body.opportunities).toEqual([]);
  });
});

describe("archived profile behavior matches other insight endpoints", () => {
  it("remains readable after the profile is archived (archiving only hides it from the switcher)", async () => {
    await archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
  });
});

describe("periodDays and endDate validation, matching /expense-behavior", () => {
  it("rejects a missing businessProfileId", async () => {
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({});
    expect(response.status).toBe(400);
  });

  it("defaults periodDays to 30 when omitted", async () => {
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body.period.days).toBe(30);
  });

  it("rejects periodDays of 0", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, periodDays: 0 });
    expect(response.status).toBe(400);
  });

  it("rejects a negative periodDays", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, periodDays: -5 });
    expect(response.status).toBe(400);
  });

  it("accepts the maximum periodDays of 366", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, periodDays: 366 });
    expect(response.status).toBe(200);
    expect(response.body.period.days).toBe(366);
  });

  it("rejects periodDays over 366", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, periodDays: 367 });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed endDate", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, endDate: "31-01-2026" });
    expect(response.status).toBe(400);
  });

  it("accepts a well-formed endDate and anchors the window to it", async () => {
    await addExpense("Inventory", "Two years ago", 1200, -700);

    const today = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(today.body.dataQuality.currentRecordCount).toBe(0);

    const anchored = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, endDate: utcDayString(-700) });
    expect(anchored.status).toBe(200);
    expect(anchored.body.period.end).toBe(utcDayString(-700));
    expect(anchored.body.dataQuality.currentRecordCount).toBe(1);
  });
});

describe("response contract is stable across zero, one, and several opportunities", () => {
  it("zero opportunities: insufficient history below the minimum record count", async () => {
    await addExpense("Inventory", "Only one record", 400, -1);

    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body.opportunities).toEqual([]);
    expect(response.body.dataQuality.status).toBe("insufficient");
    expect(response.body.dataQuality.message).not.toBeNull();
  });

  it("zero opportunities: enough history but nothing crosses materiality", async () => {
    await addExpense("Inventory", "Small buy", 100, -1);
    await addExpense("Utilities", "Small buy", 100, -2);
    await addExpense("Transportation", "Small buy", 100, -3);

    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body.opportunities).toEqual([]);
    // Enough current-period records, no previous-period baseline at all.
    expect(response.body.dataQuality.status).toBe("limited");
  });

  it("one opportunity: a single category clears CATEGORY_PRESSURE", async () => {
    // Previous period (~30-59 days back): a modest baseline.
    await addExpense("Inventory", "Previous period", 5000, -35);
    // Current period: a 100% increase, well past the 20% threshold and the
    // PHP 2,500 materiality floor (2% of EME 125,000).
    await addExpense("Inventory", "Current period A", 6000, -5);
    await addExpense("Inventory", "Current period B", 4000, -6);
    await addExpense("Inventory", "Current period C", 500, -7);

    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body.opportunities).toHaveLength(1);
    const [opportunity] = response.body.opportunities;
    expect(opportunity.type).toBe("CATEGORY_PRESSURE");
    expect(opportunity.categoryName).toBe("Inventory");
    expect(opportunity.priority).toBe("high");
    expect(opportunity.evidence.changePercent).toBeCloseTo(110, 0);
    // §8.3: the id is `type-categoryId-periodEndKey` — never the profile id.
    // Asserted by exact reconstruction rather than substring exclusion, since
    // a small sequential test id can otherwise coincidentally collide.
    expect(opportunity.id).toBe(
      `${opportunity.type.toLowerCase()}-${opportunity.categoryId}-${response.body.period.end}`,
    );
  });

  it("several opportunities: one of each type, ranked and merged one-per-category", async () => {
    // RECORD_REVIEW_FIRST: Utilities carries an unresolved possible-duplicate
    // finding that materially contributes to the category.
    const utilitiesRecord = await addExpense("Utilities", "Flagged purchase", 6000, -4);
    await saveFinding({
      fingerprint: "http-reduction-dup",
      businessProfileId: ctx.profile.id,
      expenseRecordId: utilitiesRecord.id,
      type: AnomalyFindingType.POSSIBLE_DUPLICATE,
      severity: AnomalyFindingSeverity.MEDIUM,
      method: "test",
      title: "Possible duplicate",
      reasons: ["Same amount, same day"],
      detectorVersion: "test-v1",
    });

    // CATEGORY_PRESSURE: Inventory has a high share of current spend.
    await addExpense("Inventory", "Big current spend", 10000, -5);

    // FREQUENT_PURCHASE_ACCUMULATION: Transportation has many small, non-dominant
    // purchases whose count and share clear the frequent-purchase thresholds.
    for (let i = 0; i < 6; i++) {
      await addExpense("Transportation", `Small trip ${i}`, 500, -1 - i);
    }

    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body.opportunities.length).toBeGreaterThan(1);
    expect(response.body.opportunities.length).toBeLessThanOrEqual(3);

    const types = response.body.opportunities.map((o: { type: string }) => o.type);
    expect(types).toContain("RECORD_REVIEW_FIRST");
    expect(types).toContain("CATEGORY_PRESSURE");
    expect(types).toContain("FREQUENT_PURCHASE_ACCUMULATION");

    // Ranking rule 1 (§7.3): RECORD_REVIEW_FIRST with possible duplicates first.
    expect(response.body.opportunities[0].type).toBe("RECORD_REVIEW_FIRST");
    expect(response.body.opportunities[0].evidence.possibleDuplicateCount).toBeGreaterThan(0);

    // At most one opportunity per category.
    const categoryIds = response.body.opportunities.map((o: { categoryId: number }) => o.categoryId);
    expect(new Set(categoryIds).size).toBe(categoryIds.length);

    // Every monetary figure and percentage is a finite JSON number.
    for (const o of response.body.opportunities) {
      for (const value of Object.values(o.evidence)) {
        if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe("the endpoint performs no writes", () => {
  it("leaves row counts unchanged across every table it reads", async () => {
    await addExpense("Inventory", "Previous period", 5000, -35);
    await addExpense("Inventory", "Current period A", 6000, -5);
    await addExpense("Inventory", "Current period B", 4000, -6);
    const flaggedRecord = await addExpense("Utilities", "Flagged", 6000, -2);
    await saveFinding({
      fingerprint: "http-reduction-no-write",
      businessProfileId: ctx.profile.id,
      expenseRecordId: flaggedRecord.id,
      type: AnomalyFindingType.POSSIBLE_DUPLICATE,
      severity: AnomalyFindingSeverity.MEDIUM,
      method: "test",
      title: "Possible duplicate",
      reasons: ["test"],
      detectorVersion: "test-v1",
    });

    const before = {
      expenseRecord: await prisma.expenseRecord.count(),
      anomalyFinding: await prisma.anomalyFinding.count(),
      businessProfile: await prisma.businessProfile.count(),
      notification: await prisma.notification.count(),
    };

    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    // Sanity: this call actually did meaningful work, not a no-op empty read.
    expect(response.body.opportunities.length).toBeGreaterThan(0);

    const after = {
      expenseRecord: await prisma.expenseRecord.count(),
      anomalyFinding: await prisma.anomalyFinding.count(),
      businessProfile: await prisma.businessProfile.count(),
      notification: await prisma.notification.count(),
    };

    expect(after).toEqual(before);
  });
});
