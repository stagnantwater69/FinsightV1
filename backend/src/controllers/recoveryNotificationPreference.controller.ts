import type { Request, Response } from "express";
import { z } from "zod";
import * as preferenceService from "../services/recoveryNotificationPreference.service";
import { ApiError } from "../middleware/error.middleware";

// EXPORTED for the contract tests — same rationale as
// businessOperatingSchedule.controller.ts / expenseCategory.controller.ts.
const timeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be a 24-hour HH:MM time string");

export const putRecoveryNotificationPreferenceSchema = z
  .object({
    targetIncreaseAlertEnabled: z.boolean().optional(),
    // §7.5's "sane range" — a threshold of 0% or below (or above 100%) isn't
    // a meaningful "the target increased by X%" alert configuration.
    targetIncreaseThresholdPercent: z.number().min(1).max(100).optional(),
    behindThreeDaysAlertEnabled: z.boolean().optional(),
    openDayNoSalesAlertEnabled: z.boolean().optional(),
    projectionShortfallAlertEnabled: z.boolean().optional(),
    coverageReachedAlertEnabled: z.boolean().optional(),
    quietHoursStart: timeStringSchema.nullable().optional(),
    quietHoursEnd: timeStringSchema.nullable().optional(),
    // §7.5 — positive, capped at one week.
    minHoursBetweenNotifications: z.number().int().min(1).max(168).optional(),
  })
  .strict();

function parseBusinessProfileId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid business profile id");
  }
  return id;
}

export async function getPreference(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const preference = await preferenceService.getRecoveryNotificationPreference(req.user!.id, businessProfileId);
  res.status(200).json(preference);
}

export async function putPreference(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const input = putRecoveryNotificationPreferenceSchema.parse(req.body);
  const preference = await preferenceService.upsertRecoveryNotificationPreference(
    req.user!.id,
    businessProfileId,
    input,
  );
  res.status(200).json(preference);
}
