import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import {
  publicReceiptProviderDetails,
  type ReceiptProviderPublicDetails,
} from "../config/receiptProvider";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";

export interface ReceiptProviderConsentGrant {
  provider: "gemini" | "veryfi";
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: ("RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE")[];
  region: string;
  retentionHours: number;
  trainingAllowed: false;
}

function consentDTO(consent: { id: number; grantedAt: Date; revokedAt: Date | null } | null) {
  return consent
    ? { reference: `consent:${consent.id}`, grantedAt: consent.grantedAt, revokedAt: consent.revokedAt }
    : null;
}

function activeConsentDTO(consent: {
  id: number;
  provider: string;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  allowedDataClasses: ("RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE")[];
  processingRegion: string;
  providerRetentionHours: number;
  providerTrainingAllowed: boolean;
  grantedAt: Date;
}) {
  return {
    reference: `consent:${consent.id}`,
    provider: consent.provider,
    policyVersion: consent.policyVersion,
    purpose: consent.purpose,
    dataClasses: consent.allowedDataClasses,
    region: consent.processingRegion,
    retentionHours: consent.providerRetentionHours,
    trainingAllowed: consent.providerTrainingAllowed,
    grantedAt: consent.grantedAt,
    revocable: true as const,
  };
}

async function requireActiveOwnedProfile(userId: number, businessProfileId: number) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  if (profile.archivedAt !== null) throw new ApiError(404, "Business profile not found");
  return profile;
}

function currentTermsMatch(input: ReceiptProviderConsentGrant, provider: ReceiptProviderPublicDetails): boolean {
  return (
    input.provider === provider.key &&
    input.policyVersion === provider.policyVersion &&
    input.purpose === provider.purpose &&
    input.region === provider.region &&
    input.retentionHours === provider.retentionHours &&
    input.trainingAllowed === false &&
    input.dataClasses.length === provider.dataClasses.length &&
    input.dataClasses.every((value, index) => value === provider.dataClasses[index])
  );
}

async function serializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw new Error("unreachable");
}

export async function getReceiptProviderConsentState(userId: number, businessProfileId: number) {
  await requireActiveOwnedProfile(userId, businessProfileId);
  const provider = publicReceiptProviderDetails();
  const activeConsents = await prisma.externalProcessingConsent.findMany({
    where: {
      businessProfileId,
      provider: { in: ["gemini", "veryfi"] },
      purpose: "RECEIPT_EXTRACTION",
      revokedAt: null,
    },
    orderBy: { id: "desc" },
    select: {
      id: true,
      provider: true,
      policyVersion: true,
      purpose: true,
      allowedDataClasses: true,
      processingRegion: true,
      providerRetentionHours: true,
      providerTrainingAllowed: true,
      grantedAt: true,
    },
  });
  if (!provider) {
    return { available: false as const, provider: null, consent: null, activeConsents: activeConsents.map(activeConsentDTO) };
  }
  const current = activeConsents.find(
    (consent) =>
      consent.provider === provider.key &&
      consent.policyVersion === provider.policyVersion &&
      consent.purpose === provider.purpose &&
      consent.processingRegion === provider.region &&
      consent.providerRetentionHours === provider.retentionHours &&
      consent.providerTrainingAllowed === false &&
      consent.allowedDataClasses.length === provider.dataClasses.length &&
      consent.allowedDataClasses.every((value, index) => value === provider.dataClasses[index]),
  );
  return {
    available: true as const,
    provider,
    consent: consentDTO(current ? { id: current.id, grantedAt: current.grantedAt, revokedAt: null } : null),
    activeConsents: activeConsents.map(activeConsentDTO),
  };
}

export async function grantReceiptProviderConsent(
  userId: number,
  businessProfileId: number,
  input: ReceiptProviderConsentGrant,
) {
  await requireActiveOwnedProfile(userId, businessProfileId);
  const provider = publicReceiptProviderDetails();
  if (!provider) throw new ApiError(404, "Receipt provider is not available");
  if (!currentTermsMatch(input, provider)) throw new ApiError(409, "Provider consent terms have changed");

  await serializable(() =>
    prisma.$transaction(
      async (tx) => {
        const activeProfile = await tx.businessProfile.findFirst({
          where: { id: businessProfileId, userId, archivedAt: null },
          select: { id: true },
        });
        if (!activeProfile) throw new ApiError(404, "Business profile not found");
        const current = await tx.externalProcessingConsent.findFirst({
          where: { businessProfileId, provider: provider.key, purpose: "RECEIPT_EXTRACTION", revokedAt: null },
          orderBy: { id: "desc" },
        });
        if (
          current &&
          current.actorUserId === userId &&
          current.policyVersion === provider.policyVersion &&
          current.processingRegion === provider.region &&
          current.providerRetentionHours === provider.retentionHours &&
          current.providerTrainingAllowed === false &&
          current.allowedDataClasses.length === provider.dataClasses.length &&
          current.allowedDataClasses.every((value, index) => value === provider.dataClasses[index])
        ) {
          return current;
        }
        const now = new Date();
        await tx.externalProcessingConsent.updateMany({
          where: { businessProfileId, provider: provider.key, purpose: "RECEIPT_EXTRACTION", revokedAt: null },
          data: { revokedAt: now },
        });
        return tx.externalProcessingConsent.create({
          data: {
            businessProfileId,
            actorUserId: userId,
            provider: provider.key,
            policyVersion: provider.policyVersion,
            purpose: "RECEIPT_EXTRACTION",
            allowedDataClasses: [...provider.dataClasses],
            processingRegion: provider.region,
            providerRetentionHours: provider.retentionHours,
            providerTrainingAllowed: false,
            grantedAt: now,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return getReceiptProviderConsentState(userId, businessProfileId);
}

export async function revokeReceiptProviderConsent(userId: number, businessProfileId: number) {
  await requireActiveOwnedProfile(userId, businessProfileId);
  const now = new Date();
  await serializable(() =>
    prisma.$transaction(
      (tx) =>
        tx.externalProcessingConsent.updateMany({
          where: {
            businessProfileId,
            provider: { in: ["gemini", "veryfi"] },
            purpose: "RECEIPT_EXTRACTION",
            revokedAt: null,
          },
          data: { revokedAt: now },
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  const provider = publicReceiptProviderDetails();
  return { available: provider !== null, provider, consent: null, activeConsents: [] };
}
