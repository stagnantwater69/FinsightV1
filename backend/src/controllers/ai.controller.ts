import type { Request, Response } from "express";
import { z } from "zod";
import * as aiService from "../services/ai.service";
import * as conversationService from "../services/conversation.service";
import * as insightsService from "../services/insights.service";
import type { ReductionOpportunity } from "../services/reductionOpportunity.service";

/*
 * Selected reduction opportunity (plan §11.1) — the client echoes back the
 * SAME structured object `GET /insights/reduction-opportunities` returned
 * earlier for this profile, so the Ask FinSight drawer can ground an
 * explanation in it. This is validated shape, not trusted free-form prose:
 * every field is typed and bounded here, and aiContext.service further
 * re-validates `suggestedChecks` against the real controlled catalogue
 * before it reaches a prompt (see reductionOpportunityLines).
 *
 * Trust boundary: same one `context` below already documents. It only
 * steers the wording of this owner's own conversation about their own
 * business — it is never re-derived from the database, never used to
 * calculate anything, and grants no access requireOwnedBusinessProfile
 * didn't already grant. It attaches only to the "Expense Insights" module;
 * ai.service/conversation.service enforce that server-side too, not just
 * via `.refine` here.
 */
const reductionOpportunityEvidenceSchema = z.object({
  currentAmount: z.number().finite(),
  previousAmount: z.number().finite().nullable(),
  changeAmount: z.number().finite().nullable(),
  changePercent: z.number().finite().nullable(),
  expenseSharePercent: z.number().finite(),
  recordCount: z.number().int().nonnegative(),
  unusualRecordCount: z.number().int().nonnegative(),
  possibleDuplicateCount: z.number().int().nonnegative(),
});

const reductionOpportunitySchema: z.ZodType<ReductionOpportunity> = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["CATEGORY_PRESSURE", "FREQUENT_PURCHASE_ACCUMULATION", "RECORD_REVIEW_FIRST"]),
  categoryId: z.number().int().positive(),
  categoryName: z.string().min(1).max(120),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.enum(["strong", "moderate", "limited"]),
  observation: z.string().min(1).max(400),
  rationale: z.string().min(1).max(400),
  evidence: reductionOpportunityEvidenceSchema,
  // [ADDED] Plan §5.2/§15 Phase 5 — see ReductionOpportunity.costBehavior.
  costBehavior: z.enum(["fixed", "variable", "mixed", "unclassified"]),
  suggestedChecks: z.array(z.string().min(1).max(200)).max(10),
  relatedRecordIds: z.array(z.number().int().positive()).max(20),
  limitations: z.array(z.string().min(1).max(300)).max(10),
});

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
  // The selected Reduction Opportunity card, when this ask originated there.
  // Ignored server-side unless module is "Expense Insights" — see the note
  // above reductionOpportunitySchema.
  reductionOpportunity: reductionOpportunitySchema.optional(),
});

export async function ask(req: Request, res: Response) {
  const input = askSchema.parse(req.body);
  const result = await aiService.askAndRecord(
    req.user!.id,
    input.businessProfileId,
    input.module,
    input.question,
    input.context,
    input.reductionOpportunity
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

/*
 * Exported for the contract tests like `askSchema` above: Spending Impact's
 * description box carries the same 255-character limit as the record
 * descriptions this mirrors, and the client's `maxLength` is checked against
 * this rule rather than a copy of it.
 */
export const purchaseReviewSchema = z.object({
  businessProfileId: z.number().int().positive(),
  description: z.string().min(3).max(255),
  /*
   * Optional, and deliberately so: an owner may know what they want before
   * they know what it costs, and the review of the ITEM is useful either way.
   * When it is given it only colours the answer's language — every figure the
   * page shows about their funds is computed structurally elsewhere.
   */
  plannedAmount: z.number().positive().max(999_999_999).optional(),
  /*
   * The category the owner has picked or accepted on the page, used ONLY to
   * choose which of their own records the amount is compared against. It is
   * still not part of the impact calculation — see the note on Spending
   * Impact's category field.
   */
  categoryId: z.number().int().positive().optional(),
});

/**
 * Two halves of one answer, deliberately kept apart.
 *
 * `review` is written by a model: what the item is, what it is for, what it
 * drags along in running costs, and what to check about the price of a thing
 * like this.
 *
 * `priceContext` is arithmetic over the owner's OWN expense records: what they
 * paid the last time they bought something described this way, and what a
 * purchase in this category usually costs them. No model sees these figures
 * and no model produces them — which is what lets the page label the two
 * halves honestly, and what lets the price half survive the AI being down.
 *
 * Run together rather than in sequence: they share nothing, and the button
 * that calls this is one an owner is waiting on.
 */
export async function purchaseReview(req: Request, res: Response) {
  const input = purchaseReviewSchema.parse(req.body);
  const [review, priceContext] = await Promise.all([
    aiService.reviewPurchaseForProfile(
      req.user!.id,
      input.businessProfileId,
      input.description,
      input.plannedAmount ?? null
    ),
    insightsService.buildPurchasePriceContext(
      req.user!.id,
      input.businessProfileId,
      input.description,
      input.plannedAmount ?? null,
      input.categoryId ?? null
    ),
  ]);
  res.status(200).json({ review, priceContext });
}

/*
 * AI Chat — named conversations.
 *
 * Exported for the contract tests alongside `askSchema`: the chat composer's
 * `maxLength` is checked against THIS rule, and the question limit is
 * deliberately the same 500 as `/ai/ask` so the two entry points cannot
 * disagree about what a sendable question is.
 */
export const createConversationSchema = z.object({
  businessProfileId: z.number().int().positive(),
  originModule: z.enum(aiService.INTERACTION_MODULES),
  question: z.string().min(1).max(500),
  // Optional: derived server-side from `question` when omitted, so the stored
  // title can never be empty regardless of client. 120 matches the column.
  title: z.string().min(1).max(conversationService.TITLE_MAX_LENGTH).optional(),
  // Same meaning and same trust argument as `askSchema.context`.
  context: z.string().max(3000).optional(),
  // Same meaning as `askSchema.reductionOpportunity`.
  reductionOpportunity: reductionOpportunitySchema.optional(),
});

export const appendMessageSchema = z.object({
  question: z.string().min(1).max(500),
  context: z.string().max(3000).optional(),
  reductionOpportunity: reductionOpportunitySchema.optional(),
});

export const renameConversationSchema = z.object({
  title: z.string().trim().min(1).max(conversationService.TITLE_MAX_LENGTH),
});

const conversationListQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const conversationIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export async function listConversations(req: Request, res: Response) {
  const query = conversationListQuerySchema.parse(req.query);
  const result = await conversationService.listConversations(
    req.user!.id,
    query.businessProfileId,
    query.limit
  );
  res.status(200).json(result);
}

export async function getConversation(req: Request, res: Response) {
  const { id } = conversationIdSchema.parse(req.params);
  const result = await conversationService.getConversation(req.user!.id, id);
  res.status(200).json(result);
}

export async function createConversation(req: Request, res: Response) {
  const input = createConversationSchema.parse(req.body);
  const result = await conversationService.createConversationWithFirstMessage(
    req.user!.id,
    input.businessProfileId,
    input.originModule,
    input.question,
    input.title,
    input.context,
    input.reductionOpportunity
  );
  res.status(201).json(result);
}

export async function sendConversationMessage(req: Request, res: Response) {
  const { id } = conversationIdSchema.parse(req.params);
  const input = appendMessageSchema.parse(req.body);
  const result = await conversationService.appendMessage(
    req.user!.id,
    id,
    input.question,
    input.context,
    input.reductionOpportunity
  );
  res.status(201).json(result);
}

export async function renameConversation(req: Request, res: Response) {
  const { id } = conversationIdSchema.parse(req.params);
  const input = renameConversationSchema.parse(req.body);
  const result = await conversationService.renameConversation(req.user!.id, id, input.title);
  res.status(200).json(result);
}

export async function deleteConversation(req: Request, res: Response) {
  const { id } = conversationIdSchema.parse(req.params);
  await conversationService.deleteConversation(req.user!.id, id);
  res.status(204).send();
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
