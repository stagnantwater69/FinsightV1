import { AnomalyFindingSeverity, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Schema-level contract coverage for GET /insights/reduction-opportunities.
 *
 * This is deliberately NOT a free-text rubric test (see plan §14.4 — AI-quality
 * probes are a Phase 3 concern once Ask FinSight is wired to this feature,
 * which it is not yet). This file fails when the JSON SHAPE drifts from
 * docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md §8.2, never on wording.
 */

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
import * as expenses from "../../src/services/expenseRecord.service";
import { saveFinding } from "../../src/services/anomalyDetection/finding.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

// Mirrors ReductionOpportunityEvidence, §8.2 verbatim.
const evidenceSchema = z.object({
  currentAmount: z.number().finite(),
  previousAmount: z.number().finite().nullable(),
  changeAmount: z.number().finite().nullable(),
  changePercent: z.number().finite().nullable(),
  expenseSharePercent: z.number().finite(),
  recordCount: z.number().int().nonnegative(),
  unusualRecordCount: z.number().int().nonnegative(),
  possibleDuplicateCount: z.number().int().nonnegative(),
}).strict();

// Mirrors ReductionOpportunity, §8.2 verbatim.
const opportunitySchema = z.object({
  id: z.string().min(1),
  type: z.enum(["CATEGORY_PRESSURE", "FREQUENT_PURCHASE_ACCUMULATION", "RECORD_REVIEW_FIRST"]),
  categoryId: z.number().int().positive(),
  categoryName: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.enum(["strong", "moderate", "limited"]),
  observation: z.string().min(1),
  rationale: z.string().min(1),
  evidence: evidenceSchema,
  // [ADDED] Plan §5.2/§15 Phase 5 — see ReductionOpportunity.costBehavior.
  costBehavior: z.enum(["fixed", "variable", "mixed", "unclassified"]),
  suggestedChecks: z.array(z.string().min(1)),
  relatedRecordIds: z.array(z.number().int().positive()),
  limitations: z.array(z.string().min(1)),
}).strict();

// Mirrors ReductionOpportunityResponse, §8.2 verbatim.
const responseSchema = z.object({
  period: z.object({
    days: z.number().int().nonnegative(),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(["rolling", "week", "month", "all"]),
    month: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  }).strict(),
  dataQuality: z.object({
    status: z.enum(["sufficient", "limited", "insufficient"]),
    currentRecordCount: z.number().int().nonnegative(),
    previousRecordCount: z.number().int().nonnegative(),
    message: z.string().nullable(),
  }).strict(),
  opportunities: z.array(opportunitySchema).max(3),
  detectorVersion: z.string().min(1),
}).strict();

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

async function fetchOpportunities(query: Record<string, string> = {}) {
  const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id, ...query });
  expect(response.status).toBe(200);
  return response.body;
}

describe("period filter selections", () => {
  it("the legacy rolling query reports its kind and no month", async () => {
    const body = await fetchOpportunities();
    expect(responseSchema.safeParse(body).success).toBe(true);
    expect(body.period).toMatchObject({ kind: "rolling", month: null });
    expect(body.period.days).toBeGreaterThan(0);
  });

  it("a month covers that whole calendar month", async () => {
    const body = await fetchOpportunities({ period: "month", month: "2026-02" });
    const parsed = responseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
    expect(body.period).toEqual({ days: 28, start: "2026-02-01", end: "2026-02-28", kind: "month", month: "2026-02" });
  });

  it("all time has no first day and says why nothing is compared", async () => {
    await addExpense("Inventory", "Stock", 6000, -2);
    const body = await fetchOpportunities({ period: "all" });
    const parsed = responseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
    expect(body.period).toMatchObject({ days: 0, start: null, kind: "all", month: null });
    expect(body.dataQuality.status).toBe("insufficient");
    expect(body.opportunities).toEqual([]);
  });
});

describe("zero opportunities", () => {
  it("insufficient history still matches the response schema", async () => {
    const body = await fetchOpportunities();
    const parsed = responseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
    expect(body.opportunities).toEqual([]);
  });

  it("sufficient records but no material signal still matches the response schema", async () => {
    await addExpense("Inventory", "Small", 100, -1);
    await addExpense("Utilities", "Small", 100, -2);
    await addExpense("Transportation", "Small", 100, -3);

    const body = await fetchOpportunities();
    const parsed = responseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
    expect(body.opportunities).toEqual([]);
  });
});

describe("one opportunity", () => {
  it("matches the response schema, with changePercent null only when there is no baseline", async () => {
    // A brand-new category, no previous-period baseline at all, but large
    // enough to clear the high-share threshold on its own. Three records to
    // clear the global minimumHistoryRecords floor that gates data quality.
    await addExpense("Inventory", "New category spend A", 6000, -2);
    await addExpense("Inventory", "New category spend B", 5000, -3);
    await addExpense("Inventory", "New category spend C", 500, -4);

    const body = await fetchOpportunities();
    const parsed = responseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
    expect(body.opportunities).toHaveLength(1);
    expect(body.opportunities[0].evidence.previousAmount).toBeNull();
    expect(body.opportunities[0].evidence.changePercent).toBeNull();
    expect(body.opportunities[0].confidence).toBe("limited");
  });
});

describe("several opportunities", () => {
  it("matches the response schema across all three types", async () => {
    const utilitiesRecord = await addExpense("Utilities", "Flagged purchase", 6000, -4);
    await saveFinding({
      fingerprint: "contract-reduction-dup",
      businessProfileId: ctx.profile.id,
      expenseRecordId: utilitiesRecord.id,
      type: AnomalyFindingType.POSSIBLE_DUPLICATE,
      severity: AnomalyFindingSeverity.MEDIUM,
      method: "test",
      title: "Possible duplicate",
      reasons: ["Same amount, same day"],
      detectorVersion: "test-v1",
    });

    await addExpense("Inventory", "Big current spend", 10000, -5);

    for (let i = 0; i < 6; i++) {
      await addExpense("Transportation", `Small trip ${i}`, 500, -1 - i);
    }

    const body = await fetchOpportunities();
    const parsed = responseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
    expect(body.opportunities.length).toBeGreaterThan(1);

    const types = body.opportunities.map((o: { type: string }) => o.type);
    expect(new Set(types).size).toBe(types.length); // no duplicate cards per plan §4.6/§6.1
  });
});

describe("the id does not expose the business profile id", () => {
  it("never contains the profile id as a substring of any opportunity id", async () => {
    await addExpense("Inventory", "New category spend A", 6000, -2);
    await addExpense("Inventory", "New category spend B", 5000, -3);
    await addExpense("Inventory", "New category spend C", 500, -4);

    const body = await fetchOpportunities();
    expect(body.opportunities.length).toBeGreaterThan(0);
    // §8.3: the id is `type-categoryId-periodEndKey` — never the profile id.
    // Asserted by exact reconstruction rather than substring exclusion, since
    // a small sequential test id can otherwise coincidentally collide with the
    // profile id.
    for (const o of body.opportunities) {
      expect(o.id).toBe(`${o.type.toLowerCase()}-${o.categoryId}-${body.period.end}`);
    }
  });
});
