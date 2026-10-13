import type { BusinessProfile } from "@prisma/client";
import { requireOwnedBusinessProfile } from "../lib/ownership";

declare const ownedBusinessContextBrand: unique symbol;

export type OwnedBusinessContext = Readonly<{
  userId: number;
  profile: BusinessProfile;
  [ownedBusinessContextBrand]: true;
}>;

export async function requireOwnedBusinessContext(
  userId: number,
  businessProfileId: number,
): Promise<OwnedBusinessContext> {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  return { userId, profile } as OwnedBusinessContext;
}
