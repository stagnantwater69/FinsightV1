import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = join(__dirname, "../..");
const migration = readFileSync(
  join(backendRoot, "prisma/migrations/20260913075700_provider_consent_budget_dispatch_and_purge/migration.sql"),
  "utf8",
);
const schema = readFileSync(join(backendRoot, "prisma/schema.prisma"), "utf8");

function sqlTable(name: string): string {
  const match = new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`).exec(migration);
  if (!match) throw new Error(`Missing ${name} table in Phase 1 migration`);
  return match[1]!;
}

describe("Phase 1 database guardrails", () => {
  it.each([
    "ExternalProcessingConsent",
    "ExternalProviderBudget",
    "ExternalProviderDispatch",
    "ReceiptPurgeJob",
  ])("enables RLS and explicitly revokes direct client access for %s", (table) => {
    expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(migration).toMatch(new RegExp(`REVOKE ALL PRIVILEGES ON TABLE[\\s\\S]*"${table}"[\\s\\S]*FROM PUBLIC`));
    expect(migration).toMatch(/ARRAY\['anon', 'authenticated', 'service_role'\]/);
  });

  it("keeps direct Data API access deny-by-no-policy", () => {
    expect(migration).not.toMatch(/CREATE\s+POLICY/i);
    expect(migration).toContain("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(migration).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I");
    expect(migration).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I");
  });

  it("enforces tenant identity through composite foreign keys", () => {
    expect(migration).toContain(
      'FOREIGN KEY ("BusinessProfile_ID", "User_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("ReceiptScan_ID", "ReceiptScan_BusinessProfile_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("ExternalProcessingConsent_ID", "BusinessProfile_ID", "ExternalProviderDispatch_Provider")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("ExternalProviderDispatch_BusinessBudget_ID", "ExternalProviderDispatch_BusinessBudgetScope", "ExternalProviderDispatch_BusinessBudgetProfile_ID", "ExternalProviderDispatch_Provider", "ExternalProviderDispatch_CycleStart", "ExternalProviderDispatch_UnitType")',
    );
  });

  it("makes the monthly limit a database invariant and permits only one active consent", () => {
    expect(migration).toMatch(
      /"ExternalProviderBudget_ReservedUnits"\s*<= "ExternalProviderBudget_LimitUnits" - "ExternalProviderBudget_UsedUnits"/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "ExternalProcessingConsent_active_business_provider_key"[\s\S]*WHERE "ExternalProcessingConsent_RevokedAt" IS NULL/,
    );
    expect(migration).toContain('"ExternalProviderDispatch_FinalBillableUnits" BETWEEN 0');
    expect(migration).toContain('AND "ExternalProviderDispatch_ReservedUnits"');
  });

  it("stores only bounded metadata in provider dispatch audit rows", () => {
    const dispatch = sqlTable("ExternalProviderDispatch");
    const columnNames = [...dispatch.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]!);

    expect(columnNames).toEqual(expect.arrayContaining([
      "ExternalProviderDispatch_ReservationKeyHash",
      "ExternalProviderDispatch_InputHash",
      "ExternalProviderDispatch_ProviderRequestIDHash",
      "ExternalProviderDispatch_RescueReasonCode",
      "ExternalProviderDispatch_PageCount",
      "ExternalProviderDispatch_Status",
    ]));
    expect(columnNames.some((name) => /(text|content|payload|image.?url|object.?path|item|card|payment)/i.test(name))).toBe(false);
    expect(dispatch).not.toMatch(/\b(JSON|JSONB|BYTEA|TEXT)\b/i);
  });

  it("adds a stable bounded processing error code without replacing owner review", () => {
    expect(schema).toMatch(/processingErrorCode\s+String\?\s+@map\("ReceiptScan_ProcessingErrorCode"\)\s+@db\.VarChar\(64\)/);
    expect(migration).toContain('"ReceiptScan_ProcessingErrorCode" ~ \'^[A-Z][A-Z0-9_]{0,63}$\'');
    expect(schema).toMatch(/confirmationStatus\s+String\s+@default\("Pending"\)/);
  });
});
