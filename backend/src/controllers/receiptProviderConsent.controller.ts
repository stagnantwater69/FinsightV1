import type { Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/error.middleware";
import {
  getReceiptProviderConsentState,
  grantReceiptProviderConsent,
  revokeReceiptProviderConsent,
} from "../services/receiptProviderConsent.service";

const grantSchema = z
  .object({
    provider: z.enum(["gemini", "veryfi"]),
    policyVersion: z.string().min(1).max(64),
    purpose: z.literal("RECEIPT_EXTRACTION"),
    dataClasses: z.array(z.enum(["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"])).length(2),
    region: z.string().min(1).max(64),
    retentionHours: z.number().int().min(0).max(24),
    trainingAllowed: z.literal(false),
  })
  .strict();

function businessProfileId(req: Request): number {
  const id = Number(req.params.businessProfileId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, "Invalid business profile id");
  return id;
}

export async function show(req: Request, res: Response) {
  res.json(await getReceiptProviderConsentState(req.user!.id, businessProfileId(req)));
}

export async function grant(req: Request, res: Response) {
  const state = await grantReceiptProviderConsent(req.user!.id, businessProfileId(req), grantSchema.parse(req.body));
  res.json(state);
}

export async function revoke(req: Request, res: Response) {
  res.json(await revokeReceiptProviderConsent(req.user!.id, businessProfileId(req)));
}
