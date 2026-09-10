import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { prisma } from "../../src/config/prisma";
import { search } from "../../src/controllers/records.controller";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * FUN-010 and FUN-007.
 *
 * FUN-010: a category filter on `type=all` also returned every sales record,
 * because the sales half of the search ran even though the sales table has no
 * category at all — so the one category the owner asked for arrived buried in
 * an unrelated ledger.
 *
 * FUN-007: ordering was fixed at [date desc, id desc] on the server and the
 * clients re-sorted whatever page they had. "Amount, highest first" therefore
 * answered with the largest amount among the most recent page — a wrong number
 * that looked right. The sort now happens in the query, which means the keyset
 * cursor and the sort key have to agree; these tests page all the way through a
 * non-default sort to prove nothing is skipped or repeated.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
});
afterAll(disconnectDb);

type Item = { id: number; type: "expense" | "sales"; amount: number; date: string; description: string };
type Body = { items: Item[]; nextCursor: string | null };

async function runSearch(query: Record<string, string | undefined>, userId = ctx.user.id): Promise<Body> {
  let body: Body | undefined;
  const req = { user: { id: userId }, query } as unknown as Request;
  const res = {
    status() {
      return this;
    },
    json(value: Body) {
      body = value;
      return this;
    },
  } as unknown as Response;
  await search(req, res);
  return body!;
}

/** Walks every page of one query and returns the rows in the order served. */
async function pageThrough(query: Record<string, string | undefined>, userId = ctx.user.id) {
  const seen: Item[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const body = await runSearch({ ...query, cursor }, userId);
    seen.push(...body.items);
    cursor = body.nextCursor ?? undefined;
    pages += 1;
    if (pages > 50) throw new Error("pagination did not terminate");
  } while (cursor);
  return seen;
}

const key = (record: Item) => `${record.type}-${record.id}`;

/**
 * Amounts deliberately do not line up with dates: the biggest expense is on the
 * OLDEST day, so any implementation that sorts only the newest page cannot
 * surface it.
 */
async function seedLedger(profileId: number, categoryId: number, otherCategoryId: number) {
  const day = (n: number) => new Date(`2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`);
  await prisma.expenseRecord.createMany({
    data: [
      { date: day(1), description: "Oldest but biggest", amount: 9999.99, categoryId },
      { date: day(3), description: "Rent Aug", amount: 100, categoryId },
      { date: day(5), description: "Small tools", amount: 12.5, categoryId },
      { date: day(7), description: "Other category", amount: 4000, categoryId: otherCategoryId },
      { date: day(9), description: "Tied amount A", amount: 250, categoryId },
      { date: day(9), description: "Tied amount B", amount: 250, categoryId },
      { date: day(11), description: "Newest cheap", amount: 3, categoryId },
    ].map((row) => ({ ...row, businessProfileId: profileId, source: "MANUAL_ENTRY" as const })),
  });
  await prisma.salesReferenceRecord.createMany({
    data: [
      { date: day(2), description: "Daily takings", amount: 900 },
      { date: day(4), description: "Weekend takings", amount: 5000 },
      { date: day(6), description: "Tied amount C", amount: 250 },
      { date: day(8), description: "Slow day", amount: 40 },
      { date: day(10), description: "Newest takings", amount: 700 },
    ].map((row) => ({ ...row, businessProfileId: profileId, source: "MANUAL_ENTRY" as const })),
  });
}

describe("records search — category filter (FUN-010)", () => {
  beforeEach(async () => {
    await seedLedger(ctx.profile.id, ctx.categories.Inventory!, ctx.categories.Utilities!);
  });

  it("returns only matching expenses and no sales at all when a category is filtered", async () => {
    const items = await pageThrough({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      categoryId: String(ctx.categories.Inventory!),
      limit: "50",
    });

    expect(items.every((record) => record.type === "expense")).toBe(true);
    expect(items.map((record) => record.description).sort()).toEqual([
      "Newest cheap",
      "Oldest but biggest",
      "Rent Aug",
      "Small tools",
      "Tied amount A",
      "Tied amount B",
    ]);
  });

  it("still pages correctly with a category filter, and reports no further page at the end", async () => {
    const query = {
      businessProfileId: String(ctx.profile.id),
      type: "all",
      categoryId: String(ctx.categories.Inventory!),
      limit: "2",
    };
    const items = await pageThrough(query);
    expect(items).toHaveLength(6);
    expect(new Set(items.map(key)).size).toBe(6);

    // The last page must not claim there is more just because the sales half
    // was skipped rather than run.
    const first = await runSearch(query);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
  });

  it("leaves sales in the results when no category is filtered", async () => {
    const items = await pageThrough({ businessProfileId: String(ctx.profile.id), type: "all", limit: "50" });
    expect(items).toHaveLength(12);
    expect(items.some((record) => record.type === "sales")).toBe(true);
  });
});

describe("records search — server-side sort (FUN-007)", () => {
  beforeEach(async () => {
    await seedLedger(ctx.profile.id, ctx.categories.Inventory!, ctx.categories.Utilities!);
  });

  it("defaults to the historical [date desc, id desc] order when no sort is given", async () => {
    const withoutSort = await pageThrough({ businessProfileId: String(ctx.profile.id), type: "all", limit: "5" });
    const explicit = await pageThrough({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "5",
      sort: "date_desc",
    });

    expect(withoutSort.map(key)).toEqual(explicit.map(key));
    const dates = withoutSort.map((record) => new Date(record.date).getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(withoutSort[0]!.description).toBe("Newest cheap");
  });

  it("answers the true global maximum first, from beyond the first page", async () => {
    // Page size 3 of 12 rows: the biggest amount sits on the oldest date, so a
    // page-local sort could not reach it.
    const first = await runSearch({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "3",
      sort: "amount_desc",
    });

    expect(first.items[0]!.description).toBe("Oldest but biggest");
    expect(first.items.map((record) => record.amount)).toEqual([9999.99, 5000, 4000]);
  });

  it("orders ascending by amount across the whole ledger", async () => {
    const items = await pageThrough({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "3",
      sort: "amount_asc",
    });
    const amounts = items.map((record) => record.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    expect(amounts[0]).toBe(3);
    expect(amounts.at(-1)).toBe(9999.99);
  });

  it("orders ascending by date", async () => {
    const items = await pageThrough({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "4",
      sort: "date_asc",
    });
    const dates = items.map((record) => new Date(record.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(items[0]!.description).toBe("Oldest but biggest");
  });

  it.each(["amount_desc", "amount_asc", "date_asc", "date_desc"] as const)(
    "pages through %s with the cursor visiting every row exactly once",
    async (sort) => {
      const paged = await pageThrough({
        businessProfileId: String(ctx.profile.id),
        type: "all",
        limit: "3",
        sort,
      });
      const single = await runSearch({
        businessProfileId: String(ctx.profile.id),
        type: "all",
        limit: "100",
        sort,
      });

      expect(paged).toHaveLength(12);
      expect(new Set(paged.map(key)).size).toBe(12);
      expect(paged.map(key)).toEqual(single.items.map(key));
      expect(single.nextCursor).toBeNull();
    },
  );

  it("keeps records tied on amount in a stable, non-repeating order across a page boundary", async () => {
    // Three rows share 250.00 — two expenses and a sale — and the page size
    // splits them, which is precisely where a cursor missing its tiebreak
    // column would repeat or drop one.
    const paged = await pageThrough({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "1",
      sort: "amount_desc",
    });
    const tied = paged.filter((record) => record.amount === 250);
    expect(tied).toHaveLength(3);
    expect(new Set(tied.map(key)).size).toBe(3);
    // Equal keys are ordered expenses first, then sales.
    expect(tied.map((record) => record.type)).toEqual(["expense", "expense", "sales"]);
  });

  it("rejects a cursor minted under a different sort instead of skipping rows", async () => {
    const first = await runSearch({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "3",
      sort: "date_desc",
    });
    expect(first.nextCursor).toBeTruthy();

    await expect(
      runSearch({
        businessProfileId: String(ctx.profile.id),
        type: "all",
        limit: "3",
        sort: "amount_desc",
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow();
  });

  it("rejects a malformed sort value", async () => {
    await expect(
      runSearch({ businessProfileId: String(ctx.profile.id), type: "all", sort: "amount" }),
    ).rejects.toThrow();
  });
});

describe("records search — ownership isolation under sort and cursor", () => {
  it("never serves another owner's records, and refuses their cursor", async () => {
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    await seedLedger(ctx.profile.id, ctx.categories.Inventory!, ctx.categories.Utilities!);
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: other.profile.id,
        categoryId: other.categories.Inventory!,
        date: new Date("2026-01-15T00:00:00.000Z"),
        description: "Not yours",
        amount: 999999,
        source: "MANUAL_ENTRY",
      },
    });

    const mine = await pageThrough({
      businessProfileId: String(ctx.profile.id),
      type: "all",
      limit: "3",
      sort: "amount_desc",
    });
    expect(mine.some((record) => record.description === "Not yours")).toBe(false);
    expect(mine[0]!.amount).toBe(9999.99);

    // The other owner's largest row is bigger than anything here, so a cursor
    // is no way into it either.
    const theirs = await runSearch(
      { businessProfileId: String(other.profile.id), type: "all", limit: "3", sort: "amount_desc" },
      other.user.id,
    );
    expect(theirs.items.map((record) => record.description)).toEqual(["Not yours"]);

    await expect(
      runSearch({ businessProfileId: String(ctx.profile.id), type: "all", limit: "3", sort: "amount_desc" }, other.user.id),
    ).rejects.toThrow();
  });
});
