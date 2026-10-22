import fc from "fast-check";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { resolveBusinessToday, utcAddDays } from "../../src/lib/dates";
import {
  calculateAvailableFundsForOwnedBusiness,
  calculateAvailableFundsFromRecords,
} from "../../src/services/financialPosition.service";
import { requireOwnedBusinessContext } from "../../src/services/ownedBusinessContext.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/*
 * AvailableFundsDailyTotal is maintained by database triggers, and
 * calculateAvailableFundsForOwnedBusiness reads it. The figure it produces
 * must be EXACTLY what summing the records gives (calculateAvailableFunds-
 * FromRecords) after every kind of write any code path can make. These tests
 * drive random sequences of those writes straight at the tables, which is
 * where the triggers act, and compare the two after each one.
 */

beforeEach(resetDb);
afterAll(disconnectDb);

type Owner = Awaited<ReturnType<typeof makeOwnerWithProfile>>;

async function expectTotalsMatchRecords(owner: Owner, label: string) {
  const context = await requireOwnedBusinessContext(owner.user.id, owner.profile.id);
  const today = resolveBusinessToday(context.profile.timezone);
  const fromTotals = await calculateAvailableFundsForOwnedBusiness(context, today);
  const fromRecords = await calculateAvailableFundsFromRecords(context, today);
  expect(fromTotals, label).toEqual(fromRecords);
}

const day = (offset: number) => utcAddDays(resolveBusinessToday("Asia/Manila"), offset);

const recordSpec = fc.record({
  offset: fc.integer({ min: -12, max: 3 }),
  cents: fc.integer({ min: 1, max: 5_000_000 }),
  reviewed: fc.boolean(),
  duplicate: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
  source: fc.constantFrom("MANUAL_ENTRY", "CSV_UPLOAD", "RECEIPT_SCAN"),
  // Baseline-day classification: explicit anchor, legacy null pair, or included.
  anchor: fc.constantFrom("anchored-delta", "anchored-included", "legacy", "none"),
});

const operation = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("expense" as const), spec: recordSpec }), weight: 6 },
  { arbitrary: fc.record({ kind: fc.constant("sale" as const), spec: recordSpec }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("bulk-expenses" as const), specs: fc.array(recordSpec, { minLength: 2, maxLength: 6 }) }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      table: fc.constantFrom("expense", "sale"),
      pick: fc.nat(),
      change: fc.oneof(
        fc.record({ field: fc.constant("amount" as const), cents: fc.integer({ min: 1, max: 5_000_000 }) }),
        fc.record({ field: fc.constant("date" as const), offset: fc.integer({ min: -12, max: 3 }) }),
        fc.record({ field: fc.constant("review" as const), reviewed: fc.boolean() }),
        fc.record({ field: fc.constant("duplicate" as const), flagged: fc.boolean() }),
        fc.record({ field: fc.constant("duplicate-of" as const), otherPick: fc.nat() }),
      ),
    }),
    weight: 5,
  },
  { arbitrary: fc.record({ kind: fc.constant("review-day" as const), offset: fc.integer({ min: -12, max: 3 }), reviewed: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), table: fc.constantFrom("expense", "sale"), pick: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("batch-status" as const), status: fc.constantFrom("COMPLETE", "FAILED", "PROCESSING") }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("delete-batch" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("receipt-status" as const), confirmed: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("move-baseline" as const), offset: fc.integer({ min: -8, max: 2 }) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("neighbour" as const), spec: recordSpec }), weight: 1 },
);

interface World {
  owner: Owner;
  neighbour: Owner;
  batchId: number;
  scanId: number;
  expenseIds: number[];
  saleIds: number[];
}

async function newBatch(owner: Owner) {
  return (await prisma.cSVImportBatch.create({
    data: {
      businessProfileId: owner.profile.id,
      title: "Funds test import",
      uploadDate: new Date(),
      status: "Processing",
      processingStatus: "PROCESSING",
      fileReference: `${owner.profile.id}/funds-${Date.now()}-${Math.random()}.csv`,
    },
  })).id;
}

async function setUp(): Promise<World> {
  const owner = await makeOwnerWithProfile({}, ["Inventory"]);
  const neighbour = await makeOwnerWithProfile({}, ["Inventory"]);
  await prisma.businessProfile.update({
    where: { id: owner.profile.id },
    data: { availableFunds: 10_000, availableFundsBaselineDate: day(-5), availableFundsBaselineAt: new Date() },
  });
  const scan = await prisma.receiptScan.create({
    data: { businessProfileId: owner.profile.id, imageFile: "receipts/funds.jpg", processingStatus: "Complete", confirmationStatus: "Pending" },
  });
  return { owner, neighbour, batchId: await newBatch(owner), scanId: scan.id, expenseIds: [], saleIds: [] };
}

async function anchorFields(owner: Owner, anchor: string) {
  const { availableFundsBaselineAt } = await prisma.businessProfile.findUniqueOrThrow({ where: { id: owner.profile.id } });
  if (anchor === "anchored-delta") return { includedInAvailableFundsBaseline: false, availableFundsDeltaBaselineAt: availableFundsBaselineAt };
  if (anchor === "anchored-included") return { includedInAvailableFundsBaseline: true, availableFundsDeltaBaselineAt: availableFundsBaselineAt };
  return {};
}

type Spec = typeof recordSpec extends fc.Arbitrary<infer T> ? T : never;

async function expenseData(world: World, owner: Owner, spec: Spec) {
  return {
    businessProfileId: owner.profile.id,
    categoryId: owner.categories.Inventory!,
    date: day(spec.offset),
    description: `Expense ${spec.cents}`,
    amount: spec.cents / 100,
    source: spec.source as "MANUAL_ENTRY" | "CSV_UPLOAD" | "RECEIPT_SCAN",
    reviewStatus: spec.reviewed ? "Reviewed" : "Needs Review",
    duplicateStatus: spec.duplicate ? "Flagged" : "Not a Duplicate",
    importBatchId: owner === world.owner && spec.source === "CSV_UPLOAD" ? world.batchId : null,
    receiptScanId: owner === world.owner && spec.source === "RECEIPT_SCAN" ? world.scanId : null,
    ...(await anchorFields(owner, spec.anchor)),
  };
}

type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never;

async function apply(world: World, op: Operation) {
  const { owner } = world;
  switch (op.kind) {
    case "expense": {
      const created = await prisma.expenseRecord.create({ data: await expenseData(world, owner, op.spec) });
      world.expenseIds.push(created.id);
      return;
    }
    case "sale": {
      const created = await prisma.salesReferenceRecord.create({
        data: {
          businessProfileId: owner.profile.id,
          date: day(op.spec.offset),
          description: `Sale ${op.spec.cents}`,
          amount: op.spec.cents / 100,
          source: op.spec.source === "CSV_UPLOAD" ? "CSV_UPLOAD" : "MANUAL_ENTRY",
          reviewStatus: op.spec.reviewed ? "Reviewed" : "Needs Review",
          duplicateStatus: op.spec.duplicate ? "Flagged" : "Not a Duplicate",
          importBatchId: op.spec.source === "CSV_UPLOAD" ? world.batchId : null,
          ...(await anchorFields(owner, op.spec.anchor)),
        },
      });
      world.saleIds.push(created.id);
      return;
    }
    case "bulk-expenses": {
      const data = await Promise.all(op.specs.map((spec) => expenseData(world, owner, spec)));
      const created = await prisma.expenseRecord.createManyAndReturn({ data, select: { id: true } });
      world.expenseIds.push(...created.map((row) => row.id));
      return;
    }
    case "edit": {
      const ids = op.table === "expense" ? world.expenseIds : world.saleIds;
      if (ids.length === 0) return;
      const id = ids[op.pick % ids.length]!;
      const change = op.change;
      const data: Record<string, unknown> =
        change.field === "amount" ? { amount: change.cents / 100 }
        : change.field === "date" ? { date: day(change.offset) }
        : change.field === "review" ? { reviewStatus: change.reviewed ? "Reviewed" : "Needs Review" }
        : change.field === "duplicate" ? { duplicateStatus: change.flagged ? "Flagged" : "Not a Duplicate" }
        : { duplicateOfRecordId: ids[change.otherPick % ids.length] === id ? null : ids[change.otherPick % ids.length] };
      if (op.table === "expense") await prisma.expenseRecord.update({ where: { id }, data });
      else await prisma.salesReferenceRecord.update({ where: { id }, data });
      return;
    }
    case "review-day":
      // One statement touching many rows on one day.
      await prisma.expenseRecord.updateMany({
        where: { businessProfileId: owner.profile.id, date: day(op.offset) },
        data: { reviewStatus: op.reviewed ? "Reviewed" : "Needs Review" },
      });
      return;
    case "delete": {
      const ids = op.table === "expense" ? world.expenseIds : world.saleIds;
      if (ids.length === 0) return;
      const [id] = ids.splice(op.pick % ids.length, 1);
      // A follower points at this record; the FK clears it (an UPDATE the triggers must see too).
      if (op.table === "expense") await prisma.expenseRecord.delete({ where: { id: id! } });
      else await prisma.salesReferenceRecord.delete({ where: { id: id! } });
      return;
    }
    case "batch-status":
      await prisma.cSVImportBatch.update({ where: { id: world.batchId }, data: { processingStatus: op.status } });
      return;
    case "delete-batch":
      // Its records keep existing with ImportBatch_ID set to NULL by the FK.
      await prisma.cSVImportBatch.delete({ where: { id: world.batchId } });
      world.batchId = await newBatch(owner);
      return;
    case "receipt-status":
      await prisma.receiptScan.update({ where: { id: world.scanId }, data: { confirmationStatus: op.confirmed ? "Confirmed" : "Pending" } });
      return;
    case "move-baseline":
      await prisma.businessProfile.update({
        where: { id: owner.profile.id },
        data: { availableFundsBaselineDate: day(op.offset), availableFundsBaselineAt: new Date() },
      });
      return;
    case "neighbour":
      await prisma.expenseRecord.create({ data: await expenseData(world, world.neighbour, { ...op.spec, source: "MANUAL_ENTRY" }) });
      return;
  }
}

describe("available funds from daily totals", () => {
  it("equals the record-by-record sum after every write, in random sequences of every kind", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 5, maxLength: 30 }), async (ops) => {
        await resetDb();
        const world = await setUp();
        for (const [index, op] of ops.entries()) {
          await apply(world, op);
          await expectTotalsMatchRecords(world.owner, `after op ${index}: ${JSON.stringify(op)}`);
        }
        await expectTotalsMatchRecords(world.neighbour, "neighbour");
      }),
      { seed: Number(process.env.FC_SEED ?? 20261022), numRuns: Number(process.env.FC_RUNS ?? 25) },
    );
  });

  it("stays correct when two transactions write to the same day at once", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    await prisma.businessProfile.update({
      where: { id: owner.profile.id },
      data: { availableFundsBaselineDate: day(-3), availableFundsBaselineAt: new Date() },
    });
    const expense = (amount: number) => ({
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Inventory!,
      date: day(-1),
      description: `Concurrent ${amount}`,
      amount,
      source: "MANUAL_ENTRY" as const,
      reviewStatus: "Reviewed",
    });
    // The first transaction holds its write open while the second writes the
    // same day; without the lock, whichever recompute ran last would miss the
    // other's row.
    const first = prisma.$transaction(async (tx) => {
      await tx.expenseRecord.create({ data: expense(111) });
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = prisma.$transaction(async (tx) => {
      await tx.expenseRecord.create({ data: expense(222) });
    });
    await Promise.all([first, second]);

    const total = await prisma.availableFundsDailyTotal.findUniqueOrThrow({
      where: { businessProfileId_date: { businessProfileId: owner.profile.id, date: day(-1) } },
    });
    expect(Number(total.expenseAmount)).toBe(333);
    expect(total.expenseCount).toBe(2);
    await expectTotalsMatchRecords(owner, "after concurrent writes");
  });

  it("keeps an insert's addition when an update recomputes the same day while the insert is open", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    await prisma.businessProfile.update({
      where: { id: owner.profile.id },
      data: { availableFundsBaselineDate: day(-3), availableFundsBaselineAt: new Date() },
    });
    const existing = await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id, categoryId: owner.categories.Inventory!, date: day(-1),
        description: "Existing", amount: 100, source: "MANUAL_ENTRY", reviewStatus: "Reviewed",
      },
    });
    // The insert adds +50 and holds its transaction open. The update then
    // recomputes the day from a snapshot that cannot see the uncommitted
    // insert; without the lock that stale total would overwrite the +50 once
    // the insert commits.
    const insert = prisma.$transaction(async (tx) => {
      await tx.expenseRecord.create({
        data: {
          businessProfileId: owner.profile.id, categoryId: owner.categories.Inventory!, date: day(-1),
          description: "Added", amount: 50, source: "MANUAL_ENTRY", reviewStatus: "Reviewed",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const update = prisma.expenseRecord.update({ where: { id: existing.id }, data: { amount: 120 } });
    await Promise.all([insert, update]);

    const total = await prisma.availableFundsDailyTotal.findUniqueOrThrow({
      where: { businessProfileId_date: { businessProfileId: owner.profile.id, date: day(-1) } },
    });
    expect(Number(total.expenseAmount)).toBe(170);
    expect(total.expenseCount).toBe(2);
    await expectTotalsMatchRecords(owner, "after insert racing an update");
  });

  it("lets a business with records be deleted, and its totals go with it", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id, categoryId: owner.categories.Inventory!, date: day(-1),
        description: "Rice", amount: 50, source: "MANUAL_ENTRY", reviewStatus: "Reviewed",
      },
    });
    expect(await prisma.availableFundsDailyTotal.count({ where: { businessProfileId: owner.profile.id } })).toBe(1);
    await prisma.businessProfile.delete({ where: { id: owner.profile.id } });
    expect(await prisma.availableFundsDailyTotal.count({ where: { businessProfileId: owner.profile.id } })).toBe(0);
  });

  it("is invisible to the Data API: deny-all RLS, no client privileges, functions not callable", async () => {
    const [rls] = await prisma.$queryRaw<{ enabled: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS enabled, (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public."AvailableFundsDailyTotal"'::regclass`;
    expect(rls).toEqual({ enabled: true, policies: 0 });

    const tablePrivileges = await prisma.$queryRaw<{ role: string; allowed: boolean }[]>`
      SELECT r.rolname AS role,
             has_table_privilege(r.oid, 'public."AvailableFundsDailyTotal"', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed
      FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') ORDER BY r.rolname`;
    expect(tablePrivileges).toEqual([{ role: "anon", allowed: false }, { role: "authenticated", allowed: false }]);

    const callable = await prisma.$queryRaw<{ role: string; fn: string }[]>`
      SELECT r.rolname AS role, p.proname AS fn
      FROM pg_proc p CROSS JOIN pg_roles r
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'finsight\_%funds%'
        AND r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`;
    expect(callable).toEqual([]);
  });
});
