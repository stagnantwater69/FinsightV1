import { AccountDeletionStage, AccountStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DAT-001 — the receipt data that outlived the account that owned it.
 *
 * `prisma.user.delete` cascades through BusinessProfile to records, categories
 * and notifications, but ReceiptScan's link to the profile is `onDelete:
 * SetNull` — so deleting the owner DETACHED their scans instead of removing
 * them. Each surviving row still held the receipt's raw OCR text, extracted
 * vendor, amount and date, and the storage paths of the photographs; pages,
 * items and field corrections cascade from the SCAN, so they survived with it.
 * Unreachable to the person who asked for their data to be deleted, and still
 * present in the database.
 *
 * These tests assert on the absence of ROWS, per table, because "the account
 * is gone" was already true while all of this was still there.
 */
const { storageDeleted } = vi.hoisted(() => ({ storageDeleted: [] as string[] }));

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        admin: {
          deleteUser: async () => ({ data: {}, error: null }),
        },
      },
    },
  };
});

vi.mock("../../src/services/storage.service", () => ({
  deleteReceiptImage: async (p: string) => (storageDeleted.push(p), true),
  deleteCsvFile: async (p: string) => (storageDeleted.push(p), true),
  deletePublicImageUrl: async (p: string) => (storageDeleted.push(p), true),
}));

import { prisma } from "../../src/config/prisma";
import { runAccountDeletionWorkerOnce } from "../../src/services/accountDeletion.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  storageDeleted.length = 0;
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
});
afterAll(disconnectDb);

/** A scan with everything that hangs off one: a page, an item, a correction. */
async function makeScanWithChildren(businessProfileId: number, categoryId: number, label: string) {
  const scan = await prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `receipts/${label}-1.jpg`,
      processingStatus: "Complete",
      confirmationStatus: "Confirmed",
      extractedVendor: `${label} Sari-Sari`,
      extractedAmount: 1234.56,
      extractedDate: utcDay(-1),
      rawText: `${label} TOTAL 1,234.56`,
      pages: { create: [{ pageNumber: 1, imageFile: `receipts/${label}-1.jpg` }] },
      items: { create: [{ lineNumber: 1, name: "Rice", amount: 1234.56, categoryId }] },
      corrections: {
        create: [{ field: "amount", source: "ocr", wasEdited: false, originalValue: "1234.56", finalValue: "1234.56" }],
      },
    },
  });
  return scan;
}

async function drainDeletion(userId: number) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      status: AccountStatus.DELETION_PENDING,
      deletionRequestedAt: new Date(),
      deletionStage: AccountDeletionStage.REQUESTED,
    },
  });
  // storage → auth → rows.
  for (let i = 0; i < 3; i++) await runAccountDeletionWorkerOnce();
}

describe("account deletion leaves no receipt data behind", () => {
  it("removes the scan, its pages, its items and its field corrections", async () => {
    const scan = await makeScanWithChildren(ctx.profile.id, ctx.categories.Inventory!, "alpha");

    await drainDeletion(ctx.user.id);

    expect(await prisma.user.findUnique({ where: { id: ctx.user.id } })).toBeNull();
    expect(await prisma.receiptScan.count()).toBe(0);
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: scan.id } })).toBe(0);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id } })).toBe(0);
    expect(await prisma.receiptFieldCorrection.count({ where: { receiptScanId: scan.id } })).toBe(0);
  });

  it("still deletes the stored photographs before the rows that name them", async () => {
    await makeScanWithChildren(ctx.profile.id, ctx.categories.Inventory!, "beta");

    await drainDeletion(ctx.user.id);

    expect(storageDeleted).toContain("receipts/beta-1.jpg");
  });

  it("touches nothing belonging to another business", async () => {
    await makeScanWithChildren(ctx.profile.id, ctx.categories.Inventory!, "mine");
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    const theirs = await makeScanWithChildren(other.profile.id, other.categories.Inventory!, "theirs");

    await drainDeletion(ctx.user.id);

    const survivors = await prisma.receiptScan.findMany();
    expect(survivors.map((scan) => scan.id)).toEqual([theirs.id]);
    expect(survivors[0]!.businessProfileId).toBe(other.profile.id);
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: theirs.id } })).toBe(1);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: theirs.id } })).toBe(1);
    expect(await prisma.receiptFieldCorrection.count({ where: { receiptScanId: theirs.id } })).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: other.user.id } })).not.toBeNull();
  });

  it("does not sweep up scans already detached from any profile", async () => {
    // A scan orphaned by an EARLIER deletion cannot be attributed to anyone.
    // Deleting it as part of this user's drain would be a cross-tenant delete
    // in disguise, so it is deliberately left for a one-off backfill.
    const orphan = await makeScanWithChildren(ctx.profile.id, ctx.categories.Inventory!, "orphan");
    await prisma.receiptScan.update({ where: { id: orphan.id }, data: { businessProfileId: null } });

    const owner = await makeOwnerWithProfile({ name: "Second Store" }, ["Inventory"]);
    await drainDeletion(owner.user.id);

    expect(await prisma.receiptScan.count({ where: { id: orphan.id } })).toBe(1);
  });

  it("removes provider consent, dispatch, business budget, and purge metadata", async () => {
    const scan = await makeScanWithChildren(ctx.profile.id, ctx.categories.Inventory!, "provider");
    const now = new Date();
    const terminalAt = new Date(now.getTime() + 1_000);
    const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const cycleEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const consent = await prisma.externalProcessingConsent.create({
      data: {
        businessProfileId: ctx.profile.id,
        actorUserId: ctx.user.id,
        provider: "gemini",
        policyVersion: "receipt-provider-policy-v1",
        purpose: "RECEIPT_EXTRACTION",
        allowedDataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
        processingRegion: "global",
        providerRetentionHours: 0,
      },
    });
    const resourceBudget = await prisma.externalProviderBudget.create({
      data: {
        businessProfileId: null,
        scope: "RESOURCE",
        provider: "gemini",
        unitType: "DOCUMENT",
        cycleStart,
        cycleEnd,
        limitUnits: 10,
        usedUnits: 2,
      },
    });
    const businessBudget = await prisma.externalProviderBudget.create({
      data: {
        businessProfileId: ctx.profile.id,
        scope: "BUSINESS",
        provider: "gemini",
        unitType: "DOCUMENT",
        cycleStart,
        cycleEnd,
        limitUnits: 10,
        usedUnits: 2,
      },
    });
    await prisma.externalProviderDispatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        receiptScanId: scan.id,
        receiptScanBusinessProfileId: ctx.profile.id,
        consentId: consent.id,
        resourceBudgetId: resourceBudget.id,
        resourceBudgetScope: "RESOURCE",
        businessBudgetId: businessBudget.id,
        businessBudgetScope: "BUSINESS",
        businessBudgetProfileId: ctx.profile.id,
        provider: "gemini",
        providerVersion: "gemini-3.5-flash-lite",
        providerRegion: "global",
        unitType: "DOCUMENT",
        cycleStart,
        reservationKeyHash: "a".repeat(64),
        inputHash: "b".repeat(64),
        preprocessingVersion: "preprocess-v1",
        schemaVersion: "normalized-v1",
        rescueReasonCode: "MISSING_CRITICAL_TOTAL",
        reservedUnits: 2,
        finalBillableUnits: 2,
        pageCount: 1,
        documentCount: 1,
        status: "SUCCEEDED",
        outcomeCode: "OK",
        submittedAt: terminalAt,
        completedAt: terminalAt,
      },
    });
    await prisma.receiptPurgeJob.create({
      data: {
        businessProfileId: ctx.profile.id,
        receiptScanId: scan.id,
        receiptScanBusinessProfileId: ctx.profile.id,
        requestKeyHash: "c".repeat(64),
        targetReferenceHash: "d".repeat(64),
        reason: "ACCOUNT_DELETION",
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    });

    await drainDeletion(ctx.user.id);

    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProcessingConsent.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count({ where: { scope: "BUSINESS" } })).toBe(0);
    expect(await prisma.receiptPurgeJob.count()).toBe(0);
    expect(await prisma.externalProviderBudget.findUnique({ where: { id: resourceBudget.id } })).toMatchObject({
      businessProfileId: null,
      scope: "RESOURCE",
      usedUnits: 2,
      reservedUnits: 0,
    });
  });
});
