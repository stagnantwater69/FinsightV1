import { Prisma, type ExternalProcessingConsentSource } from "@prisma/client";
import { prisma } from "../config/prisma";
import {
  getReceiptProviderConfiguration,
  publicReceiptProviderDetails,
  type ReceiptProviderConfiguration,
  type ReceiptProviderPublicDetails,
} from "../config/receiptProvider";
import { logger } from "../config/logger";
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

interface ConsentRowTerms {
  businessProfileId: number;
  actorUserId: number;
  provider: "gemini" | "veryfi";
  policyVersion: string;
  dataClasses: readonly ("RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE")[];
  region: string;
  retentionHours: number;
  /** Omitted for an owner's own grant; the schema default is OWNER. */
  source?: ExternalProcessingConsentSource;
}

/** Closes every open receipt grant for the provider and opens one on the current terms. */
async function supersedeReceiptProviderConsent(tx: Prisma.TransactionClient, terms: ConsentRowTerms) {
  const now = new Date();
  await tx.externalProcessingConsent.updateMany({
    where: {
      businessProfileId: terms.businessProfileId,
      provider: terms.provider,
      purpose: "RECEIPT_EXTRACTION",
      revokedAt: null,
    },
    data: { revokedAt: now },
  });
  return tx.externalProcessingConsent.create({
    data: {
      businessProfileId: terms.businessProfileId,
      actorUserId: terms.actorUserId,
      provider: terms.provider,
      policyVersion: terms.policyVersion,
      purpose: "RECEIPT_EXTRACTION",
      allowedDataClasses: [...terms.dataClasses],
      processingRegion: terms.region,
      providerRetentionHours: terms.retentionHours,
      providerTrainingAllowed: false,
      grantedAt: now,
      ...(terms.source ? { source: terms.source } : {}),
    },
  });
}

/**
 * Policy grant for RECEIPT_PROVIDER_CONSENT_MODE=automatic, run inside the
 * dispatch reservation transaction so the grant and the dispatch commit together.
 * The owner's last action wins: an open grant is superseded like an owner
 * re-grant, a closed grant with nothing open is a revoke and is never overridden.
 * The row is marked OPERATOR_POLICY so it can be told from an owner's grant.
 * Returns null when no policy grant may be made.
 */
export async function grantReceiptProviderConsentByPolicy(
  tx: Prisma.TransactionClient,
  businessProfileId: number,
  config: ReceiptProviderConfiguration & { provider: "gemini" | "veryfi"; providerRegion: string; providerRetentionHours: number },
): Promise<{ id: number } | null> {
  if (config.consentMode !== "automatic" || !config.operational) return null;
  const profile = await tx.businessProfile.findFirst({
    where: { id: businessProfileId, archivedAt: null },
    select: { id: true, userId: true },
  });
  if (!profile) return null;

  const open = await tx.externalProcessingConsent.findFirst({
    where: { businessProfileId, provider: config.provider, purpose: "RECEIPT_EXTRACTION", revokedAt: null },
    select: { id: true },
  });
  if (!open) {
    const revoked = await tx.externalProcessingConsent.findFirst({
      where: {
        businessProfileId,
        provider: { in: ["gemini", "veryfi"] },
        purpose: "RECEIPT_EXTRACTION",
        revokedAt: { not: null },
      },
      select: { id: true },
    });
    if (revoked) return null;
  }

  const created = await supersedeReceiptProviderConsent(tx, {
    businessProfileId,
    actorUserId: profile.userId,
    provider: config.provider,
    policyVersion: config.policyVersion,
    dataClasses: config.allowedDataClasses,
    region: config.providerRegion,
    retentionHours: config.providerRetentionHours,
    source: "OPERATOR_POLICY",
  });
  logger.info(
    { businessProfileId, consentId: created.id, supersededConsentId: open?.id ?? null, source: "operator-policy" },
    "receipt provider consent granted by policy",
  );
  return { id: created.id };
}

export async function getReceiptProviderConsentState(userId: number, businessProfileId: number) {
  await requireActiveOwnedProfile(userId, businessProfileId);
  const config = getReceiptProviderConfiguration();
  const provider = publicReceiptProviderDetails(config);
  const mode = config.consentMode;
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
    return {
      available: false as const,
      mode,
      provider: null,
      consent: null,
      activeConsents: activeConsents.map(activeConsentDTO),
      policyBlocked: false,
    };
  }
  // Same rule as grantReceiptProviderConsentByPolicy: an owner revoke with
  // nothing open afterwards keeps automatic mode from granting again.
  const policyBlocked =
    mode === "automatic" &&
    !activeConsents.some((consent) => consent.provider === provider.key) &&
    (await prisma.externalProcessingConsent.count({
      where: {
        businessProfileId,
        provider: { in: ["gemini", "veryfi"] },
        purpose: "RECEIPT_EXTRACTION",
        revokedAt: { not: null },
      },
    })) > 0;
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
    mode,
    provider,
    consent: consentDTO(current ? { id: current.id, grantedAt: current.grantedAt, revokedAt: null } : null),
    activeConsents: activeConsents.map(activeConsentDTO),
    policyBlocked,
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
        return supersedeReceiptProviderConsent(tx, {
          businessProfileId,
          actorUserId: userId,
          provider: provider.key,
          policyVersion: provider.policyVersion,
          dataClasses: provider.dataClasses,
          region: provider.region,
          retentionHours: provider.retentionHours,
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
  // Read back rather than assembled here, so a revoke answers with the same
  // fields (including policyBlocked) the next GET would.
  return getReceiptProviderConsentState(userId, businessProfileId);
}
