import { Prisma, type AnomalyFindingSeverity, type AnomalyFindingStatus, type AnomalyFindingType } from "@prisma/client";
import { ApiError } from "../../middleware/error.middleware";
import { prisma } from "../../config/prisma";
import type { DetectionFinding, FindingReview } from "./types";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Upsert makes detector retries idempotent. A stable fingerprint represents
 * one detector's opinion about one record or analysis window.
 */
export async function saveFinding(finding: DetectionFinding) {
  const data = {
    businessProfileId: finding.businessProfileId,
    expenseRecordId: finding.expenseRecordId,
    type: finding.type,
    method: finding.method,
    severity: finding.severity,
    score: finding.score === undefined ? null : new Prisma.Decimal(finding.score),
    title: finding.title,
    reasons: json(finding.reasons),
    metadata: finding.metadata === undefined ? Prisma.JsonNull : json(finding.metadata),
    detectorVersion: finding.detectorVersion,
    detectedAt: new Date(),
    // Explicit on update too: a re-scored SHADOW finding must stay SHADOW,
    // not silently keep whatever status a previous version wrote.
    ...(finding.status ? { status: finding.status } : {}),
  };

  return prisma.anomalyFinding.upsert({
    where: {
      businessProfileId_fingerprint: {
        businessProfileId: finding.businessProfileId,
        fingerprint: finding.fingerprint,
      },
    },
    create: { ...data, fingerprint: finding.fingerprint },
    update: data,
  });
}

export async function listFindings(
  userId: number,
  businessProfileId: number,
  filters: { type?: AnomalyFindingType; status?: AnomalyFindingStatus; severity?: AnomalyFindingSeverity; take?: number; cursorId?: number } = {},
) {
  const owned = await prisma.businessProfile.findFirst({ where: { id: businessProfileId, userId }, select: { id: true } });
  if (!owned) throw new ApiError(404, "Business profile not found");

  return prisma.anomalyFinding.findMany({
    where: {
      businessProfileId,
      type: filters.type,
      // SHADOW findings are evaluation data, not owner-facing content. They
      // are unreachable through this API even by asking for them explicitly —
      // shadow-mode exposure is a release decision, not a query parameter.
      status: filters.status && filters.status !== "SHADOW" ? filters.status : { not: "SHADOW" },
      severity: filters.severity,
    },
    orderBy: { id: "desc" },
    take: Math.max(1, Math.min(filters.take ?? 50, 100)),
    ...(filters.cursorId ? { cursor: { id: filters.cursorId }, skip: 1 } : {}),
  });
}

export async function findingSummary(userId: number, businessProfileId: number) {
  const owned = await prisma.businessProfile.findFirst({ where: { id: businessProfileId, userId }, select: { id: true } });
  if (!owned) throw new ApiError(404, "Business profile not found");
  const [byType, bySeverity, open] = await Promise.all([
    prisma.anomalyFinding.groupBy({ by: ["type"], where: { businessProfileId, status: "OPEN" }, _count: { _all: true } }),
    prisma.anomalyFinding.groupBy({ by: ["severity"], where: { businessProfileId, status: "OPEN" }, _count: { _all: true } }),
    prisma.anomalyFinding.count({ where: { businessProfileId, status: "OPEN" } }),
  ]);
  return {
    open,
    byType: Object.fromEntries(byType.map((entry) => [entry.type, entry._count._all])),
    bySeverity: Object.fromEntries(bySeverity.map((entry) => [entry.severity, entry._count._all])),
  };
}

export async function reviewFinding(userId: number, findingId: number, review: FindingReview) {
  const finding = await prisma.anomalyFinding.findFirst({
    where: { id: findingId, businessProfile: { userId } },
    select: { id: true },
  });
  if (!finding) throw new ApiError(404, "Finding not found");

  return prisma.anomalyFinding.update({
    where: { id: finding.id },
    data: { status: review.status, feedback: review.feedback, reviewedAt: new Date() },
  });
}
