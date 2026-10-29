import { beforeEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn());
vi.mock("../../src/config/errorReporting", () => ({ reportError }));

import { LIMITS, OWNER_DAILY_CAPS, reportUsageMilestones } from "../../src/middleware/rateLimit.middleware";

const shared = { name: "shared-test", limit: 100, windowMs: 86_400_000, alertWhenExhausted: true };
const owner = { name: "owner-test", limit: 10, windowMs: 86_400_000, reportOwnerWhenExhausted: true };

function countUpTo(options: Parameters<typeof reportUsageMilestones>[0], identity: string, last: number) {
  for (let count = 1; count <= last; count++) reportUsageMilestones(options, identity, count);
}

beforeEach(() => reportError.mockClear());

describe("reportUsageMilestones", () => {
  it("warns once when a shared budget reaches the alert share, and again once when it is exhausted", () => {
    countUpTo(shared, "all", 150);

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      level: "warning",
      limiter: "shared-test",
      fingerprint: ["shared-budget-nearing", "shared-test"],
    });
    expect((reportError.mock.calls[0]![0] as Error).message).toContain("reached 80 of 100");
    expect(reportError.mock.calls[1]![1]).toMatchObject({ fingerprint: ["shared-budget-exhausted", "shared-test"] });
  });

  it("reports an owner's first refusal of a daily cap with only their numeric id", () => {
    countUpTo(owner, "u42", 15);

    expect(reportError).toHaveBeenCalledOnce();
    const [error, context] = reportError.mock.calls[0]!;
    expect((error as Error).message).toBe('Owner reached daily cap "owner-test" (10)');
    expect(context).toEqual({
      level: "warning",
      limiter: "owner-test",
      ownerId: "42",
      fingerprint: ["owner-daily-cap", "owner-test", "42"],
    });
  });

  it("stays silent for limiters that ask for no report, and for identities that are not a signed-in owner", () => {
    countUpTo({ name: "plain", limit: 5, windowMs: 60_000 }, "u42", 10);
    countUpTo(owner, "ip203.0.113.7", 15);
    countUpTo(owner, "e0123456789abcdef0123456789abcdef", 15);

    expect(reportError).not.toHaveBeenCalled();
  });

  it("watches exactly the four per-owner daily caps on billed calls", () => {
    expect(OWNER_DAILY_CAPS.map((cap) => cap.name).sort()).toEqual(
      [LIMITS.ASK_DAILY, LIMITS.PURCHASE_REVIEW_DAILY, LIMITS.SCAN_RECEIPT_DAILY, LIMITS.SUGGEST_CATEGORY_DAILY]
        .map((cap) => cap.name)
        .sort(),
    );
  });
});
