import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Schema-level contract coverage for GET /insights/recovery — RECOVERY-TARGET-
 * IMPROVEMENT-PLAN.md §8.2/§9.7/§11 Phase 1-3. Fails when the JSON shape of the
 * Phase 1 fields (`status`, `confidence`, `contractVersion`, `timezone`,
 * `asOfDate`) drifts, and independently guards against NaN/Infinity leaking
 * into any numeric field across representative fixture scenarios.
 *
 * Also pins the Phase 3 fields (`dataWarnings`, `setupIssues`,
 * `changeSincePreviousDay`) to their full shape rather than letting
 * `.passthrough()` wave them through unchecked — see the fixtures below for
 * scenarios that drive `dataWarnings`/`setupIssues` non-empty and
 * `changeSincePreviousDay` non-null through the real endpoint.
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
import * as sales from "../../src/services/salesRecord.service";
import * as businessProfile from "../../src/services/businessProfile.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

import {
  changeReasonSchema,
  changeSincePreviousDaySchema,
  confidenceSchema,
  recoveryCheckpointSchema,
  statusSchema,
} from "./schemas/recoveryTargets.schema";

const recoveryInsightSchema = z
  .object({
    status: statusSchema,
    confidence: confidenceSchema,
    contractVersion: z.literal(1),
    timezone: z.string().min(1),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expectedMonthlyExpenses: z.number().finite(),
    operatingDays: z.number().finite(),
    dailyNeededTarget: z.number().finite(),
    salesThisMonth: z.number().finite(),
    remainingTarget: z.number().finite(),
    daysInMonth: z.number().finite(),
    calendarDaysLeftInMonth: z.number().finite(),
    remainingOperatingDays: z.number().finite(),
    remainingOperatingDaysIsApproximated: z.boolean(),
    adjustedDailyTarget: z.number().finite(),
    todaysTarget: z.number().finite(),
    todaysSales: z.number().finite(),
    todaysGap: z.number().finite(),
    todaysStatus: z.enum(["above", "at", "below"]),
    monthCoveragePercent: z.number().finite(),
    onTrack: z.boolean(),
    needsSetup: z.boolean(),
    expectedSalesToDate: z.number().finite(),
    paceVarianceAmount: z.number().finite(),
    monthHasNoRecords: z.boolean(),
    coverageDays: z.number().finite(),
    // ---- Phase 3 (plan §8.2/§9.6/§11 Phase 3) — full shape, not passthrough ----
    confirmedSalesThisMonth: z.number().finite(),
    provisionalSalesThisMonth: z.number().finite(),
    dataWarnings: z.array(z.enum(["records_pending_review", "possible_duplicates"])),
    setupIssues: z.array(z.enum(["expected_expenses_missing", "operating_schedule_missing"])),
    changeSincePreviousDay: z.union([z.null(), changeSincePreviousDaySchema]),
    // ---- Phase 4 (plan §10.4) — full shape, not passthrough ----
    weeklyCheckpoints: z.array(recoveryCheckpointSchema),
  })
  .passthrough();

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/recovery";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 125000, operatingDays: 25 });
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

async function fetchRecovery() {
  const response = await request(app).get(ENDPOINT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
  expect(response.status).toBe(200);
  return response.body;
}

function assertContract(body: unknown) {
  const parsed = recoveryInsightSchema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
}

describe("zero sales, zero expenses (a brand-new profile)", () => {
  it("matches the contract with a needs_setup status", async () => {
    await businessProfile.updateBusinessProfile(ctx.user.id, ctx.profile.id, { expectedMonthlyExpenses: 0 });
    const body = await fetchRecovery();
    assertContract(body);
    expect(body.status).toBe("needs_setup");
    expect(body.confidence).toBe("unavailable");
    expect(body.contractVersion).toBe(1);
  });
});

describe("zero sales this month, expenses configured", () => {
  it("matches the contract with a no_current_month_data status", async () => {
    const body = await fetchRecovery();
    assertContract(body);
    expect(body.status).toBe("no_current_month_data");
    expect(body.confidence).toBe("limited");
  });
});

describe("normal case — some sales recorded, month in progress", () => {
  it("matches the contract with every numeric field finite", async () => {
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: utcDayString(0),
      description: "Daily sales",
      amount: 4500,
    });
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(0),
      description: "Restock",
      amount: 1000,
    });

    const body = await fetchRecovery();
    assertContract(body);
    expect(["ahead", "on_pace", "behind"]).toContain(body.status);
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `${key} should be finite, got ${value}`).toBe(true);
      }
    }
  });
});

describe("covered case — sales already meet or exceed the monthly target", () => {
  it("matches the contract with a covered status and a zero remaining target", async () => {
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: utcDayString(0),
      description: "Big sale",
      amount: 200000,
    });

    const body = await fetchRecovery();
    assertContract(body);
    expect(body.status).toBe("covered");
    expect(body.remainingTarget).toBe(0);
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `${key} should be finite, got ${value}`).toBe(true);
      }
    }
  });
});

/**
 * Phase 3 fixtures — closes finding 7 of the Phase 3 QA review
 * (docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md): the schema above no longer
 * lets `dataWarnings`/`setupIssues`/`changeSincePreviousDay` ride through as
 * unchecked `.passthrough()` fields, and these fixtures actually drive each
 * of them non-default through the real HTTP endpoint rather than only
 * exercising the pure formula in analysis.service.test.ts.
 *
 * All fixtures use `vi.setSystemTime` (fixed dates, business-local Asia/
 * Manila per `makeOwnerWithProfile`'s default timezone) rather than
 * `utcDayString`'s "relative to actual today" helper — several assertions
 * below depend on exactly which day-of-month/month-length is in effect
 * (e.g. the no_material_change fixture depends on two specific calendar
 * days happening to round to the same approximated remainingOperatingDays),
 * so the date has to be pinned rather than floating with the real clock.
 */
describe("Phase 3 — dataWarnings, setupIssues, changeSincePreviousDay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("a provisional sale pending review", () => {
    it("reports records_pending_review and a confirmed/provisional split that sums to salesThisMonth", async () => {
      vi.useFakeTimers();
      // Business-local (Asia/Manila, UTC+8) 2026-08-01 18:00 — the 1st of the
      // month, so changeSincePreviousDay is null and doesn't interact with
      // the fields under test here.
      vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));

      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Confirmed sale",
        amount: 4500,
      });
      const needsReview = await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Needs review sale",
        amount: 1000,
      });
      await sales.updateSalesRecord(ctx.user.id, needsReview.id, { reviewStatus: "Needs Review" });

      const body = await fetchRecovery();
      assertContract(body);
      expect(body.dataWarnings).toContain("records_pending_review");
      expect(body.provisionalSalesThisMonth).toBeGreaterThan(0);
      expect(body.confirmedSalesThisMonth + body.provisionalSalesThisMonth).toBeCloseTo(body.salesThisMonth, 6);
      expect(body.salesThisMonth).toBeCloseTo(5500, 6);
      expect(body.provisionalSalesThisMonth).toBeCloseTo(1000, 6);
    });
  });

  describe("a sale flagged as a possible duplicate", () => {
    it("reports possible_duplicates as a distinct warning from records_pending_review", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));

      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Confirmed sale",
        amount: 4500,
      });
      const flagged = await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Flagged sale",
        amount: 1000,
      });
      // createSalesRecord always leaves a fresh record reviewStatus="Reviewed"
      // — flip duplicateStatus directly (mirrors the existing convention in
      // tests/integration/aiContextRecoveryPhase3.test.ts) rather than relying
      // on the automatic same-day/same-amount/same-description duplicate
      // detector, which this description/amount pair wouldn't trip anyway.
      await sales.updateSalesRecord(ctx.user.id, flagged.id, { duplicateStatus: "Flagged" });

      const body = await fetchRecovery();
      assertContract(body);
      // Per the current computeRecoveryTarget implementation, pending-review
      // and flagged-duplicate amounts are tracked as two INDEPENDENT
      // sub-causes (analysis.service.ts's `recordEligibility` doc comment: "a
      // record can be both pending review and flagged as a duplicate — these
      // are two independent dataWarnings triggers"). A record that is
      // Reviewed + Flagged only trips possible_duplicates, not
      // records_pending_review — assert that actual, current behavior.
      expect(body.dataWarnings).toContain("possible_duplicates");
      expect(body.dataWarnings).not.toContain("records_pending_review");
      expect(body.provisionalSalesThisMonth).toBeCloseTo(1000, 6);
    });
  });

  describe("expenses configured but no operating schedule set up", () => {
    it("reports operating_schedule_missing without needsSetup", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));

      // ctx's profile already has expectedMonthlyExpenses=125000 (from the
      // top-level beforeEach) and no BusinessOperatingDay rows have been
      // created anywhere in this suite — this is the default, unmodified state.
      const body = await fetchRecovery();
      assertContract(body);
      expect(body.setupIssues).toContain("operating_schedule_missing");
      expect(body.setupIssues).not.toContain("expected_expenses_missing");
      expect(body.needsSetup).toBe(false);
      expect(body.remainingOperatingDaysIsApproximated).toBe(true);
    });
  });

  describe("changeSincePreviousDay — sales_added", () => {
    it("is non-null with a decreasing target attributed to sales recorded today", async () => {
      vi.useFakeTimers();
      // Mirrors tests/integration/aiContextRecoveryPhase3.test.ts /
      // dashboardInsights.test.ts's changeSincePreviousDay fixture: mid-month
      // so remainingOperatingDays isn't clamped at an edge.
      vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Day 15 sale",
        amount: 4500,
      });

      vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"));
      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Day 16 sale",
        amount: 20000,
      });

      const body = await fetchRecovery();
      assertContract(body);
      expect(body.changeSincePreviousDay).not.toBeNull();
      const change = body.changeSincePreviousDay!;
      expect(change.primaryReason).toBe("sales_added");
      expect(change.adjustedDailyTargetDelta).toBeLessThan(0);
      expect(change.salesAdded).toBeCloseTo(20000, 6);
      expect(Number.isFinite(change.adjustedDailyTargetDelta)).toBe(true);
      expect(Number.isFinite(change.remainingOpenDaysDelta)).toBe(true);
    });
  });

  describe("changeSincePreviousDay — open_day_elapsed", () => {
    it("is non-null with an increasing target attributed to a day elapsing, no new sales", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Only sale this month",
        amount: 4500,
      });

      vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"));

      const body = await fetchRecovery();
      assertContract(body);
      expect(body.changeSincePreviousDay).not.toBeNull();
      const change = body.changeSincePreviousDay!;
      expect(change.primaryReason).toBe("open_day_elapsed");
      expect(change.adjustedDailyTargetDelta).toBeGreaterThan(0);
      expect(change.salesAdded).toBe(0);
      expect(change.remainingOpenDaysDelta).not.toBe(0);
    });
  });

  describe("changeSincePreviousDay — no_material_change", () => {
    it("is non-null but reports no_material_change when the approximated day count and sales are both unchanged", async () => {
      vi.useFakeTimers();
      // Business-local 2026-08-30 18:00. August 2026 has 31 days: both day 29
      // and day 30 round to the SAME approximated remainingOperatingDays
      // (round(25*3/31)=2 and round(25*2/31)=2), and with zero sales recorded
      // either day, remainingTarget (=expectedMonthlyExpenses) and therefore
      // adjustedDailyTarget are identical for "today" and the re-run
      // "yesterday" — landing the delta at exactly 0, inside tolerance.
      vi.setSystemTime(new Date("2026-08-30T10:00:00.000Z"));

      const body = await fetchRecovery();
      assertContract(body);
      expect(body.changeSincePreviousDay).not.toBeNull();
      const change = body.changeSincePreviousDay!;
      expect(change.primaryReason).toBe("no_material_change");
      expect(change.adjustedDailyTargetDelta).toBeCloseTo(0, 6);
      expect(change.salesAdded).toBe(0);
      expect(change.remainingOpenDaysDelta).toBe(0);
    });
  });

  // NOTE: `data_changed` and the collapsed `baseline_changed`/`schedule_changed`
  // case are NOT exercised here. Per classifyRecoveryChangeReason's own doc
  // comment, those require a persisted "yesterday" baseline/schedule snapshot
  // that Phase 3 deliberately does not add (plan §7.5) — the deterministic
  // re-run this endpoint does always uses TODAY's expectedMonthlyExpenses/
  // operatingDays for both sides of the diff, so there is no way to reach
  // `data_changed` (which requires the day-count AND sales to both be
  // unchanged while the delta is still material) through the real endpoint
  // without an internal seam this contract test doesn't have access to.
  // Skipped rather than constructed artificially.

  describe("changeSincePreviousDay — 1st of the month", () => {
    it("is explicitly null (already covered at the unit/integration level in dashboardInsights.test.ts; asserted here too as part of this endpoint's full contract shape)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Confirmed sale",
        amount: 4500,
      });

      const body = await fetchRecovery();
      assertContract(body);
      expect(body.changeSincePreviousDay).toBeNull();
    });
  });

  describe("status and dataWarnings are orthogonal", () => {
    it("reports a behind status alongside a non-empty dataWarnings array", async () => {
      vi.useFakeTimers();
      // Mid-month, expectedMonthlyExpenses=125000/operatingDays=25 =>
      // dailyNeededTarget=5000/day, expectedSalesToDate=5000*elapsedOperatingDays.
      // A single small sale on day 15 falls far short of that pace => "behind".
      vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
      const smallSale = await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Small sale, needs review",
        amount: 100,
      });
      await sales.updateSalesRecord(ctx.user.id, smallSale.id, { reviewStatus: "Needs Review" });

      const body = await fetchRecovery();
      assertContract(body);
      expect(body.status).toBe("behind");
      expect(body.dataWarnings.length).toBeGreaterThan(0);
      expect(body.dataWarnings).toContain("records_pending_review");
    });
  });
});

/**
 * Phase 4 — weeklyCheckpoints (plan §10.4). Closes finding 5 of the QA
 * follow-up: these fixtures drive the real endpoint mid-month so the
 * response has both past (recorded) and future (pending) checkpoints in the
 * same list, and pin the ascending-date-order and
 * recordedAmount/variance-nullability-pairing invariants that the schema
 * above can't express on its own (schema only checks each checkpoint's
 * individual shape, not cross-field/cross-checkpoint relationships).
 */
describe("Phase 4 — weeklyCheckpoints", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("mid-month, some sales recorded", () => {
    it("returns checkpoints in ascending date order, with past checkpoints recorded and future ones pending", async () => {
      vi.useFakeTimers();
      // Business-local (Asia/Manila) 2026-07-15 — July has 31 days, so
      // checkpoints land on 7/14/21/28/31: day 7 and 14 are in the past
      // (recorded), day 21/28/31 are still in the future (pending).
      vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
      await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: utcDayString(0),
        description: "Mid-month sale",
        amount: 4500,
      });

      const body = await fetchRecovery();
      assertContract(body);

      const checkpoints = body.weeklyCheckpoints as Array<{
        endDate: string;
        recordedAmount: number | null;
        variance: number | null;
        status: string;
      }>;
      expect(checkpoints.length).toBeGreaterThan(0);

      // Ascending date order.
      for (let i = 1; i < checkpoints.length; i++) {
        expect(checkpoints[i]!.endDate > checkpoints[i - 1]!.endDate).toBe(true);
      }

      // At least one future checkpoint is pending.
      const pending = checkpoints.filter((c) => c.status === "pending");
      expect(pending.length).toBeGreaterThan(0);
      for (const c of pending) {
        expect(c.recordedAmount).toBeNull();
        expect(c.variance).toBeNull();
      }

      // recordedAmount/variance are never one null without the other, across
      // every checkpoint (not just the pending ones above).
      for (const c of checkpoints) {
        if (c.recordedAmount === null) {
          expect(c.variance).toBeNull();
        } else {
          expect(c.variance).not.toBeNull();
        }
      }

      // The past checkpoint(s) (endDate <= 2026-07-15) are non-pending and
      // carry a recorded (non-null) amount.
      const past = checkpoints.filter((c) => c.endDate <= "2026-07-15");
      expect(past.length).toBeGreaterThan(0);
      for (const c of past) {
        expect(c.status).not.toBe("pending");
        expect(c.recordedAmount).not.toBeNull();
      }
    });
  });
});

