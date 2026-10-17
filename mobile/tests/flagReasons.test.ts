import { describe, expect, it } from "vitest";
import { flagReasonText } from "../src/lib/flagReasons";
import type { RecordItem } from "../src/lib/types";

const profile = { expectedMonthlyExpenses: 100000, largeExpenseThresholdPercent: 10 };
const record = (overrides: Partial<RecordItem>) => ({ duplicateStatus: "None", duplicateOfRecordId: null, ...overrides }) as RecordItem;

describe("flagReasonText", () => {
  it("names the large-expense limit worked out from the profile", () => {
    expect(flagReasonText(record({ largeExpenseFlag: true }), profile)).toBe("over your PHP 10,000 large-expense limit");
  });

  it("names the record a duplicate points at, and joins both reasons", () => {
    expect(
      flagReasonText(record({ largeExpenseFlag: true, duplicateStatus: "Flagged", duplicateOfRecordId: 42 } as Partial<RecordItem>), profile),
    ).toBe("over your PHP 10,000 large-expense limit · possible duplicate of #42");
  });

  it("falls back to a neutral reason when neither flag explains it", () => {
    expect(flagReasonText(record({}), profile)).toBe("flagged for a second look");
  });
});
