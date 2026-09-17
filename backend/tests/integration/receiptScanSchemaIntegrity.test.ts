import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

beforeEach(resetDb);
afterAll(disconnectDb);

async function makeScan(businessProfileId: number) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `receipts/${businessProfileId}/scan.jpg`,
      rawText: "TINDAHAN NI ALING NENA\nTOTAL 250.00",
      extractedVendor: "Tindahan ni Aling Nena",
    },
  });
}

/*
 * Both status columns are plain VARCHAR, so nothing in the Prisma client
 * stops a bad value: these go through raw SQL because that is also how a
 * stray value would really arrive — a future caller, a migration, someone at
 * a psql prompt. The point of the constraint is that the database refuses it
 * whatever wrote it.
 */
describe("ReceiptScan status columns are held to the sets the code queries", () => {
  it("refuses a confirmation status outside Pending / Confirmed / Deletion Pending", async () => {
    const { profile } = await makeOwnerWithProfile();
    const scan = await makeScan(profile.id);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ReceiptScan" SET "ReceiptScan_ConfirmationStatus" = 'Approved' WHERE "ReceiptScan_ID" = $1`,
        scan.id,
      ),
    ).rejects.toThrow(/ReceiptScan_confirmation_status_check/);

    const after = await prisma.receiptScan.findUnique({ where: { id: scan.id } });
    expect(after?.confirmationStatus).toBe("Pending");
  });

  it("refuses a processing status outside Processing / Complete / Failed", async () => {
    const { profile } = await makeOwnerWithProfile();
    const scan = await makeScan(profile.id);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ReceiptScan" SET "ReceiptScan_ProcessingStatus" = 'Done' WHERE "ReceiptScan_ID" = $1`,
        scan.id,
      ),
    ).rejects.toThrow(/ReceiptScan_processing_status_check/);
  });

  it("refuses an insert that would land outside either set", async () => {
    const { profile } = await makeOwnerWithProfile();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ReceiptScan" ("BusinessProfile_ID", "ReceiptScan_ProcessingStatus") VALUES ($1, 'queued')`,
        profile.id,
      ),
    ).rejects.toThrow(/ReceiptScan_processing_status_check/);
  });

  it("still accepts every value the services actually write", async () => {
    const { profile } = await makeOwnerWithProfile();
    const scan = await makeScan(profile.id);

    for (const confirmationStatus of ["Pending", "Confirmed", "Deletion Pending"]) {
      await prisma.receiptScan.update({ where: { id: scan.id }, data: { confirmationStatus } });
    }
    for (const processingStatus of ["Processing", "Complete", "Failed"]) {
      await prisma.receiptScan.update({ where: { id: scan.id }, data: { processingStatus } });
    }

    const after = await prisma.receiptScan.findUnique({ where: { id: scan.id } });
    expect(after?.confirmationStatus).toBe("Deletion Pending");
    expect(after?.processingStatus).toBe("Failed");
  });
});

/*
 * The ownerless-scan window. Account deletion sweeps a user's scans and then
 * deletes the user; a scan committed between those two steps used to be
 * detached rather than removed, and nothing would ever collect it again.
 * Deleting the profile row directly is the narrowest way to assert the
 * property that closes it: no receipt data outlives its profile, whatever
 * order the service happens to do things in.
 */
describe("a receipt scan cannot outlive the business profile that owned it", () => {
  it("takes the scan, its pages, items and corrections with the profile", async () => {
    const { profile } = await makeOwnerWithProfile();
    const scan = await makeScan(profile.id);

    await prisma.receiptScanPage.create({
      data: { receiptScanId: scan.id, pageNumber: 1, imageFile: "receipts/1/page-1.jpg", rawText: "TOTAL 250.00" },
    });
    await prisma.receiptScanItem.create({
      data: { receiptScanId: scan.id, lineNumber: 1, name: "Pandesal", amount: "250.00" },
    });
    await prisma.receiptFieldCorrection.create({
      data: { receiptScanId: scan.id, field: "amount", source: "ocr", wasEdited: false },
    });

    await prisma.businessProfile.delete({ where: { id: profile.id } });

    expect(await prisma.receiptScan.count()).toBe(0);
    expect(await prisma.receiptScanPage.count()).toBe(0);
    expect(await prisma.receiptScanItem.count()).toBe(0);
    expect(await prisma.receiptFieldCorrection.count()).toBe(0);
  });

  it("leaves no scan holding raw text or a storage path behind", async () => {
    const { profile } = await makeOwnerWithProfile();
    await makeScan(profile.id);

    await prisma.businessProfile.delete({ where: { id: profile.id } });

    const detached = await prisma.receiptScan.findMany({ where: { businessProfileId: null } });
    expect(detached).toEqual([]);
  });
});
