import { prisma } from "../../config/prisma";
import { requireOwnedBusinessProfile } from "../../lib/ownership";

export async function anomalyEvaluation(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const [grouped, transactionCount, jobs, reviewed] = await Promise.all([
    prisma.anomalyFinding.groupBy({
      by: ["method", "status"], where: { businessProfileId }, _count: { _all: true },
    }),
    prisma.expenseRecord.count({ where: { businessProfileId } }),
    prisma.analysisJob.groupBy({ by: ["status"], where: { businessProfileId }, _count: { _all: true } }),
    prisma.anomalyFinding.findMany({
      where: { businessProfileId, reviewedAt: { not: null } },
      select: { detectedAt: true, reviewedAt: true }, take: 10_000,
    }),
  ]);
  const byMethod = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const values = byMethod.get(row.method) ?? {};
    values[row.status] = row._count._all;
    byMethod.set(row.method, values);
  }
  const detectors = [...byMethod].map(([method, counts]) => {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const reviewedCount = (counts.CONFIRMED ?? 0) + (counts.DISMISSED ?? 0) + (counts.RESOLVED ?? 0);
    return {
      method, total, open: counts.OPEN ?? 0, confirmed: counts.CONFIRMED ?? 0,
      dismissed: counts.DISMISSED ?? 0, resolved: counts.RESOLVED ?? 0,
      confirmationRate: reviewedCount > 0 ? (counts.CONFIRMED ?? 0) / reviewedCount : null,
      dismissalRate: reviewedCount > 0 ? (counts.DISMISSED ?? 0) / reviewedCount : null,
    };
  });
  const totalFindings = detectors.reduce((sum, detector) => sum + detector.total, 0);
  const reviewLatencies = reviewed.map((finding) => finding.reviewedAt!.getTime() - finding.detectedAt.getTime());

  /*
   * Shadow-mode overlap (A4). The promotion question for the ML detector is
   * "does it find anything the rules missed?" — which the per-method counts
   * above cannot answer. This joins the ML detector's active shadow findings
   * against every other detector's findings on the same records:
   *   overlapping = the forest agreed with a rule (redundant),
   *   mlOnly      = candidate incremental value, the number that has to be
   *                 non-trivial (and later, confirmed by owners) before any
   *                 promotion out of shadow mode.
   */
  const shadowRecords = await prisma.anomalyFinding.findMany({
    where: { businessProfileId, method: "isolation-forest", status: "SHADOW", expenseRecordId: { not: null } },
    select: { expenseRecordId: true },
  });
  const shadowIds = shadowRecords.map((finding) => finding.expenseRecordId!) ;
  const overlapping = shadowIds.length
    ? await prisma.anomalyFinding.count({
        where: {
          businessProfileId,
          expenseRecordId: { in: shadowIds },
          method: { not: "isolation-forest" },
          status: { not: "SUPERSEDED" },
        },
      })
    : 0;

  return {
    transactionCount,
    totalFindings,
    findingsPer100Transactions: transactionCount > 0 ? totalFindings / transactionCount * 100 : 0,
    averageReviewLatencyHours: reviewLatencies.length > 0
      ? reviewLatencies.reduce((sum, value) => sum + value, 0) / reviewLatencies.length / 3_600_000
      : null,
    detectors,
    shadow: {
      mlShadowFindings: shadowIds.length,
      overlappingWithRules: Math.min(overlapping, shadowIds.length),
      mlOnly: Math.max(shadowIds.length - overlapping, 0),
    },
    jobs: Object.fromEntries(jobs.map((job) => [job.status, job._count._all])),
  };
}
