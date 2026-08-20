import { describe, expect, it } from "vitest";
import type { BusinessProfile } from "@prisma/client";
import { spendingImpactLines } from "../../src/services/aiContext.service";
import { impactBand, NOTICEABLE_BAND_FRACTION } from "../../src/services/analysis.service";

// Regression guard for the drift described in the audit: aiContext.service
// once hardcoded the noticeable-impact fraction as a literal 0.4 instead of
// importing NOTICEABLE_BAND_FRACTION from analysis.service (the documented
// single source of truth). This pins the AI-chat-stated boundary text to
// whatever impactBand() actually computes, so a future change to one without
// the other is caught here instead of silently drifting.

function fakeProfile(largeExpenseThresholdPercent: number): BusinessProfile {
  return {
    id: 1,
    userId: 1,
    name: "Test Biz",
    type: "Sari-Sari Store",
    availableFunds: 48500 as unknown as BusinessProfile["availableFunds"],
    expectedMonthlyExpenses: 60000 as unknown as BusinessProfile["expectedMonthlyExpenses"],
    operatingDays: 26,
    largeExpenseThresholdPercent: largeExpenseThresholdPercent as unknown as BusinessProfile["largeExpenseThresholdPercent"],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as BusinessProfile;
}

describe("aiContext spending-impact boundary text vs. impactBand()", () => {
  // No amount parsed -> spendingImpactLines describes the bands generically
  // without calling simulateSpendingImpact (no DB access needed here).
  const scenario = { amount: null, label: null, looksLikeScenario: false };

  it("states the same noticeable-impact floor that impactBand() switches on", async () => {
    const thresholdPercent = 25;
    const profile = fakeProfile(thresholdPercent);

    const lines = await spendingImpactLines(1, profile, scenario);
    const summaryLine = lines.find((l) => l.startsWith("An expense is treated as High Impact"));
    expect(summaryLine).toBeDefined();

    const expectedFloor = (thresholdPercent * NOTICEABLE_BAND_FRACTION).toFixed(1);
    expect(summaryLine).toContain(`Noticeable Impact from ${expectedFloor}%`);

    // Tie the stated number back to the actual banding function: right at
    // the stated floor, impactBand() must say Noticeable, and just below it
    // must say Low.
    expect(impactBand(Number(expectedFloor), thresholdPercent)).toBe("Noticeable Impact");
    expect(impactBand(Number(expectedFloor) - 0.01, thresholdPercent)).toBe("Low Impact");
  });

  it.each([10, 15, 20, 30, 40])(
    "stays consistent with impactBand() across different owner thresholds (%d%%)",
    async (thresholdPercent) => {
      const profile = fakeProfile(thresholdPercent);
      const lines = await spendingImpactLines(1, profile, scenario);
      const summaryLine = lines.find((l) => l.startsWith("An expense is treated as High Impact"))!;

      const expectedFloor = (thresholdPercent * NOTICEABLE_BAND_FRACTION).toFixed(1);
      expect(summaryLine).toContain(`Noticeable Impact from ${expectedFloor}%`);
      expect(impactBand(Number(expectedFloor), thresholdPercent)).toBe("Noticeable Impact");
    }
  );
});
