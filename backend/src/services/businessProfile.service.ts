import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { uploadBusinessLogo } from "./storage.service";
import type { BusinessProfile } from "@prisma/client";

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

function toDTO(profile: ProfileWithCount) {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    availableFunds: Number(profile.availableFunds),
    expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses),
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
async function findOwned(userId: number, id: number): Promise<ProfileWithCount> {
  const profile = await prisma.businessProfile.findFirst({ where: { id, userId }, include: withRecordCount });
  if (!profile) {
    throw new ApiError(404, "Business profile not found");
  }
  return profile;
}

export async function createBusinessProfile(userId: number, input: CreateInput) {
  const profile = await prisma.businessProfile.create({
    data: { userId, ...input },
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
  await findOwned(userId, id);
  const profile = await prisma.businessProfile.update({ where: { id }, data: input, include: withRecordCount });
  return toDTO(profile);
}

export async function updateBusinessLogo(
  userId: number,
  id: number,
  buffer: Buffer,
  mimetype: string,
  originalname: string,
) {
  await findOwned(userId, id);
  const logoUrl = await uploadBusinessLogo(id, buffer, mimetype, originalname);
  const profile = await prisma.businessProfile.update({ where: { id }, data: { logoUrl }, include: withRecordCount });
  return toDTO(profile);
}
