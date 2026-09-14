import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-7, from the request side and the service side.
 *
 * tests/contract/receiptConfirmModes.test.ts pins the schema. This file pins
 * what an owner's client actually gets back for a mixed body (the ordinary
 * validation response, with nothing written) and that the service refuses
 * the same mixes on its own, since it is also called directly.
 */
const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { confirmReceipt } from "../../src/services/receiptScan.service";
import type { ConfirmInput } from "../../src/services/receiptScan/types";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
});

afterAll(disconnectDb);

async function makeReadScan(items: { name: string; amount: number }[] = []) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId: ctx.profile.id,
      imageFile: `${ctx.profile.id}/receipt.jpg`,
      confirmationStatus: "Pending",
      processingStatus: "Complete",
      items: {
        create: items.map((item, index) => ({ lineNumber: index + 1, name: item.name, amount: item.amount })),
      },
    },
    include: { items: { orderBy: { lineNumber: "asc" } } },
  });
}

const shared = { date: "2026-07-20", description: "Purchase from ABC Store", amount: 1000 };

function confirmOverHttp(scanId: number, body: Record<string, unknown>) {
  return request(app).post(`/api/v1/records/receipts/${scanId}/confirm`).set(...AUTH).send({ ...shared, ...body });
}

async function expectNothingWritten(scanId: number, itemCount: number) {
  expect(await prisma.expenseRecord.count()).toBe(0);
  expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scanId } })).toMatchObject({
    confirmationStatus: "Pending",
  });
  const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scanId } });
  expect(items).toHaveLength(itemCount);
  expect(items.every((item) => item.expenseRecordId === null && item.categoryId === null)).toBe(true);
}

describe("POST /records/receipts/:id/confirm", () => {
  it("accepts each mode on its own", async () => {
    const manualScan = await makeReadScan();
    const manual = await confirmOverHttp(manualScan.id, {
      splits: [{ categoryId: ctx.categories.Inventory, amount: 1000 }],
    });
    expect(manual.status).toBe(201);

    const itemisedScan = await makeReadScan([{ name: "Rice 25kg", amount: 950 }]);
    // A different description per scan, or the pre-save duplicate gate
    // answers 409 for the second receipt.
    const itemised = await confirmOverHttp(itemisedScan.id, {
      description: "Rice and ice",
      itemAssignments: [{ itemId: itemisedScan.items[0]!.id, categoryId: ctx.categories.Inventory }],
      additionalItems: [{ name: "Bagged ice", amount: 50, categoryId: ctx.categories.Inventory }],
      reconciliation: { mode: "none" },
    });
    expect(itemised.status).toBe(201);
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("answers a mixed body with the validation response and writes nothing", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: 1000 }]);
    const itemId = scan.items[0]!.id;
    const inventory = ctx.categories.Inventory!;
    const mixes: Record<string, unknown>[] = [
      { splits: [{ categoryId: inventory, amount: 1000 }], itemAssignments: [{ itemId, categoryId: inventory }] },
      { splits: [{ categoryId: inventory, amount: 1000 }], additionalItems: [{ name: "Ice", amount: 50, categoryId: inventory }] },
      { splits: [{ categoryId: inventory, amount: 1000 }], reconciliation: { mode: "proportional" } },
      {
        splits: [{ categoryId: inventory, amount: 1000 }],
        itemAssignments: [{ itemId, categoryId: inventory }],
        additionalItems: [{ name: "Ice", amount: 50, categoryId: inventory }],
        reconciliation: { mode: "proportional" },
      },
      {},
      { additionalItems: [{ name: "Ice", amount: 50, categoryId: inventory }] },
      { reconciliation: { mode: "none" } },
    ];

    for (const body of mixes) {
      const response = await confirmOverHttp(scan.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toEqual(
        expect.objectContaining({ formErrors: expect.any(Array), fieldErrors: expect.any(Object) }),
      );
      const detail = JSON.stringify(response.body.details);
      expect(detail).not.toContain("ABC Store");
      expect(detail).not.toContain("1000");
      await expectNothingWritten(scan.id, 1);
    }
  });

  it("refuses an unknown member nested inside a split rather than dropping it", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: 1000 }]);
    const response = await confirmOverHttp(scan.id, {
      splits: [{ categoryId: ctx.categories.Inventory, amount: 1000, itemIds: [scan.items[0]!.id] }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(JSON.stringify(response.body.details)).toContain("itemIds");
    await expectNothingWritten(scan.id, 1);
  });
});

describe("confirmReceipt called directly", () => {
  it("refuses every mixed shape before touching the scan", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: 1000 }]);
    const itemId = scan.items[0]!.id;
    const inventory = ctx.categories.Inventory!;
    const splits = [{ categoryId: inventory, amount: 1000 }];
    const itemAssignments = [{ itemId, categoryId: inventory }];
    const additionalItems = [{ name: "Ice", amount: 50, categoryId: inventory }];
    const reconciliation = { mode: "proportional" as const };

    const cases: { input: Record<string, unknown>; message: RegExp }[] = [
      { input: { splits, itemAssignments }, message: /not both/ },
      { input: { splits, additionalItems }, message: /additionalItems only applies/ },
      { input: { splits, reconciliation }, message: /reconciliation only applies/ },
      { input: { splits, itemAssignments, additionalItems, reconciliation }, message: /not both/ },
      { input: {}, message: /Send splits for a manual confirmation/ },
      { input: { additionalItems }, message: /Send splits for a manual confirmation/ },
    ];
    for (const { input, message } of cases) {
      await expect(confirmReceipt(ctx.user.id, scan.id, { ...shared, ...input } as ConfirmInput))
        .rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    }
    await expectNothingWritten(scan.id, 1);
  });

  it("still books each valid mode", async () => {
    const manualScan = await makeReadScan();
    const manual = await confirmReceipt(ctx.user.id, manualScan.id, {
      ...shared,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1000 }],
    });
    expect(manual).toHaveLength(1);

    const itemisedScan = await makeReadScan([
      { name: "Rice 25kg", amount: 600 },
      { name: "Electricity", amount: 400 },
    ]);
    const itemised = await confirmReceipt(ctx.user.id, itemisedScan.id, {
      ...shared,
      description: "Rice and electricity",
      itemAssignments: [
        { itemId: itemisedScan.items[0]!.id, categoryId: ctx.categories.Inventory! },
        { itemId: itemisedScan.items[1]!.id, categoryId: ctx.categories.Utilities! },
      ],
    });
    expect(itemised).toHaveLength(2);

    const ownerTypedScan = await makeReadScan();
    const ownerTyped = await confirmReceipt(ctx.user.id, ownerTypedScan.id, {
      ...shared,
      description: "Rice and ice, typed in",
      amount: 1050,
      itemAssignments: [],
      additionalItems: [
        { name: "Ice", amount: 50, categoryId: ctx.categories.Inventory! },
        { name: "Rice", amount: 1000, categoryId: ctx.categories.Inventory! },
      ],
      reconciliation: { mode: "none" },
    });
    expect(ownerTyped).toHaveLength(1);
    expect(ownerTyped[0]!.amount).toBe(1050);
  });
});
