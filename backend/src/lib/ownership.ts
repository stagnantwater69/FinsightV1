import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";

type OwnershipDb = typeof prisma | Prisma.TransactionClient;

// Shared across every records-management service — never distinguish
// "doesn't exist" from "exists but belongs to someone else" (both 404),
// so ownership can't be probed from outside.
export async function requireOwnedBusinessProfile(
  userId: number,
  businessProfileId: number,
  db: OwnershipDb = prisma,
) {
  const profile = await db.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });
  if (!profile) {
    throw new ApiError(404, "Business profile not found");
  }
  return profile;
}
