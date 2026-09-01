import { describe, expect, it } from "vitest";
import {
  approximateElapsedOperatingDaysAsOf,
  deriveRecoveryProjection,
  PROJECTION_LOOKBACK_OPEN_DAYS,
  PROJECTION_METHOD_VERSION,
  PROJECTION_PROVISIONAL_FRACTION_CUTOFF,
} from "../../src/services/analysis.service";

// Plan §9.8 (docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md) — the deterministic
// month-end projection. Deliberately NOT wired into any client-facing
// surface (see insights.service.ts's `computeRecoveryProjection` doc
// comment) — these tests cover only the pure formula/guard logic.

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

const baseInput = {
  lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS,
  lookbackConfirmedSalesSum: 35000, // 5,000/day average over 7 days
  lookbackProvisionalSalesSum: 0,
  hasRecentSales: true,
  confirmedSalesThisMonth: 60000,
  remainingOperatingDays: 10,
  expectedMonthlyExpenses: 125000,
};

describe("deriveRecoveryProjection — guards", () => {
  it("returns insufficient_data when fewer than the minimum lookback open days exist", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS - 1 });
    expect(result.status).toBe("insufficient_data");
    expect(result.confidence).toBe("unavailable");
    expect(result.projectedMonthEndSales).toBeNull();
    expect(result.projectedVarianceAmount).toBeNull();
    expect(result.lookbackOperatingDays).toBe(PROJECTION_LOOKBACK_OPEN_DAYS - 1);
  });

  it("returns insufficient_data with lookbackOperatingDays 0 when no completed open days exist at all", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: 0, hasRecentSales: false });
    expect(result.status).toBe("insufficient_data");
    expect(result.lookbackOperatingDays).toBe(0);
  });

  it("returns stale_data when no sales at all were recorded in the recent window, even with enough lookback days", () => {
    const result = deriveRecoveryProjection({ ...baseInput, hasRecentSales: false });
    expect(result.status).toBe("stale_data");
    expect(result.confidence).toBe("unavailable");
    expect(result.projectedMonthEndSales).toBeNull();
  });

  it("prioritizes insufficient_data over stale_data when both conditions hold", () => {
    const result = deriveRecoveryProjection({
      ...baseInput,
      lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS - 1,
      hasRecentSales: false,
    });
    expect(result.status).toBe("insufficient_data");
  });

  it("returns insufficient_data when more than the provisional-fraction cutoff of the window's amount is provisional", () => {
    // 60% provisional, just over the 50% cutoff.
    const result = deriveRecoveryProjection({
      ...baseInput,
      lookbackConfirmedSalesSum: 4000,
      lookbackProvisionalSalesSum: 6000,
    });
    expect(result.status).toBe("insufficient_data");
    expect(result.projectedMonthEndSales).toBeNull();
  });

  it("still computes a projection when provisional share sits exactly at the cutoff (strictly-greater-than rule)", () => {
    const result = deriveRecoveryProjection({
      ...baseInput,
      lookbackConfirmedSalesSum: 5000,
      lookbackProvisionalSalesSum: 5000 * (PROJECTION_PROVISIONAL_FRACTION_CUTOFF / (1 - PROJECTION_PROVISIONAL_FRACTION_CUTOFF)),
    });
    expect(result.status).toBe("available");
  });

  it("does not divide by zero and does not treat a zero-amount confirmed window as over the provisional cutoff", () => {
    const result = deriveRecoveryProjection({
      ...baseInput,
      lookbackConfirmedSalesSum: 0,
      lookbackProvisionalSalesSum: 0,
    });
    expect(result.status).toBe("available");
    expect(result.projectedMonthEndSales).toBe(baseInput.confirmedSalesThisMonth);
  });
});

describe("deriveRecoveryProjection — formula", () => {
  it("matches the plan's exact formula for a known synthetic case", () => {
    // 35,000 confirmed over 7 lookback days -> 5,000/day average.
    // projectedMonthEndSales = confirmedSalesThisMonth + rate * remainingOperatingDays
    //                        = 60,000 + 5,000 * 10 = 110,000
    const result = deriveRecoveryProjection(baseInput);
    expect(result.status).toBe("available");
    expect(result.methodVersion).toBe(PROJECTION_METHOD_VERSION);
    expect(result.projectedMonthEndSales).toBe(110000);
    expect(result.projectedVarianceAmount).toBe(110000 - 125000);
  });

  it("excludes provisional sales from the recent-average rate entirely", () => {
    // Same confirmed amount as the base case, but with additional provisional
    // sales added that stay under the cutoff — the projected total must be
    // identical to the all-confirmed case, proving provisional amounts never
    // enter the rate.
    const withProvisional = deriveRecoveryProjection({
      ...baseInput,
      lookbackProvisionalSalesSum: 1000, // 1,000 / 36,000 ≈ 2.8%, well under the cutoff
    });
    const allConfirmed = deriveRecoveryProjection(baseInput);
    expect(withProvisional.projectedMonthEndSales).toBe(allConfirmed.projectedMonthEndSales);
  });

  it("projects zero additional sales when remainingOperatingDays is zero, using only confirmedSalesThisMonth", () => {
    const result = deriveRecoveryProjection({ ...baseInput, remainingOperatingDays: 0 });
    expect(result.projectedMonthEndSales).toBe(baseInput.confirmedSalesThisMonth);
  });
});

describe("deriveRecoveryProjection — confidence tiers", () => {
  it("is 'limited' exactly at the minimum lookback", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS });
    expect(result.confidence).toBe("limited");
  });

  it("is 'moderate' between the minimum and double the minimum", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS + 1 });
    expect(result.confidence).toBe("moderate");
  });

  it("is 'moderate' just below double the minimum", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS * 2 - 1 });
    expect(result.confidence).toBe("moderate");
  });

  it("is 'strong' at exactly double the minimum", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS * 2 });
    expect(result.confidence).toBe("strong");
  });

  it("is 'strong' well beyond double the minimum", () => {
    const result = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: PROJECTION_LOOKBACK_OPEN_DAYS * 4 });
    expect(result.confidence).toBe("strong");
  });

  it("every unavailable status reports confidence 'unavailable', never a tier", () => {
    const insufficient = deriveRecoveryProjection({ ...baseInput, lookbackOperatingDaysAvailable: 1 });
    const stale = deriveRecoveryProjection({ ...baseInput, hasRecentSales: false });
    expect(insufficient.confidence).toBe("unavailable");
    expect(stale.confidence).toBe("unavailable");
  });
});

describe("approximateElapsedOperatingDaysAsOf", () => {
  it("matches computeRecoveryTarget's approximation shape on the 1st of the month (zero elapsed)", () => {
    // A 30-day month, evaluated as of day 1: calendarDaysLeft = 30, so
    // remaining = round(operatingDays * 30/30) = operatingDays, elapsed = 0.
    expect(approximateElapsedOperatingDaysAsOf(25, utc(2026, 4, 1))).toBe(0);
  });

  it("grows across the month, never exceeding operatingDays", () => {
    const early = approximateElapsedOperatingDaysAsOf(25, utc(2026, 4, 5));
    const mid = approximateElapsedOperatingDaysAsOf(25, utc(2026, 4, 15));
    const late = approximateElapsedOperatingDaysAsOf(25, utc(2026, 4, 29));
    expect(early).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(late);
    expect(late).toBeLessThanOrEqual(25);
  });

  it("never returns a negative count even for a low operating-day count near month end", () => {
    expect(approximateElapsedOperatingDaysAsOf(8, utc(2026, 4, 30))).toBeGreaterThanOrEqual(0);
  });
});
