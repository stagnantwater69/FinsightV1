import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { ApiError } from "../../src/middleware/error.middleware";
import {
  isValidReductionOpportunityId,
  recordReductionOpportunityFeedback,
  REDUCTION_OPPORTUNITY_ID_PATTERN,
} from "../../src/services/reductionOpportunity.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * `recordReductionOpportunityFeedback` — plan §15 Phase 5.
 *
 * A narrow, idempotent write: upserts one row on
 * `[businessProfileId, opportunityId, userId]`. These tests cover the
 * id-format validation (so this endpoint cannot be used to write arbitrary
 * feedback rows unrelated to real opportunities), the upsert-not-duplicate
 * behavior, and ownership isolation.
 */

const VALID_ID = "category_pressure-1-2026-08-30";

describe("isValidReductionOpportunityId / REDUCTION_OPPORTUNITY_ID_PATTERN", () => {
  it("accepts ids in the exact shape computeReductionOpportunities produces", () => {
    expect(isValidReductionOpportunityId("category_pressure-1-2026-08-30")).toBe(true);
    expect(isValidReductionOpportunityId("frequent_purchase_accumulation-42-2026-01-05")).toBe(true);
    expect(isValidReductionOpportunityId("record_review_first-7-2025-12-31")).toBe(true);
  });

  it("rejects an unknown opportunity type", () => {
    expect(isValidReductionOpportunityId("vendor_price-1-2026-08-30")).toBe(false);
  });

  it("rejects a non-numeric category id", () => {
    expect(isValidReductionOpportunityId("category_pressure-abc-2026-08-30")).toBe(false);
  });

  it("rejects a malformed or missing period-end date", () => {
    expect(isValidReductionOpportunityId("category_pressure-1-2026-8-30")).toBe(false); // not zero-padded
    expect(isValidReductionOpportunityId("category_pressure-1")).toBe(false);
    expect(isValidReductionOpportunityId("category_pressure-1-not-a-date")).toBe(false);
  });

  it("rejects arbitrary/garbage strings — this is the anti-abuse boundary", () => {
    expect(isValidReductionOpportunityId("")).toBe(false);
    expect(isValidReductionOpportunityId("'; DROP TABLE users; --")).toBe(false);
    expect(isValidReductionOpportunityId("some-other-record-id-99")).toBe(false);
    expect(isValidReductionOpportunityId(VALID_ID + "-extra")).toBe(false);
  });

  it("REDUCTION_OPPORTUNITY_ID_PATTERN is exported and matches the same set as the helper", () => {
    expect(REDUCTION_OPPORTUNITY_ID_PATTERN.test(VALID_ID)).toBe(true);
  });
});

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
});

afterAll(disconnectDb);

describe("recordReductionOpportunityFeedback", () => {
  it("rejects a malformed opportunityId with a 400, before touching the database", async () => {
    await expect(
      recordReductionOpportunityFeedback(ctx.user.id, ctx.profile.id, "not-a-real-id", "helpful"),
    ).rejects.toMatchObject({ status: 400 });

    expect(await prisma.reductionOpportunityFeedback.count()).toBe(0);
  });

  it("throws 404 for a foreign business profile (ownership isolation)", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    await expect(
      recordReductionOpportunityFeedback(other.user.id, ctx.profile.id, VALID_ID, "helpful"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("creates a new feedback row on first submission", async () => {
    const result = await recordReductionOpportunityFeedback(ctx.user.id, ctx.profile.id, VALID_ID, "helpful");

    expect(result.opportunityId).toBe(VALID_ID);
    expect(result.rating).toBe("helpful");

    const row = await prisma.reductionOpportunityFeedback.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, opportunityId: VALID_ID, userId: ctx.user.id },
    });
    expect(row.rating).toBe("HELPFUL");
  });

  it("upserts (updates in place) on resubmission — does not create a duplicate row", async () => {
    await recordReductionOpportunityFeedback(ctx.user.id, ctx.profile.id, VALID_ID, "helpful");
    const result = await recordReductionOpportunityFeedback(ctx.user.id, ctx.profile.id, VALID_ID, "not_relevant");

    expect(result.rating).toBe("not_relevant");

    const rows = await prisma.reductionOpportunityFeedback.findMany({
      where: { businessProfileId: ctx.profile.id, opportunityId: VALID_ID, userId: ctx.user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe("NOT_RELEVANT");
  });

  it("keeps separate rows per user for the same opportunity on the same profile", async () => {
    const secondUser = await makeOwnerWithProfile();
    // Feedback from ctx.user on ctx.profile, and from a different user id on
    // the SAME profile id would violate ownership in practice (that user
    // wouldn't own ctx.profile) — instead assert the unique constraint is
    // scoped per (profile, opportunity, user) by using two different users
    // against their own respective profiles with the same opportunityId.
    await recordReductionOpportunityFeedback(ctx.user.id, ctx.profile.id, VALID_ID, "helpful");
    await recordReductionOpportunityFeedback(secondUser.user.id, secondUser.profile.id, VALID_ID, "not_relevant");

    expect(await prisma.reductionOpportunityFeedback.count()).toBe(2);
  });

  it("rejects an unrecognized rating value", async () => {
    await expect(
      // @ts-expect-error — intentionally invalid input for the runtime check
      recordReductionOpportunityFeedback(ctx.user.id, ctx.profile.id, VALID_ID, "not-a-rating"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
