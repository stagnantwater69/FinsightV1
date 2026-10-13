import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import {
  deletePublicImageUrl,
  deleteSupersededPublicImages,
  PUBLIC_IMAGE_UPLOAD_TRANSACTION_TIMEOUT_MS,
  publicImagePathFromUrl,
  uploadBusinessLogo,
  validatePublicImageUpload,
} from "./storage.service";
import { AccountStatus, CsvImportProcessingStatus, Prisma, type BusinessProfile } from "@prisma/client";
import { resolveBusinessToday, utcStartOfMonth } from "../lib/dates";
import { lockExpenseDuplicateWriteGate, lockSalesDuplicateWriteGate } from "../lib/recordLock";

interface CreateInput {
  name: string;
  type: string;
  availableFunds: number;
  expectedMonthlyExpenses: number;
  operatingDays: number;
  largeExpenseThresholdPercent?: number;
  timezone?: string;
}

interface UpdateInput {
  name?: string;
  type?: string;
  availableFunds?: number;
  expectedMonthlyExpenses?: number;
  operatingDays?: number;
  largeExpenseThresholdPercent?: number;
  timezone?: string;
}

// Every read/write path below includes this so the card grid in the web UI
// can show a "Records" figure without a second round trip per business.
const withRecordCount = {
  _count: { select: { expenseRecords: true, salesReferenceRecords: true } },
} as const;

type ProfileWithCount = BusinessProfile & {
  _count: { expenseRecords: number; salesReferenceRecords: number };
};

type BusinessProfileDb = Prisma.TransactionClient | typeof prisma;

function toDTO(profile: ProfileWithCount) {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    availableFunds: Number(profile.availableFunds),
    availableFundsBaselineAt: profile.availableFundsBaselineAt,
    availableFundsBaselineDate: profile.availableFundsBaselineDate.toISOString().slice(0, 10),
    expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses),
    expenseRecordsCompleteThroughMonth:
      profile.expenseRecordsCompleteThroughMonth?.toISOString().slice(0, 7) ?? null,
    expenseRecordsCompleteThroughConfirmedAt: profile.expenseRecordsCompleteThroughConfirmedAt,
    operatingDays: profile.operatingDays,
    largeExpenseThresholdPercent: Number(profile.largeExpenseThresholdPercent),
    timezone: profile.timezone,
    logoUrl: profile.logoUrl,
    createdAt: profile.createdAt,
    archivedAt: profile.archivedAt,
    isArchived: profile.archivedAt !== null,
    recordCount: profile._count.expenseRecords + profile._count.salesReferenceRecords,
  };
}

// Never distinguish "doesn't exist" from "exists but belongs to someone
// else" in the error — both return 404, so ownership can't be probed.
async function findOwned(
  userId: number,
  id: number,
  db: BusinessProfileDb = prisma,
): Promise<ProfileWithCount> {
  const profile = await db.businessProfile.findFirst({ where: { id, userId }, include: withRecordCount });
  if (!profile) {
    throw new ApiError(404, "Business profile not found");
  }
  return profile;
}

async function findActiveCsvImport(db: BusinessProfileDb, businessProfileId: number) {
  return db.cSVImportBatch.findFirst({
    where: {
      businessProfileId,
      processingStatus: {
        in: [CsvImportProcessingStatus.PENDING, CsvImportProcessingStatus.PROCESSING],
      },
    },
    select: { id: true },
  });
}

export async function createBusinessProfile(userId: number, input: CreateInput) {
  const availableFundsBaselineAt = new Date();
  const timezone = input.timezone ?? "Asia/Manila";
  const profile = await prisma.businessProfile.create({
    data: {
      userId,
      ...input,
      timezone,
      availableFundsBaselineAt,
      availableFundsBaselineDate: resolveBusinessToday(timezone, availableFundsBaselineAt),
    },
    include: withRecordCount,
  });
  return toDTO(profile);
}

export async function listBusinessProfiles(userId: number, includeArchived = false) {
  const profiles = await prisma.businessProfile.findMany({
    where: { userId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: "asc" },
    include: withRecordCount,
  });
  return profiles.map(toDTO);
}

/**
 * Soft delete. The profile and every record, insight and AI conversation
 * attached to it are left completely intact — only its visibility changes.
 *
 * There is deliberately no hard delete anywhere in this app. Every child
 * relation cascades from BusinessProfile, so a real delete would wipe an
 * owner's entire financial history for that business in one irreversible
 * click. For a tool whose value IS that history, archive is the correct
 * destructive-action ceiling.
 */
export async function archiveBusinessProfile(userId: number, id: number) {
  const existing = await findOwned(userId, id);
  if (existing.archivedAt) {
    return toDTO(existing); // already archived — idempotent, not an error
  }
  const profile = await prisma.businessProfile.update({
    where: { id },
    data: { archivedAt: new Date() },
    include: withRecordCount,
  });
  return toDTO(profile);
}

export async function restoreBusinessProfile(userId: number, id: number) {
  const existing = await findOwned(userId, id);
  if (!existing.archivedAt) {
    return toDTO(existing); // already active — idempotent
  }
  const profile = await prisma.businessProfile.update({
    where: { id },
    data: { archivedAt: null },
    include: withRecordCount,
  });
  return toDTO(profile);
}

export async function getBusinessProfile(userId: number, id: number) {
  const profile = await findOwned(userId, id);
  return toDTO(profile);
}

export async function updateBusinessProfile(userId: number, id: number, input: UpdateInput) {
  return prisma.$transaction(async (tx) => {
    let existing = await findOwned(userId, id, tx);
    const changesFunds = input.availableFunds !== undefined
      && !existing.availableFunds.equals(new Prisma.Decimal(input.availableFunds));

    if (!changesFunds) {
      const profile = await tx.businessProfile.update({ where: { id }, data: input, include: withRecordCount });
      return toDTO(profile);
    }

    const activeImport = await findActiveCsvImport(tx, id);
    if (activeImport) {
      throw new ApiError(409, "Wait for the active CSV import to finish before updating available funds", {
        code: "AVAILABLE_FUNDS_IMPORT_IN_PROGRESS",
      });
    }

    // The same lock order is used by mixed CSV chunks, preventing an anchor
    // from landing between an expense write and a sales write.
    await lockExpenseDuplicateWriteGate(tx, id);
    await lockSalesDuplicateWriteGate(tx, id);

    existing = await findOwned(userId, id, tx);
    if (existing.availableFunds.equals(new Prisma.Decimal(input.availableFunds!))) {
      const profile = await tx.businessProfile.update({ where: { id }, data: input, include: withRecordCount });
      return toDTO(profile);
    }
    const importAfterLock = await findActiveCsvImport(tx, id);
    if (importAfterLock) {
      throw new ApiError(409, "Wait for the active CSV import to finish before updating available funds", {
        code: "AVAILABLE_FUNDS_IMPORT_IN_PROGRESS",
      });
    }

    const availableFundsBaselineAt = new Date(Math.max(
      Date.now(),
      existing.availableFundsBaselineAt.getTime() + 1,
    ));
    const timezone = input.timezone ?? existing.timezone;
    const profile = await tx.businessProfile.update({
      where: { id },
      data: {
        ...input,
        availableFundsBaselineAt,
        availableFundsBaselineDate: resolveBusinessToday(timezone, availableFundsBaselineAt),
      },
      include: withRecordCount,
    });
    const classification = {
      includedInAvailableFundsBaseline: true,
      availableFundsDeltaBaselineAt: availableFundsBaselineAt,
    } as const;
    await tx.expenseRecord.updateMany({
      where: { businessProfileId: id, date: profile.availableFundsBaselineDate },
      data: classification,
    });
    await tx.salesReferenceRecord.updateMany({
      where: { businessProfileId: id, date: profile.availableFundsBaselineDate },
      data: classification,
    });
    return toDTO(profile);
  });
}

function monthKeyToDate(monthKey: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new ApiError(400, "completeThroughMonth must be in YYYY-MM format");
  }
  return new Date(`${monthKey}-01T00:00:00.000Z`);
}

export async function updateExpenseRecordsCompleteness(
  userId: number,
  id: number,
  completeThroughMonth: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await findOwned(userId, id, tx);
    const month = completeThroughMonth === null ? null : monthKeyToDate(completeThroughMonth);

    if (month) {
      const currentMonth = utcStartOfMonth(resolveBusinessToday(existing.timezone));
      if (month >= currentMonth) {
        throw new ApiError(400, "Only a completed month can be marked as having complete expense records", {
          code: "EXPENSE_RECORDS_MONTH_NOT_COMPLETE",
        });
      }
      if (await findActiveCsvImport(tx, id)) {
        throw new ApiError(409, "Wait for the active CSV import to finish before confirming expense records", {
          code: "EXPENSE_RECORDS_IMPORT_IN_PROGRESS",
        });
      }
    }

    const profile = await tx.businessProfile.update({
      where: { id },
      data: {
        expenseRecordsCompleteThroughMonth: month,
        expenseRecordsCompleteThroughConfirmedAt: month ? new Date() : null,
      },
      include: withRecordCount,
    });
    return toDTO(profile);
  });
}

export async function updateBusinessLogo(
  userId: number,
  id: number,
  buffer: Buffer,
  mimetype: string,
  originalname: string,
) {
  const validatedImage = await validatePublicImageUpload(buffer, mimetype);
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: AccountStatus }>>(Prisma.sql`
      SELECT "User_Status" AS status
      FROM "User"
      WHERE "User_ID" = ${userId}
      FOR UPDATE
    `);
    const owner = rows[0];
    if (!owner) throw new ApiError(404, "Business profile not found");
    if (owner.status !== AccountStatus.ACTIVE) {
      throw new ApiError(403, "This account is not active.", { code: "ACCOUNT_NOT_ACTIVE" });
    }

    const existing = await findOwned(userId, id, tx);
    const logoUrl = await uploadBusinessLogo(id, buffer, mimetype, originalname, validatedImage);
    const profile = await tx.businessProfile.update({ where: { id }, data: { logoUrl }, include: withRecordCount });
    return { profile, previousUrl: existing.logoUrl, logoUrl };
  }, { timeout: PUBLIC_IMAGE_UPLOAD_TRANSACTION_TIMEOUT_MS });

  const previousPath = result.previousUrl ? publicImagePathFromUrl(result.previousUrl) : null;
  const currentPath = publicImagePathFromUrl(result.logoUrl);
  if (result.previousUrl && previousPath && previousPath !== currentPath) {
    await deletePublicImageUrl(result.previousUrl);
  }
  await deleteSupersededPublicImages(`businesses/${id}`);
  const { profile } = result;
  return toDTO(profile);
}
