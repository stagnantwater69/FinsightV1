import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Category splits of one receipt share its date and vendor. With the
 * vendor-based duplicate identity, two equal splits looked like duplicates of
 * each other and the second was written Flagged. Records from the same scan
 * are never duplicates of one another.
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
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
});

afterAll(disconnectDb);

async function makeReadScan() {
  return prisma.receiptScan.create({
    data: {
      businessProfileId: ctx.profile.id,
      imageFile: `${ctx.profile.id}/receipt.jpg`,
      confirmationStatus: "Pending",
      processingStatus: "Complete",
    },
  });
}

function confirm(scanId: number, body: Record<string, unknown>) {
  return request(app).post(`/api/v1/records/receipts/${scanId}/confirm`).set(...AUTH).send(body);
}

describe("equal-amount splits of one receipt", () => {
  it("are not flagged as duplicates of each other", async () => {
    const scan = await makeReadScan();
    const response = await confirm(scan.id, {
      date: "2026-09-10",
      description: "Puregold run",
      vendor: "Puregold",
      amount: 1000,
      splits: [
        { categoryId: ctx.categories.Inventory, amount: 500, description: "Rice" },
        { categoryId: ctx.categories.Utilities, amount: 500, description: "LPG refill" },
      ],
    });
    expect(response.status).toBe(201);

    const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id }, orderBy: { id: "asc" } });
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.duplicateStatus)).toEqual(["Not a Duplicate", "Not a Duplicate"]);
    expect(records.every((record) => record.duplicateOfRecordId === null)).toBe(true);
    expect(await prisma.notification.count({ where: { type: "POSSIBLE_DUPLICATE" } })).toBe(0);
  });

  it("still flag a genuine earlier record from another source", async () => {
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: new Date("2026-09-10"),
        description: "Rice",
        vendor: "Puregold",
        amount: 500,
        source: "MANUAL_ENTRY",
      },
    });
    const scan = await makeReadScan();
    const response = await confirm(scan.id, {
      date: "2026-09-10",
      description: "Puregold run",
      vendor: "Puregold",
      amount: 500,
      splits: [{ categoryId: ctx.categories.Inventory, amount: 500, description: "Rice" }],
    });
    // The pre-save duplicate gate may answer 409 first; either outcome must
    // keep the earlier manual record as the duplicate reference.
    if (response.status === 201) {
      const record = await prisma.expenseRecord.findFirstOrThrow({ where: { receiptScanId: scan.id } });
      expect(record.duplicateStatus).toBe("Flagged");
      expect(record.duplicateOfRecordId).not.toBeNull();
    } else {
      expect(response.status).toBe(409);
    }
  });
});
