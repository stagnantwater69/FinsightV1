import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocateProportionally } from "../../src/lib/allocation";
import { MAX_MONEY_AMOUNT, moneyAmountSchema, nonnegativeMoneyAmountSchema } from "../../src/lib/money";
import { resolveBusinessToday, utcAddDays, utcDateKey, utcIsoWeekday, utcStartOfDay } from "../../src/lib/dates";
import { resolveReportingWindow } from "../../src/lib/reportingPeriod";
import { parseCsvDate } from "../../src/lib/csvDates";
import { decodeDateCursor, finishDatePage } from "../../src/lib/datePagination";
import { assertNotFutureDate, businessTodayKey } from "../../src/lib/transactionDate";
import { AMOUNT_EPSILON, computeRecoveryTarget } from "../../src/services/analysis.service";
import { reconcileSplits } from "../../src/services/receiptScan/reconciliation";
import { ApiError } from "../../src/middleware/error.middleware";

/*
 * GENERATED INPUTS, NOT HAND-PICKED EXAMPLES.
 *
 * The example tests beside this file pin cases someone thought of. These state
 * rules that must hold for EVERY input, and let fast-check search thousands of
 * centavo amounts, weights and calendar days for one that breaks them, then
 * shrink it to the smallest counterexample.
 *
 * Reproducible: the seed is fixed, so CI and a laptop see the same cases. A
 * failure prints its seed and path; rerun just that case with
 *   FC_SEED=<seed> npx vitest run tests/unit/financialInvariants.test.ts
 * Set FC_RUNS higher for a deeper local search.
 */
const SEED = Number(process.env.FC_SEED ?? 20261022);
const RUNS = Number(process.env.FC_RUNS ?? 500);
const settings = { seed: SEED, numRuns: RUNS };

const MAX_CENTAVOS = Math.round(MAX_MONEY_AMOUNT * 100);
const DAY_MS = 86_400_000;

/** A calendar day stored the way records store it: UTC midnight. */
const calendarDay = fc
  .integer({ min: Date.UTC(1990, 0, 1) / DAY_MS, max: Date.UTC(2100, 11, 31) / DAY_MS })
  .map((day) => new Date(day * DAY_MS));

/** Centavo amounts for receipt lines and sales: up to PHP 10 million. */
const centavos = (min = 1) => fc.integer({ min, max: 1_000_000_000 });

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const toCentavos = (amount: number) => Math.round(amount * 100);

function rejectsWith400(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) return true;
    throw error;
  }
}

describe("splitting an amount across categories", () => {
  const weights = fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 1, maxLength: 30 });

  it("always sums to exactly the amount, for tax and discounts alike", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), weights, (total, w) => {
        const parts = allocateProportionally(total, w);
        expect(parts).toHaveLength(w.length);
        expect(parts.every(Number.isInteger)).toBe(true);
        expect(sum(parts)).toBe(total);
      }),
      settings,
    );
  });

  it("gives each bucket its exact share rounded down or up, never further off", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), weights, (total, w) => {
        const parts = allocateProportionally(total, w);
        const totalWeight = sum(w);
        const effective = totalWeight === 0 ? w.map(() => 1) : w;
        const denominator = BigInt(totalWeight === 0 ? w.length : totalWeight);
        parts.forEach((part, i) => {
          // Floor of total * w / W, computed exactly.
          const numerator = BigInt(total) * BigInt(effective[i]!);
          let floor = numerator / denominator;
          if (numerator % denominator !== 0n && numerator < 0n) floor -= 1n;
          expect([floor, floor + 1n]).toContain(BigInt(part));
        });
      }),
      settings,
    );
  });

  it("gives a bucket with no weight nothing, unless every bucket is empty", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), weights, (total, w) => {
        fc.pre(sum(w) > 0);
        const parts = allocateProportionally(total, w);
        w.forEach((weight, i) => {
          if (weight === 0) expect(parts[i]).toBe(0);
        });
      }),
      settings,
    );
  });

  it("is deterministic: the same receipt confirmed twice splits the same way", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), weights, (total, w) => {
        expect(allocateProportionally(total, w)).toEqual(allocateProportionally(total, w));
      }),
      settings,
    );
  });
});

describe("the money amount the API accepts", () => {
  it("accepts every whole-centavo amount the column can hold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_CENTAVOS }), (c) => {
        expect(moneyAmountSchema.safeParse(c / 100).success).toBe(true);
        expect(nonnegativeMoneyAmountSchema.safeParse(c / 100).success).toBe(true);
      }),
      settings,
    );
  });

  it("rejects every amount with a third decimal place", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000_000 }), (mills) => {
        fc.pre(mills % 10 !== 0);
        expect(moneyAmountSchema.safeParse(mills / 1000).success).toBe(false);
      }),
      settings,
    );
  });

  it("rejects anything above the column's maximum", () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_CENTAVOS + 1, max: MAX_CENTAVOS * 10 }), (c) => {
        expect(moneyAmountSchema.safeParse(c / 100).success).toBe(false);
      }),
      settings,
    );
  });
});

describe("reconciling a receipt's items with its total", () => {
  const splits = fc
    .array(fc.record({ categoryId: fc.integer({ min: 1, max: 50 }), cents: centavos() }), { minLength: 1, maxLength: 12 })
    .map((rows) => rows.map(({ categoryId, cents }) => ({ categoryId, amount: cents / 100 })));

  it("spread proportionally, the records add up to the receipt total to the centavo, or are refused", () => {
    fc.assert(
      fc.property(splits, fc.integer({ min: -100_000_000, max: 100_000_000 }), (input, gap) => {
        const totalCentavos = sum(input.map((s) => toCentavos(s.amount))) + gap;
        fc.pre(totalCentavos > 0);
        let output: ReturnType<typeof reconcileSplits>;
        try {
          output = reconcileSplits(input, totalCentavos, { mode: "proportional" });
        } catch (error) {
          // The only refusal: a discount bigger than some category's items.
          expect(error).toBeInstanceOf(ApiError);
          expect(gap).toBeLessThan(0);
          return;
        }
        expect(sum(output.map((s) => toCentavos(s.amount)))).toBe(totalCentavos);
        expect(output.every((s) => s.amount > 0)).toBe(true);
        expect(output.map((s) => s.categoryId)).toEqual(input.map((s) => s.categoryId));
        if (gap !== 0) expect(sum(output.map((s) => toCentavos(s.allocatedCharges ?? 0)))).toBe(gap);
      }),
      settings,
    );
  });

  it("filed under one category, tax and charges add up exactly, and a discount is refused", () => {
    fc.assert(
      fc.property(splits, fc.integer({ min: -100_000_000, max: 100_000_000 }), (input, gap) => {
        const totalCentavos = sum(input.map((s) => toCentavos(s.amount))) + gap;
        fc.pre(totalCentavos > 0);
        const run = () => reconcileSplits(input, totalCentavos, { mode: "category", categoryId: 99 });
        if (gap < 0) {
          expect(rejectsWith400(run)).toBe(true);
          return;
        }
        const output = run();
        expect(sum(output.map((s) => toCentavos(s.amount)))).toBe(totalCentavos);
        expect(output.slice(0, input.length)).toEqual(input);
      }),
      settings,
    );
  });

  it("with no mode chosen, any unexplained difference is refused rather than saved", () => {
    fc.assert(
      fc.property(splits, fc.integer({ min: -100_000, max: 100_000 }), (input, gap) => {
        const totalCentavos = sum(input.map((s) => toCentavos(s.amount))) + gap;
        fc.pre(totalCentavos > 0);
        const run = () => reconcileSplits(input, totalCentavos, { mode: "none" });
        if (gap === 0) expect(run()).toEqual(input);
        else expect(rejectsWith400(run)).toBe(true);
      }),
      settings,
    );
  });
});

describe("the recovery target", () => {
  const amount = centavos(0).map((c) => c / 100);
  const approximateInput = fc.record({
    expectedMonthlyExpenses: amount,
    operatingDays: fc.integer({ min: 0, max: 31 }),
    salesThisMonth: amount,
    salesToday: amount,
    today: calendarDay,
  });

  it("produces finite numbers for every input, even with no open days or no baseline", () => {
    fc.assert(
      fc.property(approximateInput, (input) => {
        const result = computeRecoveryTarget(input);
        for (const [key, value] of Object.entries(result)) {
          if (typeof value === "number") expect(Number.isFinite(value), key).toBe(true);
        }
      }),
      settings,
    );
  });

  it("never asks for a negative amount, and asks for exactly what is still uncovered", () => {
    fc.assert(
      fc.property(approximateInput, (input) => {
        const result = computeRecoveryTarget(input);
        expect(result.remainingTarget).toBeGreaterThanOrEqual(0);
        expect(result.adjustedDailyTarget).toBeGreaterThanOrEqual(0);
        expect(result.remainingTarget).toBeCloseTo(Math.max(0, input.expectedMonthlyExpenses - input.salesThisMonth), 6);
      }),
      settings,
    );
  });

  it("splits the month's open days into elapsed and remaining without losing one", () => {
    fc.assert(
      fc.property(approximateInput, (input) => {
        fc.pre(input.operatingDays >= 1);
        const result = computeRecoveryTarget(input);
        expect(result.remainingOperatingDays).toBeGreaterThanOrEqual(1);
        expect(result.remainingOperatingDays).toBeLessThanOrEqual(input.operatingDays);
        expect(result.calendarDaysLeftInMonth).toBeGreaterThanOrEqual(1);
        expect(result.calendarDaysLeftInMonth).toBeLessThanOrEqual(result.daysInMonth);
        expect([28, 29, 30, 31]).toContain(result.daysInMonth);
      }),
      settings,
    );
  });

  it("never makes the target harder because more sales were recorded", () => {
    fc.assert(
      fc.property(approximateInput, amount, (input, extra) => {
        const before = computeRecoveryTarget(input);
        const after = computeRecoveryTarget({ ...input, salesThisMonth: input.salesThisMonth + extra });
        expect(after.remainingTarget).toBeLessThanOrEqual(before.remainingTarget + 1e-9);
        expect(after.adjustedDailyTarget).toBeLessThanOrEqual(before.adjustedDailyTarget + 1e-9);
        expect(after.paceVarianceAmount).toBeGreaterThanOrEqual(before.paceVarianceAmount - 1e-9);
      }),
      settings,
    );
  });

  it("calls the month covered exactly when nothing is left to earn, and never without a baseline", () => {
    fc.assert(
      fc.property(approximateInput, (input) => {
        const result = computeRecoveryTarget(input);
        if (input.expectedMonthlyExpenses <= 0) {
          expect(result.status).toBe("needs_setup");
          expect(result.onTrack).toBe(false);
          return;
        }
        expect(result.status === "covered").toBe(result.remainingTarget < AMOUNT_EPSILON);
      }),
      settings,
    );
  });

  it("reads a month with no open days left and money still owed as behind", () => {
    fc.assert(
      fc.property(
        approximateInput,
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 0, max: 31 }),
        (input, openDays, elapsed) => {
          fc.pre(input.expectedMonthlyExpenses - input.salesThisMonth >= AMOUNT_EPSILON);
          const result = computeRecoveryTarget({
            ...input,
            exactOperatingCalendar: {
              operatingDaysThisMonth: openDays,
              elapsedOperatingDays: Math.min(elapsed, openDays),
              remainingOperatingDays: 0,
            },
          });
          expect(result.status).toBe("behind");
        },
      ),
      settings,
    );
  });

  it("keeps provisional sales visible: a warning appears whenever some sales are unconfirmed", () => {
    fc.assert(
      fc.property(approximateInput, centavos(0), (input, confirmedCents) => {
        const confirmed = Math.min(confirmedCents / 100, input.salesThisMonth);
        const result = computeRecoveryTarget({
          ...input,
          recordEligibility: {
            confirmedSalesThisMonth: confirmed,
            pendingReviewSalesThisMonth: 0,
            possibleDuplicateSalesThisMonth: 0,
          },
        });
        expect(result.provisionalSalesThisMonth).toBeCloseTo(input.salesThisMonth - confirmed, 6);
        expect(result.dataWarnings.length > 0).toBe(result.provisionalSalesThisMonth > AMOUNT_EPSILON);
      }),
      settings,
    );
  });
});

describe("reporting periods", () => {
  const daySpan = (start: Date, end: Date) => Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;

  it("a week runs Monday to Sunday, contains today, and compares against as many days of last week", () => {
    fc.assert(
      fc.property(calendarDay, (today) => {
        const window = resolveReportingWindow({ kind: "week" }, today);
        expect(utcIsoWeekday(window.start!)).toBe(1);
        expect(daySpan(window.start!, window.end!)).toBe(7);
        expect(today >= window.start! && today <= window.end!).toBe(true);
        expect(window.elapsedDays).toBe(daySpan(window.start!, today));
        expect(daySpan(window.previous!.start, window.previous!.end)).toBe(window.elapsedDays);
        expect(window.previous!.end < window.start!).toBe(true);
      }),
      settings,
    );
  });

  it("a month covers every one of its days, and its comparison is never longer than last month", () => {
    fc.assert(
      fc.property(calendarDay, calendarDay, (monthDay, today) => {
        const month = utcDateKey(monthDay).slice(0, 7);
        const window = resolveReportingWindow({ kind: "month", month }, today);
        expect(window.start!.getUTCDate()).toBe(1);
        expect(utcDateKey(window.start!).slice(0, 7)).toBe(month);
        expect(utcDateKey(window.end!).slice(0, 7)).toBe(month);
        expect(utcDateKey(utcAddDays(window.end!, 1)).slice(0, 7)).not.toBe(month);
        expect(daySpan(window.start!, window.end!)).toBe(window.days);
        expect(window.elapsedDays).toBeGreaterThanOrEqual(0);
        expect(window.elapsedDays).toBeLessThanOrEqual(window.days!);
        expect(window.previous!.start.getUTCDate()).toBe(1);
        expect(utcAddDays(window.previous!.start, 0) < window.start!).toBe(true);
        expect(window.previous!.end < window.start!).toBe(true);
      }),
      settings,
    );
  });

  it("a rolling window and the one before it are the same length and touch without overlapping", () => {
    fc.assert(
      fc.property(calendarDay, fc.integer({ min: 1, max: 366 }), (today, days) => {
        const window = resolveReportingWindow({ kind: "rolling", days }, today);
        expect(daySpan(window.start!, window.end!)).toBe(days);
        expect(daySpan(window.previous!.start, window.previous!.end)).toBe(days);
        expect(utcAddDays(window.previous!.end, 1).getTime()).toBe(window.start!.getTime());
      }),
      settings,
    );
  });
});

describe("dates", () => {
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Inside the parser's plausible range: 1990 up to today.
  const recordDay = fc
    .integer({ min: Date.UTC(1990, 0, 1) / DAY_MS, max: Math.floor(Date.now() / DAY_MS) })
    .map((day) => new Date(day * DAY_MS));

  it("reads a CSV date back to the same day in every supported format", () => {
    fc.assert(
      fc.property(recordDay, (day) => {
        const iso = utcDateKey(day);
        const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
        expect(parseCsvDate(iso, "iso")).toBe(iso);
        expect(parseCsvDate(`${d}/${m}/${y}`, "dmy")).toBe(iso);
        expect(parseCsvDate(`${m}/${d}/${y}`, "mdy")).toBe(iso);
        expect(parseCsvDate(`${d} ${MONTH_NAMES[m - 1]} ${y}`, "month-name")).toBe(iso);
        expect(parseCsvDate(`${MONTH_NAMES[m - 1]} ${d}, ${y}`, "month-name")).toBe(iso);
      }),
      settings,
    );
  });

  it("refuses a day that does not exist in its month", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1990, max: 2025 }), fc.integer({ min: 1, max: 12 }), (year, month) => {
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const missing = daysInMonth + 1;
        fc.pre(missing <= 31);
        expect(parseCsvDate(`${missing}/${month}/${year}`, "dmy")).toBeNull();
        expect(parseCsvDate(`${year}-${month}-${missing}`, "iso")).toBeNull();
      }),
      settings,
    );
  });

  it("puts a Manila business on its own calendar day, eight hours ahead of UTC", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 0, 1) }), (ms) => {
        const now = new Date(ms);
        expect(resolveBusinessToday("Asia/Manila", now).getTime()).toBe(utcStartOfDay(new Date(ms + 8 * 3_600_000)).getTime());
      }),
      settings,
    );
  });

  it("refuses a transaction date exactly when it is after the business's today", () => {
    fc.assert(
      fc.property(calendarDay, fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 0, 1) }), (date, ms) => {
        const now = new Date(ms);
        const future = utcDateKey(date) > businessTodayKey("Asia/Manila", now);
        expect(rejectsWith400(() => assertNotFutureDate(date, "Asia/Manila", now))).toBe(future);
      }),
      settings,
    );
  });

  it("a page cursor leads back to exactly the last row of its page", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 2_147_483_647 }), { minLength: 2, maxLength: 20 }),
        calendarDay,
        (ids, day) => {
          const rows = ids.map((id, i) => ({ id, date: utcAddDays(day, -i) }));
          const pageSize = rows.length - 1;
          const scope = "a".repeat(64);
          const { items, nextCursor } = finishDatePage(rows, pageSize, scope, (row) => row.date);
          expect(items).toHaveLength(pageSize);
          const decoded = decodeDateCursor(nextCursor!, scope);
          expect(decoded).toEqual({ id: items.at(-1)!.id, at: items.at(-1)!.date });
          // A cursor from another query is refused rather than misread.
          expect(rejectsWith400(() => decodeDateCursor(nextCursor!, "b".repeat(64)))).toBe(true);
        },
      ),
      settings,
    );
  });

  it("refuses any malformed cursor with a 400, never a server error", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (garbage) => {
        try {
          decodeDateCursor(garbage, "a".repeat(64));
        } catch (error) {
          expect(error).toBeInstanceOf(ApiError);
          expect((error as ApiError).status).toBe(400);
        }
      }),
      settings,
    );
  });
});
