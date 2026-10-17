import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { prisma } from "../../src/config/prisma";
import { search } from "../../src/controllers/records.controller";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * Jumping to a numbered page with `offset`.
 *
 * The mobile Records list jumped to page 6,417 of a CSV-imported ledger by
 * walking the cursor chain, one request per page in between. `offset` finds
 * the page's opening cursor with one SQL query instead — and that query
 * restates the search filters and the merge order in SQL. These tests hold the
 * two together: for every filter and sort, each page reached by offset must be
 * byte-for-byte the page reached by walking cursors, including its cursors.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  other = await makeOwnerWithProfile({}, ["Inventory"]);
});
afterAll(disconnectDb);

type Item = { id: number; type: "expense" | "sales"; amount: number; date: string; description: string };
type Body = { items: Item[]; nextCursor: string | null; cursor?: string | null; totalCount?: number };

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

/** Ties on date and on amount, across both tables, so the merge order is exercised. */
async function seed() {
  const day = (n: number) => new Date(`2026-03-${String(n).padStart(2, "0")}T00:00:00.000Z`);
  const inventory = ctx.categories.Inventory!;
  const utilities = ctx.categories.Utilities!;
  const expenses = [
    [1, "Rice sack", 250, inventory, "MANUAL_ENTRY"],
    [2, "Power bill", 1200, utilities, "MANUAL_ENTRY"],
    [2, "Rice sack small", 250, inventory, "CSV_UPLOAD"],
    [3, "Cooking oil", 180, inventory, "CSV_UPLOAD"],
    [3, "Cooking oil 100%", 180, inventory, "RECEIPT_SCAN"],
    [4, "Water bill", 600, utilities, "CSV_UPLOAD"],
    [5, "Rice sack", 250, inventory, "MANUAL_ENTRY"],
    [5, "Gas", 900, inventory, "CSV_UPLOAD"],
    [6, "Eggs", 75, inventory, "MANUAL_ENTRY"],
    [7, "Rice sack", 250, inventory, "CSV_UPLOAD"],
  ] as const;
  await prisma.expenseRecord.createMany({
    data: expenses.map(([d, description, amount, categoryId, source]) => ({
      businessProfileId: ctx.profile.id, date: day(d), description, amount, categoryId, source,
    })),
  });
  const sales = [
    [1, "Rice meals", 250, "CSV_UPLOAD"],
    [2, "Rice meals", 900, "CSV_UPLOAD"],
    [3, "Takings", 180, "MANUAL_ENTRY"],
    [3, "Takings", 180, "CSV_UPLOAD"],
    [5, "Rice meals", 250, "CSV_UPLOAD"],
    [6, "Takings", 1200, "MANUAL_ENTRY"],
    [7, "Rice meals", 75, "CSV_UPLOAD"],
  ] as const;
  await prisma.salesReferenceRecord.createMany({
    data: sales.map(([d, description, amount, source]) => ({
      businessProfileId: ctx.profile.id, date: day(d), description, amount, source,
    })),
  });
  // Another owner's ledger, which no page of ctx may ever count or show.
  await prisma.expenseRecord.createMany({
    data: [1, 2, 3, 4, 5].map((d) => ({
      businessProfileId: other.profile.id, date: day(d), description: "Rice sack", amount: 250,
      categoryId: other.categories.Inventory!, source: "CSV_UPLOAD" as const,
    })),
  });
}

async function walk(query: Record<string, string | undefined>) {
  const pages: Array<{ cursor: string | undefined; body: Body }> = [];
  let cursor: string | undefined;
  do {
    const body = await runSearch({ ...query, cursor });
    pages.push({ cursor, body });
    cursor = body.nextCursor ?? undefined;
    if (pages.length > 100) throw new Error("pagination did not terminate");
  } while (cursor);
  return pages;
}

const SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"];

describe("records search — jumping to a page by offset", () => {
  beforeEach(seed);

  const filters: Array<[string, Record<string, string>]> = [
    ["everything", { type: "all" }],
    ["expenses only", { type: "expense" }],
    ["sales only", { type: "sales" }],
    ["a CSV source", { type: "all", source: "CSV_UPLOAD" }],
    ["receipts", { type: "all", source: "RECEIPT_SCAN" }],
    ["a category", { type: "all", categoryId: "__inventory__" }],
    ["a keyword", { type: "all", keyword: "rice" }],
    ["a keyword with a LIKE wildcard", { type: "all", keyword: "0%" }],
    ["a date range", { type: "all", dateFrom: "2026-03-02", dateTo: "2026-03-05" }],
  ];

  for (const [label, filter] of filters) {
    for (const sort of SORTS) {
      it(`matches the cursor walk for ${label}, ${sort}`, async () => {
        const query = {
          businessProfileId: String(ctx.profile.id),
          ...filter,
          ...(filter.categoryId ? { categoryId: String(ctx.categories.Inventory!) } : {}),
          sort,
          limit: "3",
          includeTotal: "true",
        };
        const pages = await walk(query);
        for (let index = 1; index < pages.length; index++) {
          const jumped = await runSearch({ ...query, offset: String(index * 3) });
          expect(jumped.items).toEqual(pages[index]!.body.items);
          expect(jumped.nextCursor).toBe(pages[index]!.body.nextCursor);
          expect(jumped.cursor).toBe(pages[index]!.cursor);
          expect(jumped.totalCount).toBe(pages[index]!.body.totalCount);
        }
      });
    }
  }

  it("answers an empty last page past the end instead of wrapping around", async () => {
    const body = await runSearch({ businessProfileId: String(ctx.profile.id), limit: "3", offset: "300", includeTotal: "true" });
    expect(body).toEqual({ items: [], nextCursor: null, cursor: null, totalCount: 17 });
  });

  it("treats offset 0 as the first page and ignores offset when a cursor is given", async () => {
    const base = { businessProfileId: String(ctx.profile.id), limit: "3" };
    const first = await runSearch(base);
    expect(await runSearch({ ...base, offset: "0" })).toEqual(first);
    const second = await runSearch({ ...base, cursor: first.nextCursor! });
    expect(await runSearch({ ...base, cursor: first.nextCursor!, offset: "12" })).toEqual(second);
  });

  it("refuses to jump into another owner's business", async () => {
    await expect(runSearch({ businessProfileId: String(other.profile.id), limit: "3", offset: "3" })).rejects.toThrow();
  });
});
