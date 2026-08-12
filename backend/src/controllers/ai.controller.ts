import type { Request, Response } from "express";
import { z } from "zod";
import * as aiService from "../services/ai.service";

/*
 * EXPORTED for the contract tests, the same reason auth.controller.ts exports
 * its schemas: the clients' `maxLength` attributes are checked against the REAL
 * rule here rather than against a copy of it, so a widened column cannot leave
 * a form quietly truncating what the API would have accepted.
 */
export const askSchema = z.object({
  businessProfileId: z.number().int().positive(),
  module: z.enum(aiService.INTERACTION_MODULES),
  question: z.string().min(1).max(500),
  // Omitted by the Ask FinSight drawer on purpose — with no override the
  // server builds the context from data queried at this moment, which is
  // what keeps a follow-up answer current.
  // The Insights screens' "Explain this" action sends the exact numbers
  // currently on screen here — trusted verbatim since it only steers the
  // AI's answer content, it grants no data access the caller (the
  // authenticated owner, on their own business profile) didn't already
  // have via requireOwnedBusinessProfile.
  context: z.string().max(3000).optional(),
});

export async function ask(req: Request, res: Response) {
  const input = askSchema.parse(req.body);
  const result = await aiService.askAndRecord(
    req.user!.id,
    input.businessProfileId,
    input.module,
    input.question,
    input.context
  );
  res.status(201).json(result);
}

const suggestCategorySchema = z.object({
  businessProfileId: z.number().int().positive(),
  description: z.string().min(1).max(255),
});

export async function suggestCategory(req: Request, res: Response) {
  const input = suggestCategorySchema.parse(req.body);
  const suggestion = await aiService.suggestCategoryForDescription(
    req.user!.id,
    input.businessProfileId,
    input.description
  );
  res.status(200).json({ suggestion });
}

const historyQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  module: z.enum(aiService.INTERACTION_MODULES).optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export async function history(req: Request, res: Response) {
  const query = historyQuerySchema.parse(req.query);
  const result = await aiService.getHistory(req.user!.id, query.businessProfileId, query.module, query.limit);
  res.status(200).json(result);
}
