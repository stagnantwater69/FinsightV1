import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
// The REAL client constants, imported across the project boundary — not copies.
import { FIELD_LIMITS as mobileLimits } from "../../../mobile/src/lib/fieldLimits";
import { FIELD_LIMITS as webLimits } from "../../../web/src/lib/fieldLimits";
// Mobile's real interval ceiling, imported for the same reason. recurringAgenda.ts
// is deliberately free of React Native imports so it can be loaded here.
import { MAX_INTERVAL_DAYS as mobileMaxIntervalDays } from "../../../mobile/src/lib/recurringAgenda";

/**
 * The `maxLength` on every free-text box, pinned to the schema behind it.
 *
 * WHAT THESE ARE FOR. Nothing here is a security control — every one of these
 * fields is enforced by `z.string().max(n)` in a controller and by a
 * `VARCHAR(n)` column behind that. A `maxLength` attribute buys the thing
 * authValidation.ts exists for: an owner on a metered connection should not pay
 * for a round trip to be told something the form already knew, and a rejection
 * should not arrive after they have typed three paragraphs into a box that let
 * them.
 *
 * WHY THEY HAVE TO BE CHECKED. Two ways to get it wrong, both silent:
 *
 *   - a client cap LARGER than the server's lets someone fill a box with text
 *     the API will refuse — the round trip the attribute was meant to save;
 *   - a client cap SMALLER than the server's truncates input the API would have
 *     accepted, and `maxLength` truncates without saying anything at all, so
 *     the owner just finds their description mysteriously cut short.
 *
 * The second is the nastier one and the reason this file asserts equality
 * rather than "client ≤ server".
 *
 * The figures are read off the ACTUAL schemas by probing them, not restated
 * from the source — a restated number agrees with itself forever.
 */

/** The largest string a schema accepts for `field`, found by bisection. */
function schemaMax(schema: z.ZodTypeAny, field: string, base: Record<string, unknown>): number {
  const accepts = (length: number) => schema.safeParse({ ...base, [field]: "a".repeat(length) }).success;
  let low = 0;
  let high = 4096;
  if (accepts(high)) throw new Error(`${field} has no upper bound below ${high}`);
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (accepts(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/** The largest number a schema accepts for `field`, found by bisection. */
function schemaMaxNumber(schema: z.ZodTypeAny, field: string, base: Record<string, unknown>): number {
  const accepts = (value: number) => schema.safeParse({ ...base, [field]: value }).success;
  let low = 1;
  let high = 1_000_000;
  if (!accepts(low)) throw new Error(`${field} rejects ${low}, so there is no accepted value to bisect up from`);
  if (accepts(high)) throw new Error(`${field} has no upper bound below ${high}`);
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (accepts(mid)) low = mid;
    else high = mid;
  }
  return low;
}

describe("the two clients agree with each other", () => {
  it("holds identical figures", () => {
    expect(mobileLimits).toEqual(webLimits);
  });
});

describe("each client cap equals the server rule behind it", () => {
  /*
   * Imported lazily inside each case rather than at the top of the file so that
   * a controller which fails to load names itself in the failure, instead of
   * taking the whole suite down with an import error.
   */
  it("record description — ExpenseRecord and SalesReferenceRecord, VARCHAR(255)", async () => {
    const { createSchema } = await import("../../src/controllers/expenseRecord.controller");
    const base = { businessProfileId: 1, categoryId: 1, date: "2026-01-05", amount: 100 };
    expect(schemaMax(createSchema, "description", base)).toBe(webLimits.recordDescription);
  });

  it("vendor — ExpenseRecord, VARCHAR(150)", async () => {
    const { createSchema } = await import("../../src/controllers/expenseRecord.controller");
    const base = { businessProfileId: 1, categoryId: 1, date: "2026-01-05", amount: 100, description: "x" };
    expect(schemaMax(createSchema, "vendor", base)).toBe(webLimits.vendor);
  });

  it("business name and type — BusinessProfile, VARCHAR(150) and VARCHAR(100)", async () => {
    const { createSchema } = await import("../../src/controllers/businessProfile.controller");
    const base = {
      name: "x",
      type: "x",
      availableFunds: 1000,
      expectedMonthlyExpenses: 1000,
      operatingDays: 26,
    };
    expect(schemaMax(createSchema, "name", base)).toBe(webLimits.businessName);
    expect(schemaMax(createSchema, "type", base)).toBe(webLimits.businessType);
  });

  it("category name and description — ExpenseCategory, VARCHAR(100) and VARCHAR(255)", async () => {
    const { createSchema } = await import("../../src/controllers/expenseCategory.controller");
    const base = { businessProfileId: 1, name: "x" };
    expect(schemaMax(createSchema, "name", base)).toBe(webLimits.categoryName);
    expect(schemaMax(createSchema, "description", base)).toBe(webLimits.categoryDescription);
  });

  it("recurring schedule label — RecurringSchedule, VARCHAR(255)", async () => {
    const { createRecurringScheduleSchema } = await import("../../src/controllers/insights.controller");
    const base = {
      businessProfileId: 1,
      categoryId: 1,
      intervalDays: 30,
      expectedAmount: 9500,
      nextDueDate: "2026-01-31",
    };
    expect(schemaMax(createRecurringScheduleSchema, "label", base)).toBe(webLimits.recurringScheduleLabel);
  });

  /**
   * Used on web only today — mobile has no CSV import screen yet — but pinned
   * here anyway, because the constant exists in both mirrors and the moment it
   * IS wired up is exactly when nobody will re-derive the figure.
   */
  it("CSV import title — CSVImportBatch, VARCHAR(150)", async () => {
    const { confirmSchema } = await import("../../src/controllers/csvImport.controller");
    const base = {
      businessProfileId: 1,
      recordType: "expense",
      // A JSON STRING, not an object: this arrives as a multipart form field
      // alongside the file, so the schema parses it out of text.
      columnMapping: JSON.stringify({ date: "d", description: "p", amount: "a" }),
    };
    expect(schemaMax(confirmSchema, "title", base)).toBe(webLimits.importTitle);
  });

  /**
   * The one cap that is not a column width. Ask FinSight sends the question to
   * a paid model, so this bounds a bill rather than a database write — which is
   * why it is the cap that was already present on both clients before any of
   * the others.
   */
  it("AI question — a cost ceiling, not a column", async () => {
    const { askSchema } = await import("../../src/controllers/ai.controller");
    const base = { businessProfileId: 1, module: "Dashboard" };
    expect(schemaMax(askSchema, "question", base)).toBe(webLimits.aiQuestion);
  });
});

/**
 * The one client cap that is a NUMERIC bound rather than a string length.
 *
 * Same failure mode as the lengths above, worse consequence: the server's
 * refusal for an over-long interval is a bare `{ error: "Validation failed" }`,
 * so a client ceiling higher than the server's leaves the owner staring at a
 * message that names neither the box nor the limit. A ceiling LOWER than the
 * server's turns back an interval the API would have taken.
 *
 * Until now the figure was restated in three places — the controller, mobile's
 * MAX_INTERVAL_DAYS and web's `max={366}` — and the only test on it asserted
 * `MAX_INTERVAL_DAYS === 366`, which is the constant agreeing with itself. The
 * probe below reads the bound off the real schema, so widening the controller
 * without moving the clients fails here.
 */
describe("the interval ceiling on a recurring schedule", () => {
  const base = {
    businessProfileId: 1,
    categoryId: 1,
    label: "Rent",
    expectedAmount: 9500,
    nextDueDate: "2026-01-31",
  };

  it("mobile's MAX_INTERVAL_DAYS equals the server's own bound", async () => {
    const { createRecurringScheduleSchema } = await import("../../src/controllers/insights.controller");
    expect(schemaMaxNumber(createRecurringScheduleSchema, "intervalDays", base)).toBe(mobileMaxIntervalDays);
  });

  /**
   * Web states the same figure as a `max` attribute inside a .tsx page, which
   * cannot be imported into a backend test, so it is read out of the source
   * text instead. If the form is ever refactored to reference a shared
   * constant, this case will fail for want of the literal — at which point the
   * right move is to import that constant here, NOT to drop the check.
   */
  it("web's max attribute on the interval input carries the same figure", async () => {
    const { createRecurringScheduleSchema } = await import("../../src/controllers/insights.controller");
    const formPath = fileURLToPath(new URL("../../../web/src/pages/RecurringScheduleForm.tsx", import.meta.url));
    const source = readFileSync(formPath, "utf8");
    const match = /\bmax=\{(\d+)\}/.exec(source);
    expect(match, "no numeric max={n} found in RecurringScheduleForm.tsx").not.toBeNull();
    expect(Number(match![1])).toBe(schemaMaxNumber(createRecurringScheduleSchema, "intervalDays", base));
  });
});
