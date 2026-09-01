import type { Request, Response } from "express";
import { z } from "zod";
import * as recoveryPlanService from "../services/recoveryPlan.service";
import { ApiError } from "../middleware/error.middleware";

// EXPORTED for the contract tests — same rationale as
// businessOperatingSchedule.controller.ts / expenseCategory.controller.ts.
export const putRecoveryPlanSchema = z
  .object({
    bufferPercent: z.number().min(0).max(100).nullable().optional(),
    deadline: z.string().date().nullable().optional(),
    ownerTargetAmount: z.number().positive().nullable().optional(),
  })
  .strict();

const listRecoveryPlansQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be in YYYY-MM format")
    .optional(),
});

const MONTH_PARAM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseBusinessProfileId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid business profile id");
  }
  return id;
}

function parseMonthParam(raw: string): string {
  if (!MONTH_PARAM_RE.test(raw)) {
    throw new ApiError(400, "month must be in YYYY-MM format");
  }
  return raw;
}

export async function listPlans(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const { month } = listRecoveryPlansQuerySchema.parse(req.query);
  const plans = await recoveryPlanService.listRecoveryPlans(req.user!.id, businessProfileId, month);
  res.status(200).json(plans);
}

export async function putPlan(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const month = parseMonthParam(req.params.month!);
  const input = putRecoveryPlanSchema.parse(req.body);
  const plan = await recoveryPlanService.upsertRecoveryPlan(req.user!.id, businessProfileId, month, input);
  res.status(200).json(plan);
}

export async function deletePlan(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const month = parseMonthParam(req.params.month!);
  await recoveryPlanService.deleteRecoveryPlan(req.user!.id, businessProfileId, month);
  res.status(204).send();
}
