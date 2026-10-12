import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../prisma/migrations/20261004203000_available_funds_same_day_classification/migration.sql", import.meta.url),
  "utf8",
).replace(/\s+/g, " ");

describe("available-funds same-day migration", () => {
  it.each([
    ["ExpenseRecord", "ExpenseRecord"],
    ["SalesReferenceRecord", "SalesReferenceRecord"],
  ])("adds, backfills, and constrains the %s classification pair", (_label, prefix) => {
    expect(migration).toContain(`"${prefix}_IncludedInAvailableFundsBaseline" BOOLEAN`);
    expect(migration).toContain(`"${prefix}_AvailableFundsDeltaBaselineAt" TIMESTAMP(3)`);
    expect(migration).toContain(
      `record."${prefix}_CreatedAt" <= profile."BusinessProfile_AvailableFundsBaselineAt"`,
    );
    expect(migration).toContain(
      `record."${prefix}_Date" = profile."BusinessProfile_AvailableFundsBaselineDate"`,
    );
    expect(migration).toContain(
      `("${prefix}_IncludedInAvailableFundsBaseline" IS NULL) = `
      + `("${prefix}_AvailableFundsDeltaBaselineAt" IS NULL)`,
    );
  });
});
