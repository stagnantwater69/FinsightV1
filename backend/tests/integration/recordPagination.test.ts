import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { prisma } from "../../src/config/prisma";
import { search } from "../../src/controllers/records.controller";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
});
afterAll(disconnectDb);

async function page(cursor?: string) {
  let body: { items: Array<{ id: number; type: "expense" | "sales" }>; nextCursor: string | null } | undefined;
  const req = {
    user: { id: ctx.user.id },
    query: { businessProfileId: String(ctx.profile.id), type: "all", limit: "2", cursor },
  } as unknown as Request;
  const res = {
    status() { return this; },
    json(value: typeof body) { body = value; return this; },
  } as unknown as Response;
  await search(req, res);
  return body!;
}

describe("combined record keyset pagination", () => {
  it("returns every same-day expense and sale exactly once in deterministic order", async () => {
    const date = new Date("2026-08-01");
    await prisma.expenseRecord.createMany({
      data: [1, 2, 3].map((n) => ({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date,
        description: `Expense ${n}`,
        amount: n,
        source: "MANUAL_ENTRY",
      })),
    });
    await prisma.salesReferenceRecord.createMany({
      data: [1, 2, 3].map((n) => ({
        businessProfileId: ctx.profile.id,
        date,
        description: `Sale ${n}`,
        amount: n,
        source: "MANUAL_ENTRY",
      })),
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(cursor);
      seen.push(...result.items.map((record) => `${record.type}-${record.id}`));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(["expense-3", "expense-2", "expense-1", "sales-3", "sales-2", "sales-1"]);
    expect(new Set(seen).size).toBe(6);
  });
});
