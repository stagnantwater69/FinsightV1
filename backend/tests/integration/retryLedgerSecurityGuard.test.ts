import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { checkMigrationDrift } from "../../src/config/migrationGuard";
import { disconnectDb } from "../setup/testDb";

/**
 * The startup guard over the two retry ledgers, ManualRecordCreateRequest and
 * ChatSendRequest. A matching migration history cannot show that someone later
 * switched RLS off or loosened an ownership key, so each control is taken
 * apart here and the guard has to name it. Every case puts the control back.
 */

afterAll(disconnectDb);

const TABLES = [
  ["ManualRecordCreateRequest", "manual_record_create_request"],
  ["ChatSendRequest", "chat_send_request"],
] as const;

async function expectDrift(issue: string): Promise<void> {
  await expect(checkMigrationDrift()).resolves.toMatchObject({
    status: "drift",
    schemaIssues: expect.arrayContaining([issue]),
  });
}

async function expectClean(): Promise<void> {
  await expect(checkMigrationDrift()).resolves.toMatchObject({ status: "ok", schemaIssues: [] });
}

async function ensureRole(name: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${name}) AS present
  `;
  if (row?.present) return false;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${name}" NOLOGIN`);
  return true;
}

describe("startup guard: retry ledger security", () => {
  it("accepts the ledgers as the migrations leave them", expectClean);

  it.each(TABLES)("rejects %s with row level security switched off", async (table, slug) => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
    try {
      await expectDrift(`security.${slug}_rls`);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    }
    await expectClean();
  });

  it.each(TABLES)("rejects %s once any policy opens it", async (table, slug) => {
    await prisma.$executeRawUnsafe(`CREATE POLICY qa_open_read ON "${table}" FOR SELECT USING (TRUE)`);
    try {
      await expectDrift(`security.${slug}_no_policies`);
    } finally {
      await prisma.$executeRawUnsafe(`DROP POLICY qa_open_read ON "${table}"`);
    }
    await expectClean();
  });

  it.each(TABLES)("rejects a PUBLIC grant on %s", async (table) => {
    await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE "${table}" TO PUBLIC`);
    try {
      await expectDrift("security.retry_ledgers_no_public_grants");
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC`);
    }
    await expectClean();
  });

  it.each([
    ["anon", "ManualRecordCreateRequest"],
    ["authenticated", "ChatSendRequest"],
  ])("rejects a direct %s grant on %s", async (role, table) => {
    const created = await ensureRole(role);
    try {
      await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE "${table}" TO "${role}"`);
      try {
        await expectDrift("security.retry_ledgers_no_direct_api_grants");
      } finally {
        await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM "${role}"`);
      }
      await expectClean();
    } finally {
      if (created) await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  });

  it("rejects a manual-create link that no longer has to match the request's business", async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "ManualRecordCreateRequest" DROP CONSTRAINT "ManualRecordCreateRequest_expense_scope_check"`);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "ManualRecordCreateRequest" ADD CONSTRAINT "ManualRecordCreateRequest_expense_scope_check"
      CHECK ("ExpenseRecord_ID" IS NULL OR "ExpenseRecord_BusinessProfile_ID" IS NOT NULL)
    `);
    try {
      await expectDrift("constraint.manual_record_create_expense_scope");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "ManualRecordCreateRequest" DROP CONSTRAINT "ManualRecordCreateRequest_expense_scope_check"`);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "ManualRecordCreateRequest" ADD CONSTRAINT "ManualRecordCreateRequest_expense_scope_check" CHECK (
          ("ExpenseRecord_ID" IS NULL AND "ExpenseRecord_BusinessProfile_ID" IS NULL)
          OR (
            "ExpenseRecord_ID" IS NOT NULL
            AND "ExpenseRecord_BusinessProfile_ID" IS NOT NULL
            AND "ManualRecordCreateRequest_Kind" = 'EXPENSE'
            AND "ExpenseRecord_BusinessProfile_ID" = "BusinessProfile_ID"
          )
        )
      `);
    }
    await expectClean();
  });

  it("rejects a chat send whose owner key dropped the user column", async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "ChatSendRequest" DROP CONSTRAINT "ChatSendRequest_profile_owner_fkey"`);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "ChatSendRequest" ADD CONSTRAINT "ChatSendRequest_profile_owner_fkey"
      FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE
    `);
    try {
      await expectDrift("foreign_key.chat_send_profile_owner");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "ChatSendRequest" DROP CONSTRAINT "ChatSendRequest_profile_owner_fkey"`);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "ChatSendRequest" ADD CONSTRAINT "ChatSendRequest_profile_owner_fkey"
        FOREIGN KEY ("BusinessProfile_ID", "User_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID")
        ON DELETE CASCADE ON UPDATE CASCADE
      `);
    }
    await expectClean();
  });
});
