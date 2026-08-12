import type { Request, Response } from "express";
import { z } from "zod";
import * as businessProfileService from "../services/businessProfile.service";
import { ApiError } from "../middleware/error.middleware";

/*
 * EXPORTED for the contract tests, the same reason auth.controller.ts exports
 * its schemas: the clients' `maxLength` attributes are checked against the REAL
 * rule here rather than against a copy of it, so a widened column cannot leave
 * a form quietly truncating what the API would have accepted.
 */
export const createSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.string().min(1).max(100),
  availableFunds: z.number().nonnegative(),
  expectedMonthlyExpenses: z.number().nonnegative(),
  operatingDays: z.number().int().min(1).max(31),
  largeExpenseThresholdPercent: z.number().positive().max(999.99).optional(),
});

const updateSchema = createSchema.partial();

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid business profile id");
  }
  return id;
}

export async function create(req: Request, res: Response) {
  const input = createSchema.parse(req.body);
  const profile = await businessProfileService.createBusinessProfile(req.user!.id, input);
  res.status(201).json(profile);
}

// Archived profiles are hidden by default so the switcher stays clean; the
// flag is how the "archived businesses" view gets at them.
const listQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export async function list(req: Request, res: Response) {
  const query = listQuerySchema.parse(req.query);
  const profiles = await businessProfileService.listBusinessProfiles(req.user!.id, query.includeArchived);
  res.status(200).json(profiles);
}

export async function getOne(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const profile = await businessProfileService.getBusinessProfile(req.user!.id, id);
  res.status(200).json(profile);
}

export async function update(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const input = updateSchema.parse(req.body);
  const profile = await businessProfileService.updateBusinessProfile(req.user!.id, id, input);
  res.status(200).json(profile);
}

export async function archive(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const profile = await businessProfileService.archiveBusinessProfile(req.user!.id, id);
  res.status(200).json(profile);
}

export async function restore(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const profile = await businessProfileService.restoreBusinessProfile(req.user!.id, id);
  res.status(200).json(profile);
}

export async function uploadLogo(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  if (!req.file) {
    throw new ApiError(400, "Photo file is required");
  }
  const profile = await businessProfileService.updateBusinessLogo(
    req.user!.id,
    id,
    req.file.buffer,
    req.file.mimetype,
    req.file.originalname,
  );
  res.status(200).json(profile);
}
