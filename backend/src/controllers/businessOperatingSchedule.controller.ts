import type { Request, Response } from "express";
import { z } from "zod";
import * as scheduleService from "../services/businessOperatingSchedule.service";
import { ApiError } from "../middleware/error.middleware";

/*
 * EXPORTED for the contract tests, the same reason auth.controller.ts exports
 * its schemas (see expenseCategory.controller.ts for the identical rationale).
 */
const scheduleEntrySchema = z.object({
  weekday: z.number().int().min(1).max(7),
  isOpen: z.boolean(),
});

// Cross-field checks (exactly seven, unique, 1-7) are enforced again in the
// service layer, but rejecting an obviously-wrong shape here (wrong length)
// keeps the 400 message specific instead of falling through to a generic
// "seven weekdays" error for e.g. an empty array.
export const putScheduleSchema = z.object({
  entries: z.array(scheduleEntrySchema).length(7, "Schedule must contain exactly seven entries"),
});

export const createOverrideSchema = z.object({
  date: z.string().date(),
  type: z.enum(["OPEN", "CLOSED"]),
  reason: z.string().max(120).optional(),
});

const listOverridesQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

function parseBusinessProfileId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid business profile id");
  }
  return id;
}

function parseOverrideId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid override id");
  }
  return id;
}

export async function getSchedule(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const schedule = await scheduleService.getWeeklySchedule(req.user!.id, businessProfileId);
  res.status(200).json(schedule);
}

export async function putSchedule(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const { entries } = putScheduleSchema.parse(req.body);
  const schedule = await scheduleService.replaceWeeklySchedule(req.user!.id, businessProfileId, entries);
  res.status(200).json(schedule);
}

export async function listOverrides(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const query = listOverridesQuerySchema.parse(req.query);
  const overrides = await scheduleService.listOverrides(req.user!.id, businessProfileId, query);
  res.status(200).json(overrides);
}

export async function createOverride(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const input = createOverrideSchema.parse(req.body);
  const override = await scheduleService.createOverride(req.user!.id, businessProfileId, input);
  res.status(201).json(override);
}

export async function deleteOverride(req: Request, res: Response) {
  const businessProfileId = parseBusinessProfileId(req.params.id!);
  const overrideId = parseOverrideId(req.params.overrideId!);
  await scheduleService.deleteOverride(req.user!.id, businessProfileId, overrideId);
  res.status(204).send();
}
