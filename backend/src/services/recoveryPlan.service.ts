import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import type { RecoveryPlan } from "@prisma/client";

// Write/CRUD surface only, per docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md
// §7.5/§10.7/§11 Phase 6.
//
// CRITICAL: this table is a purely separate, owner-visible artifact. It must
// NEVER be read by computeRecoveryTarget/getRecoveryInsight/
// simulateRecoveryScenario (analysis.service.ts / insights.service.ts) or
// any other live calculation — confirmed by inspection that neither file
// references RecoveryPlan/recoveryPlan at all. Do not add such a reference
// here or anywhere else "to make the numbers match"; that is explicitly
// forbidden by the plan (§10.7/§13.2).

const MAX_LISTED_PLANS = 24;

function monthKeyToDate(monthKey: string): Date {
  return new Date(`${monthKey}-01T00:00:00.000Z`);
}

function dateToMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export interface RecoveryPlanDTO {
  month: string;
  bufferPercent: number | null;
  deadline: string | null;
  ownerTargetAmount: number | null;
  createdAt: string;
  updatedAt: string;
}

function toDTO(plan: RecoveryPlan): RecoveryPlanDTO {
  return {
    month: dateToMonthKey(plan.month),
    bufferPercent: plan.bufferPercent !== null ? Number(plan.bufferPercent) : null,
    deadline: plan.deadline ? plan.deadline.toISOString().slice(0, 10) : null,
    ownerTargetAmount: plan.ownerTargetAmount !== null ? Number(plan.ownerTargetAmount) : null,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidMonthKey(monthKey: string) {
  if (!MONTH_KEY_RE.test(monthKey)) {
    throw new ApiError(400, "month must be in YYYY-MM format");
  }
}

export async function listRecoveryPlans(
  userId: number,
  businessProfileId: number,
  monthKey?: string,
): Promise<RecoveryPlanDTO[]> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  if (monthKey) {
    assertValidMonthKey(monthKey);
    const plan = await prisma.recoveryPlan.findUnique({
      where: { businessProfileId_month: { businessProfileId, month: monthKeyToDate(monthKey) } },
    });
    return plan ? [toDTO(plan)] : [];
  }

  const plans = await prisma.recoveryPlan.findMany({
    where: { businessProfileId },
    orderBy: { month: "desc" },
    take: MAX_LISTED_PLANS,
  });
  return plans.map(toDTO);
}

export interface UpsertRecoveryPlanInput {
  bufferPercent?: number | null;
  deadline?: string | null;
  ownerTargetAmount?: number | null;
}

export async function upsertRecoveryPlan(
  userId: number,
  businessProfileId: number,
  monthKey: string,
  input: UpsertRecoveryPlanInput,
): Promise<RecoveryPlanDTO> {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  assertValidMonthKey(monthKey);

  const month = monthKeyToDate(monthKey);
  const deadline = input.deadline !== undefined && input.deadline !== null
    ? new Date(`${input.deadline}T00:00:00.000Z`)
    : input.deadline === null
      ? null
      : undefined;

  const existing = await prisma.recoveryPlan.findUnique({
    where: { businessProfileId_month: { businessProfileId, month } },
  });

  const bufferPercent = "bufferPercent" in input ? input.bufferPercent ?? null : (existing?.bufferPercent ?? null);
  const ownerTargetAmount =
    "ownerTargetAmount" in input ? input.ownerTargetAmount ?? null : (existing?.ownerTargetAmount ?? null);
  const resolvedDeadline = "deadline" in input ? deadline ?? null : (existing?.deadline ?? null);

  const saved = await prisma.recoveryPlan.upsert({
    where: { businessProfileId_month: { businessProfileId, month } },
    create: {
      businessProfileId,
      month,
      bufferPercent,
      deadline: resolvedDeadline,
      ownerTargetAmount,
    },
    update: {
      bufferPercent,
      deadline: resolvedDeadline,
      ownerTargetAmount,
    },
  });

  return toDTO(saved);
}

export async function deleteRecoveryPlan(userId: number, businessProfileId: number, monthKey: string): Promise<void> {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  assertValidMonthKey(monthKey);

  const month = monthKeyToDate(monthKey);
  const existing = await prisma.recoveryPlan.findUnique({
    where: { businessProfileId_month: { businessProfileId, month } },
  });
  if (!existing) {
    throw new ApiError(404, "Recovery plan not found");
  }

  await prisma.recoveryPlan.delete({ where: { businessProfileId_month: { businessProfileId, month } } });
}
