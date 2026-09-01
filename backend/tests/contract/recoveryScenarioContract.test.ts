import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Schema-level contract coverage for POST /insights/recovery-scenario —
 * RECOVERY-TARGET-IMPROVEMENT-PLAN.md §8.4/§9.9, Phase 4.
 *
 * Closes finding 5 of the Phase 4 QA follow-up: there was previously no
 * contract test at all for this endpoint's `delta`/`persisted` fields (only
 * the behavioral assertions in tests/integration/recoveryScenario.test.ts).
 * `.strict()` throughout, so an added/removed/renamed field fails loudly
 * instead of silently passing through.
 *
 * `current`/`hypothetical` reuse `recoveryTargetsSchema`, exported from
 * recoveryInsightContract.test.ts, rather than duplicating the full
 * `RecoveryTargets` field list here — see that file's doc comment on why it
 * is a distinct schema from `recoveryInsightSchema`.
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
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { recoveryScenarioDeltaSchema, recoveryTargetsSchema } from "./schemas/recoveryTargets.schema";

const recoveryScenarioSchema = z
  .object({
    assumedExpectedMonthlyExpenses: z.number().finite(),
    current: recoveryTargetsSchema,
    hypothetical: recoveryTargetsSchema,
    delta: recoveryScenarioDeltaSchema,
    persisted: z.literal(false),
  })
  .strict();

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/recovery-scenario";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 125000, operatingDays: 25 });
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

async function fetchScenario(assumedExpectedMonthlyExpenses: number) {
  const response = await request(app)
    .post(ENDPOINT)
    .set(...AUTH)
    .send({ businessProfileId: ctx.profile.id, assumedExpectedMonthlyExpenses });
  expect(response.status).toBe(200);
  return response.body;
}

function assertContract(body: unknown) {
  const parsed = recoveryScenarioSchema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
}

describe("expected-expenses increase (hypothetical > current)", () => {
  it("matches the contract with a positive totalCoverageGoal/remainingTarget/adjustedDailyTarget delta", async () => {
    // Real profile expectedMonthlyExpenses is 125000 (from beforeEach) — an
    // assumed value above that is a hypothetical increase.
    const body = await fetchScenario(150000);
    assertContract(body);

    expect(body.assumedExpectedMonthlyExpenses).toBe(150000);
    expect(body.current.expectedMonthlyExpenses).toBe(125000);
    expect(body.hypothetical.expectedMonthlyExpenses).toBe(150000);

    expect(body.delta.totalCoverageGoal).toBeCloseTo(
      body.hypothetical.expectedMonthlyExpenses - body.current.expectedMonthlyExpenses,
      6,
    );
    expect(body.delta.remainingTarget).toBeCloseTo(
      body.hypothetical.remainingTarget - body.current.remainingTarget,
      6,
    );
    expect(body.delta.adjustedDailyTarget).toBeCloseTo(
      body.hypothetical.adjustedDailyTarget - body.current.adjustedDailyTarget,
      6,
    );
    // A larger assumed expense with zero sales recorded strictly increases
    // both the remaining target and the adjusted daily target.
    expect(body.delta.totalCoverageGoal).toBeGreaterThan(0);
    expect(body.delta.remainingTarget).toBeGreaterThan(0);
    expect(body.delta.adjustedDailyTarget).toBeGreaterThan(0);
  });
});

describe("expected-expenses decrease (hypothetical < current)", () => {
  it("matches the contract with a negative totalCoverageGoal/remainingTarget/adjustedDailyTarget delta", async () => {
    const body = await fetchScenario(90000);
    assertContract(body);

    expect(body.assumedExpectedMonthlyExpenses).toBe(90000);
    expect(body.current.expectedMonthlyExpenses).toBe(125000);
    expect(body.hypothetical.expectedMonthlyExpenses).toBe(90000);

    expect(body.delta.totalCoverageGoal).toBeCloseTo(
      body.hypothetical.expectedMonthlyExpenses - body.current.expectedMonthlyExpenses,
      6,
    );
    expect(body.delta.remainingTarget).toBeCloseTo(
      body.hypothetical.remainingTarget - body.current.remainingTarget,
      6,
    );
    expect(body.delta.adjustedDailyTarget).toBeCloseTo(
      body.hypothetical.adjustedDailyTarget - body.current.adjustedDailyTarget,
      6,
    );
    expect(body.delta.totalCoverageGoal).toBeLessThan(0);
    expect(body.delta.remainingTarget).toBeLessThan(0);
    expect(body.delta.adjustedDailyTarget).toBeLessThan(0);
  });
});

describe("estimatedTransactionsPerDay is always null with the fixed reason", () => {
  it("never varies across an increase scenario", async () => {
    const body = await fetchScenario(150000);
    assertContract(body);
    expect(body.delta.estimatedTransactionsPerDay).toBeNull();
    expect(body.delta.estimatedTransactionsPerDayUnavailableReason).toBe("transaction_provenance_unknown");
  });

  it("never varies across a decrease scenario", async () => {
    const body = await fetchScenario(90000);
    assertContract(body);
    expect(body.delta.estimatedTransactionsPerDay).toBeNull();
    expect(body.delta.estimatedTransactionsPerDayUnavailableReason).toBe("transaction_provenance_unknown");
  });

  it("never varies across a zero-value scenario (edge case, not the two required signs)", async () => {
    const body = await fetchScenario(0);
    assertContract(body);
    expect(body.delta.estimatedTransactionsPerDay).toBeNull();
    expect(body.delta.estimatedTransactionsPerDayUnavailableReason).toBe("transaction_provenance_unknown");
  });
});

describe("persisted is always false", () => {
  it("is false regardless of scenario direction", async () => {
    const increase = await fetchScenario(150000);
    const decrease = await fetchScenario(90000);
    assertContract(increase);
    assertContract(decrease);
    expect(increase.persisted).toBe(false);
    expect(decrease.persisted).toBe(false);
  });
});
