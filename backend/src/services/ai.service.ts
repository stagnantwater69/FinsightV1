import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { buildModuleContext, type InteractionModule } from "./aiContext.service";
import type { ExtractedScenario } from "../lib/scenario";
import type { AIInteraction } from "@prisma/client";
import { logger } from "../config/logger";
import type { ReductionOpportunity } from "./reductionOpportunity.service";

// Keep the model names as named constants — Google and OpenRouter rename
// or deprecate models often. If a call starts failing with a 404/"model
// not found", check https://ai.google.dev/gemini-api/docs/models (Gemini)
// or https://openrouter.ai/models (OpenRouter) before assuming the
// integration itself broke.
// gemini-2.5-flash-lite is no longer available to new users as of this
// build (confirmed live against the API, not from docs) — 3.5 is the
// current flash-lite tier.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
// Exported so visionOcr.service reads a receipt through the same model this
// file already talks to, rather than keeping a second copy of the name that
// drifts the next time Google deprecates one.
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Deliberately a different vendor (Anthropic, via OpenRouter) than the
// primary Gemini path, so a Google-side outage doesn't take down the
// fallback too. Reasoning-family models (e.g. openai/gpt-5-mini) were
// tried first and rejected: they silently spend the token budget on
// hidden reasoning tokens and can return empty content under a modest
// max_tokens — confirmed live, not a hypothetical. claude-haiku-4.5 has
// no such hidden-token behavior by default.
const OPENROUTER_MODEL = "anthropic/claude-haiku-4.5";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// The grounding rule stays first and unconditional. An open-ended chat
// gives the model far more room to drift into invented figures than the
// old single-shot "Explain this" did, so this is the one instruction that
// must not be diluted by anything below it.
const SYSTEM_PROMPT = `You are FinSight, an AI assistant built into a financial monitoring app for small business owners with no accounting background.

RULE 1, ABOVE ALL ELSE: Only use numbers that appear in the CONTEXT block. Never invent, estimate, extrapolate, or guess a number that isn't given to you. If you catch yourself about to produce a figure that isn't in CONTEXT, say you don't have that information instead. This holds no matter how conversational the exchange becomes.

Other rules:
- If CONTEXT doesn't contain enough information to answer, say so plainly instead of guessing. "Your records don't show that yet" is a good answer.
- Answer in plain, everyday language — avoid accounting jargon (say "money left after expenses", not "net margin").
- Keep answers short: 2-4 sentences, or up to 4 short bullets when the question genuinely calls for a list.
- When asked how to reduce expenses, ground every suggestion in the owner's actual categories, amounts, and trends from CONTEXT. Name the real category and its real number. Never give generic advice like "cut unnecessary spending" or "negotiate with suppliers" without tying it to a specific figure you were given.
- FinSight's calculations are structured, not invented by you. When CONTEXT contains a pre-computed result, describe those exact figures rather than doing your own arithmetic.
- You monitor and explain; you do not tell the owner what to decide. Don't advise for or against a purchase.
- Earlier turns in this conversation are for continuity only. The CONTEXT block in the newest message is the only current, authoritative data — if an older answer conflicts with it, the new CONTEXT wins.`;

export interface ConversationTurn {
  question: string;
  answer: string;
}

export interface AskInput {
  context: string;
  question: string;
  /** Earlier turns in this drawer conversation, oldest first. */
  priorTurns?: ConversationTurn[];
}

export interface AskResult {
  answer: string;
  provider: "gemini" | "openrouter" | "unavailable";
}

function buildUserContent(input: AskInput): string {
  return `CONTEXT:\n${input.context}\n\nQUESTION:\n${input.question}`;
}

// Prior turns carry the questions and answers only — deliberately NOT the
// CONTEXT blocks they were originally answered against. Those numbers are
// stale by now; replaying them invites the model to answer a follow-up
// from month-old figures. Only the newest message carries data.
async function callGemini(input: AskInput): Promise<string> {
  const contents = [
    ...(input.priorTurns ?? []).flatMap((turn) => [
      { role: "user", parts: [{ text: turn.question }] },
      { role: "model", parts: [{ text: turn.answer }] },
    ]),
    { role: "user", parts: [{ text: buildUserContent(input) }] },
  ];

  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Native REST endpoint + x-goog-api-key header — required for the
      // newer "AQ." key format, which OpenAI-compatible wrappers/shims
      // that expect the old "AIza..." format are known to reject.
      "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no text content");
  }
  return text.trim();
}

async function callOpenRouter(input: AskInput): Promise<string> {
  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(input.priorTurns ?? []).flatMap((turn) => [
          { role: "user", content: turn.question },
          { role: "assistant", content: turn.answer },
        ]),
        { role: "user", content: buildUserContent(input) },
      ],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter responded ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenRouter returned no text content");
  }
  return text.trim();
}

// DEVIATION, flagged: the data dictionary's Interaction_Module described
// three values (the three Insights screens). Module 6 puts an Ask FinSight
// drawer on the Dashboard too, which needs a fourth value to scope and
// thread those conversations separately. The column is VARCHAR(50) and not
// a DB enum, so no migration was needed — but the dictionary should be
// updated to match.
export { INTERACTION_MODULES, type InteractionModule } from "./aiContext.service";

// Interaction_AIResponse is VARCHAR(1000) NOT NULL — defensive truncation
// in case a model response runs long, since we can't reject our own
// output the way we'd reject oversized user input.
const MAX_ANSWER_LENGTH = 1000;

// How many earlier turns of this module's conversation get replayed. Enough
// for "why is that one so high?" to resolve, small enough to keep the token
// cost and the risk of the model anchoring on stale phrasing down.
// Exported so conversation.service threads exactly as many of ITS OWN turns
// as the module drawer threads of the module log — one number, not two that
// drift.
export const HISTORY_TURNS_FOR_CONTEXT = 6;

// Cut at a sentence boundary when truncating, so a clipped answer reads as
// finished rather than as if the connection dropped mid-word.
// Exported for the same reason: a stored chat message is subject to the same
// "we cannot reject our own output" problem, so it gets the same guard rather
// than a second copy of it.
export function truncateAnswer(answer: string, maxLength: number = MAX_ANSWER_LENGTH): string {
  if (answer.length <= maxLength) return answer;
  const clipped = answer.slice(0, maxLength);
  const lastBreak = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("\n"));
  return lastBreak > maxLength * 0.6 ? clipped.slice(0, lastBreak + 1) : clipped;
}

function toInteractionDTO(interaction: AIInteraction) {
  return {
    id: interaction.id,
    module: interaction.module,
    question: interaction.question,
    answer: interaction.aiResponse,
    timestamp: interaction.timestamp,
  };
}

// Recent turns for one business profile + module, oldest first — this is
// both the drawer's message history and the source of the prior turns fed
// back to the model.
export async function getHistory(userId: number, businessProfileId: number, module?: InteractionModule, limit = 30) {
  const profile = await prisma.businessProfile.findFirst({ where: { id: businessProfileId, userId } });
  if (!profile) {
    throw new ApiError(404, "Business profile not found");
  }

  const interactions = await prisma.aIInteraction.findMany({
    where: { userId, businessProfileId, module },
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  return interactions.reverse().map(toInteractionDTO);
}

export async function askAndRecord(
  userId: number,
  businessProfileId: number,
  module: InteractionModule,
  question: string,
  contextOverride?: string,
  reductionOpportunity?: ReductionOpportunity
) {
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });
  if (!profile) {
    throw new ApiError(404, "Business profile not found");
  }

  // Two callers, one AI path.
  //
  // "Explain this" on an Insights screen passes contextOverride — the exact
  // numbers already rendered on screen — and is a deliberate one-shot: no
  // conversation thread, so no prior turns.
  //
  // The Ask FinSight drawer passes no context. The context is built here,
  // server-side, from data queried at this moment. That's what makes a
  // follow-up see an expense the owner recorded 20 seconds ago.
  //
  // reductionOpportunity is a third, narrower case: the owner opened the
  // drawer from a Reduction Opportunity card (plan §11). It is ignored
  // whenever contextOverride is also given (an override already carries the
  // final context text) and whenever module isn't "Expense Insights" — that
  // module scoping is enforced here, not just in the controller, so this
  // function can't be called into rendering the block somewhere it doesn't
  // belong.
  let context: string;
  let priorTurns: ConversationTurn[] = [];
  let scenario: ExtractedScenario | undefined;

  if (contextOverride) {
    context = contextOverride;
  } else {
    const [built, recent] = await Promise.all([
      buildModuleContext(
        userId,
        profile,
        module,
        question,
        module === "Expense Insights" ? reductionOpportunity : undefined
      ),
      getHistory(userId, businessProfileId, module, HISTORY_TURNS_FOR_CONTEXT),
    ]);
    context = built.context;
    scenario = built.scenario;
    priorTurns = recent.map((turn) => ({ question: turn.question, answer: turn.answer }));
  }

  const { answer, provider } = await askFinSight({ context, question, priorTurns });

  const interaction = await prisma.aIInteraction.create({
    data: {
      userId,
      businessProfileId,
      module,
      question,
      aiResponse: truncateAnswer(answer),
    },
  });

  return {
    ...toInteractionDTO(interaction),
    provider,
    // Surfaced so the drawer can show what amount was actually parsed out
    // of a plain-language scenario, rather than the owner having to trust
    // that the number in the prose was the one that got calculated.
    detectedAmount: scenario?.amount ?? null,
  };
}

export async function askFinSight(input: AskInput): Promise<AskResult> {
  try {
    const answer = await callGemini(input);
    return { answer, provider: "gemini" };
  } catch (geminiError) {
    logger.error({ err: geminiError }, "Gemini call failed, falling back to OpenRouter");
    try {
      const answer = await callOpenRouter(input);
      return { answer, provider: "openrouter" };
    } catch (openRouterError) {
      logger.error({ err: openRouterError }, "OpenRouter fallback also failed");
      return {
        answer: "FinSight can't reach its AI assistant right now. Please try again in a few minutes.",
        provider: "unavailable",
      };
    }
  }
}

// ============================================================
// Category suggestion — a classification, not a conversation
// ============================================================
// Deliberately NOT built on askFinSight/AskInput above: that path frames
// every message as CONTEXT+QUESTION for a free-form conversational answer,
// grounded by a system prompt about never inventing a NUMBER. This is a
// one-word classification against the business's OWN category list — the
// prompt, the temperature (0, for a repeatable answer) and the token budget
// are all different enough that bolting this onto the conversational path
// would mean threading exceptions through it rather than reusing anything
// real.

const CATEGORY_SUGGESTION_SYSTEM_PROMPT = `You classify a short planned-expense description into one of a small business's own expense categories.

Respond with ONLY the exact category name, copied character-for-character from the list you are given. No punctuation, no explanation, no extra words.
If none of the categories in the list are a reasonable fit, respond with exactly: NONE`;

function classifierUserContent(description: string, categoryNames: string[]): string {
  return `Categories: ${categoryNames.join(", ")}\n\nDescription: ${description}`;
}

async function classifyWithGemini(description: string, categoryNames: string[]): Promise<string> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CATEGORY_SUGGESTION_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: classifierUserContent(description, categoryNames) }] }],
      // temperature 0 and a tight token cap: this answer should be the same
      // category every time for the same input, and it is at most a few words.
      generationConfig: { temperature: 0, maxOutputTokens: 20 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no text content");
  }
  return text.trim();
}

async function classifyWithOpenRouter(description: string, categoryNames: string[]): Promise<string> {
  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: CATEGORY_SUGGESTION_SYSTEM_PROMPT },
        { role: "user", content: classifierUserContent(description, categoryNames) },
      ],
      temperature: 0,
      max_tokens: 20,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter responded ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenRouter returned no text content");
  }
  return text.trim();
}

export interface CategorySuggestion {
  categoryId: number;
  categoryName: string;
}

/**
 * Matches the model's answer back against the real category list,
 * case-insensitively but EXACTLY. A model that returns "inventory" or
 * "Inventory " still resolves to the real category; a near-miss like "Stock"
 * does not silently become "Inventory" — that would be the model inventing a
 * mapping rather than reading one off the list it was actually given, which
 * is the same "never invent what isn't there" rule the conversational prompt
 * states as RULE 1.
 */
function matchCategory(raw: string, categories: CategorySuggestion[]): CategorySuggestion | null {
  const cleaned = raw.trim().replace(/^["'.]+|["'.]+$/g, "");
  if (cleaned.toUpperCase() === "NONE") return null;
  return categories.find((c) => c.categoryName.toLowerCase() === cleaned.toLowerCase()) ?? null;
}

// ============================================================
// Receipt item categorisation — a batched classification
// ============================================================
// Extraction is NOT this layer's job. parseLineItems (ocr.service) reads the
// item name, quantity and price off the receipt deterministically, and its
// accuracy is measured in tests/ocr-accuracy/OCR-ACCURACY-REPORT.md. Handing
// extraction to a language model instead would mean numbers in the owner's
// books came from something that cannot be measured that way, and could
// invent a line that was never printed.
//
// What a model IS good at is the part regex cannot do at all: knowing that
// "buns", "patty" and "eggs" are ingredients while "rice cooker" is
// equipment. So it classifies, and only classifies.
//
// ONE call per receipt, not one per item — the whole list goes up together
// and comes back as an index-keyed array, the same batching discipline the
// rest of this service follows.

const ITEM_CATEGORY_SYSTEM_PROMPT = `You assign each item bought on a shop receipt to one of a small business's OWN expense categories.

You are given a numbered list of item names and the exact list of categories that business already uses.

Respond with ONLY a JSON array, no prose and no code fences. One element per item, in the same order:
{"index": <the item's number>, "match": "<a category name copied EXACTLY from the list, or UNCATEGORISED>", "suggestNew": "<optional>"}

RULES:
- "match" MUST be copied character-for-character from the categories you were given, or be exactly UNCATEGORISED. Never write a category that is not on that list.
- Prefer an existing category. Only if NO category on the list is a reasonable home for the item, set "match" to UNCATEGORISED.
- If an item has no reasonable existing home AND a clear new category would obviously fit it, you may additionally set "suggestNew" to a short proposed category name. This is only a suggestion for the owner to approve — still set "match" to UNCATEGORISED.
- If you are not confident, use UNCATEGORISED. Guessing wrongly is worse than admitting you don't know.
- You may also be told the VENDOR the receipt is from, and how this business has categorised items BEFORE. Treat both as evidence: the owner's own past choice is the best guide to where they want something filed, and the vendor tells you what kind of shop the item came from. Neither widens your options — "match" must still be copied from the categories list.
- Item names come from OCR and are often mangled ("Sprite Can 320m]"). Read through obvious misreads rather than giving up on a name you can still recognise.`;

/** The standing category an item falls into when nothing is confidently right. */
export const UNCATEGORISED = "Uncategorized";

export interface ItemCategorySuggestion {
  index: number;
  /** An existing category name, or null meaning "leave it uncategorised". */
  match: string | null;
  /** A proposed NEW category, for the owner to accept or ignore. Never auto-created. */
  suggestNew: string | null;
}

/**
 * Extra signal for the classifier, beyond the item names themselves.
 *
 * Both fields are hints only. Neither can widen what the model is allowed to
 * answer with, because validateItemCategories still checks every answer
 * against `categoryNames` no matter what went in.
 */
export interface ItemCategoryContext {
  /**
   * The store the receipt is from.
   *
   * A strong prior on its own, and a cheap one: OCR mangles item names far
   * more often than it mangles the shop's name at the top of the receipt, so
   * "this came from a hardware store" survives on receipts where the
   * individual lines barely do.
   */
  vendorName?: string | null;
  /**
   * How this business has categorised items before, MOST RECENT FIRST.
   *
   * This is what lets the classifier learn one business's habits. An owner
   * who files "Coke Mismo" under Resale rather than Ingredients corrects it
   * once on the confirm screen, and that choice becomes the example the next
   * receipt is classified against — instead of the same wrong guess arriving
   * again every week, which is what happened before this existed.
   */
  priorChoices?: { item: string; category: string }[];
}

/**
 * How many prior choices are replayed into the prompt.
 *
 * Capped because this is paid for by the token on every scan, forever. Twenty
 * carries a business's recurring purchases — the items that repeat week to
 * week are exactly the ones worth teaching — without the prompt growing
 * without bound as history accumulates.
 */
const MAX_PRIOR_CHOICES = 20;

function itemCategoryUserContent(
  itemNames: string[],
  categoryNames: string[],
  context: ItemCategoryContext = {},
): string {
  const sections = [`Categories: ${categoryNames.join(", ")}`];

  /*
   * Prior choices are filtered against the CURRENT category list first.
   *
   * A category the owner has since deleted or renamed would otherwise be
   * modelled as a valid answer: the model would copy it, and
   * validateItemCategories would then discard that answer as ungrounded,
   * leaving the item uncategorised. Teaching an answer that is guaranteed to
   * be thrown away is worse than teaching nothing.
   */
  const known = new Set(categoryNames.map((c) => c.toLowerCase()));
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const choice of context.priorChoices ?? []) {
    if (!known.has(choice.category.toLowerCase())) continue;
    // Deduplicated by item name, first occurrence winning. Callers pass
    // history most-recent-first, so this keeps the owner's LATEST decision
    // about a repeated purchase rather than the one it superseded.
    const key = choice.item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    examples.push(`"${choice.item.trim().slice(0, 120)}" -> ${choice.category}`);
    if (examples.length >= MAX_PRIOR_CHOICES) break;
  }
  if (examples.length > 0) {
    sections.push(`How this business has categorised items before:\n${examples.join("\n")}`);
  }

  if (context.vendorName?.trim()) {
    sections.push(`Vendor: ${context.vendorName.trim().slice(0, 150)}`);
  }

  sections.push(`Items:\n${itemNames.map((n, i) => `${i}. ${n.slice(0, 120)}`).join("\n")}`);
  return sections.join("\n\n");
}

/** Strips a ```json fence if the model adds one despite being told not to. */
function parseJsonArray(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

async function classifyItemsWithGemini(
  itemNames: string[],
  categoryNames: string[],
  context: ItemCategoryContext,
): Promise<string> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: ITEM_CATEGORY_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: itemCategoryUserContent(itemNames, categoryNames, context) }] }],
      // temperature 0: the same receipt must categorise the same way twice.
      generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text content");
  return text;
}

async function classifyItemsWithOpenRouter(
  itemNames: string[],
  categoryNames: string[],
  context: ItemCategoryContext,
): Promise<string> {
  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: ITEM_CATEGORY_SYSTEM_PROMPT },
        { role: "user", content: itemCategoryUserContent(itemNames, categoryNames, context) },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter responded ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned no text content");
  return text;
}

/**
 * Validates the model's answer back against the real category list.
 *
 * A "match" that is not on the list EXACTLY (case aside) is discarded and the
 * item left uncategorised. This is the same rule matchCategory follows for
 * the single-category classifier, and it is what stops the model quietly
 * inventing "Groceries" for a business that only has "Inventory" — an
 * invented category name would either fail to resolve to an id or, worse,
 * silently create a category the owner never asked for.
 */
function validateItemCategories(
  raw: string,
  itemCount: number,
  categoryNames: string[],
): ItemCategorySuggestion[] {
  let parsed: unknown;
  try {
    parsed = parseJsonArray(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const known = new Map(categoryNames.map((n) => [n.toLowerCase(), n]));
  const out: ItemCategorySuggestion[] = [];
  const seen = new Set<number>();

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { index, match, suggestNew } = entry as Record<string, unknown>;
    const i = typeof index === "number" ? index : Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= itemCount || seen.has(i)) continue;
    seen.add(i);

    const matched = typeof match === "string" ? known.get(match.trim().toLowerCase()) : undefined;
    const proposal =
      typeof suggestNew === "string" && suggestNew.trim() && !known.has(suggestNew.trim().toLowerCase())
        ? suggestNew.trim().slice(0, 100)
        : null;

    out.push({ index: i, match: matched ?? null, suggestNew: matched ? null : proposal });
  }
  return out;
}

/**
 * Categorises a receipt's items against the business's own category list.
 *
 * Returns an empty array — never throws — when both providers are
 * unreachable, the answer is unusable, or the business has no categories
 * yet. Every item then arrives uncategorised and the owner assigns them on
 * the review screen, exactly as if this had never been asked. The AI is an
 * accelerator on a manual flow, never a dependency of it.
 */
export async function categoriseReceiptItems(
  itemNames: string[],
  categoryNames: string[],
  context: ItemCategoryContext = {},
): Promise<ItemCategorySuggestion[]> {
  if (itemNames.length === 0 || categoryNames.length === 0) return [];

  let raw: string;
  try {
    raw = await classifyItemsWithGemini(itemNames, categoryNames, context);
  } catch (geminiError) {
    logger.error({ err: geminiError }, "Gemini item categorisation failed, falling back to OpenRouter");
    try {
      raw = await classifyItemsWithOpenRouter(itemNames, categoryNames, context);
    } catch (openRouterError) {
      logger.error({ err: openRouterError }, "OpenRouter item categorisation also failed");
      return [];
    }
  }
  return validateItemCategories(raw, itemNames.length, categoryNames);
}

/**
 * Suggests one of the business's own categories for a planned-expense
 * description — the "Category (AI-suggested, editable)" field on Spending
 * Impact. Returns null if nothing fits, the business has no categories yet,
 * or both providers are unreachable: a missing suggestion just means the
 * owner picks one themselves, same as if AI had never been asked.
 */
export async function suggestCategoryForDescription(
  userId: number,
  businessProfileId: number,
  description: string
): Promise<CategorySuggestion | null> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const categories = await prisma.expenseCategory.findMany({
    where: { businessProfileId },
    select: { id: true, name: true },
  });
  if (categories.length === 0) return null;

  const suggestions: CategorySuggestion[] = categories.map((c) => ({ categoryId: c.id, categoryName: c.name }));
  const names = suggestions.map((c) => c.categoryName);

  let raw: string;
  try {
    raw = await classifyWithGemini(description, names);
  } catch (geminiError) {
    logger.error({ err: geminiError }, "Gemini category classification failed, falling back to OpenRouter");
    try {
      raw = await classifyWithOpenRouter(description, names);
    } catch (openRouterError) {
      logger.error({ err: openRouterError }, "OpenRouter category classification also failed");
      return null;
    }
  }

  return matchCategory(raw, suggestions);
}

// ============================================================
// Purchase review — what the planned item IS, and what to ask about it
// ============================================================

/**
 * Spending Impact's description box used to be inert: the owner typed "display
 * fridge", and the only thing that happened was a category guess they could
 * not see the reasoning for. The figures answered "what happens to my money";
 * nothing answered "what am I actually buying".
 *
 * This does. It classifies the item the way a bookkeeper would — something the
 * business keeps and uses, or something that is consumed and has to be bought
 * again — names what a business of this type typically uses it for, lists the
 * running costs it drags along behind it, and hands back the questions the
 * owner is the only person able to answer.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: tell the owner whether to buy it. That is
 * not squeamishness, it is the product's standing rule (see SYSTEM_PROMPT's
 * "you do not tell the owner what to decide") and it is also the honest
 * position — the model does not know their pipeline, their landlord, or what
 * broke last week. Structured reflection is a real answer to "is this worth
 * it"; a verdict from a model that has seen one line of text is not.
 * `stripsVerdict` below enforces that on the way out rather than trusting the
 * prompt to hold, the same way the category classifier validates names back
 * against the owner's own list rather than trusting the model not to invent
 * one.
 *
 * NO BUSINESS FIGURES GO IN. The item, the amount and the business TYPE are
 * the whole input. The page already shows what the purchase does to the
 * owner's funds, computed structurally; sending balances here would only give
 * a language model the chance to restate them slightly wrong.
 */

/** How the item behaves in the books, in the owner's language rather than an accountant's. */
export type PurchaseKind = "asset" | "running-cost" | "mixed" | "unclear";

export interface PurchaseReview {
  kind: PurchaseKind;
  /** One plain sentence on why it falls that way. */
  kindReason: string;
  /** What a business of this type typically uses the item for. */
  businessUse: string;
  /** Costs that come WITH it — power, refills, maintenance, a subscription. */
  ongoingCosts: string | null;
  /**
   * What to CHECK about the price — never what the price should be.
   *
   * "Is ₱11,000 right for a display fridge?" is a question about one local
   * market on one day, and the model does not know that. What it does know is
   * what moves the price of a thing like this: whether delivery and
   * installation are included, new versus second-hand, the size or capacity
   * being quoted, whether a warranty comes with it. That is the useful,
   * honest half — and FinSight answers the other half from the owner's own
   * records (buildPurchasePriceContext in insights.service.ts) rather than
   * from a model's guess at retail prices.
   */
  priceCheck: string | null;
  /** Questions only the owner can answer. Two to four, each a real question. */
  questions: string[];
}

const PURCHASE_REVIEW_SYSTEM_PROMPT = `You are FinSight, helping a small business owner think about something they are considering buying. They have no accounting background.

Answer ONLY as JSON matching this shape, with no markdown fence:
{"kind":"asset"|"running-cost"|"mixed"|"unclear","kindReason":string,"businessUse":string,"ongoingCosts":string|null,"priceCheck":string|null,"questions":[string,...]}

What each field means:
- kind: "asset" if it is something the business keeps and uses for a long time (equipment, furniture, a machine). "running-cost" if it is used up and has to be bought again (stock, ingredients, supplies, fuel, a monthly service). "mixed" if it is genuinely both. "unclear" if the description is too vague to tell.
- kindReason: one short sentence, plain language, on why it falls that way. Do not use the words "asset" or "liability" as jargon — say what actually happens to the thing.
- businessUse: one or two short sentences on what a business of the stated type would typically use this for. If the item makes no obvious sense for that kind of business, say so plainly.
- ongoingCosts: the costs that come with owning or using it — electricity, refills, maintenance, staff time, a subscription. null if there genuinely are none.
- priceCheck: one or two short sentences on what to CHECK about the amount they gave, for an item like this. What is included or not (delivery, installation, warranty, taxes), what changes the price (size, capacity, brand, new versus second-hand), and what to ask a seller. NEVER state, estimate, or imply what the item should cost, and never say the amount is high, low, fair or reasonable — you do not know today's local prices. null if the amount was not given, or if you have nothing specific to check for this item.
- questions: 2 to 4 questions the OWNER must answer for themselves, each ending in a question mark. Make them specific to this item — "How many hours a day would it actually run?" not "Is it necessary?". Good questions ask about how often it would be used, what it replaces, what happens if it breaks, and whether a cheaper or second-hand version does the same job.

Hard rules:
- Never state a price, a price range, or "around" a figure. You have no price data and no way to check one. The only figure you may repeat is the amount they gave you.
- Never say whether the amount is high, low, fair, cheap, expensive, reasonable or a good deal. FinSight compares the amount against the owner's own past records; that is not your job.
- Never say whether to buy it. No "you should buy", "I recommend", "it is worth it", "skip this". You describe and you ask; the owner decides.
- Never invent numbers. You are given an amount and an item description and nothing else about this business — do not state or estimate their sales, funds, or what they can afford.
- Plain, everyday language. Short sentences. No accounting jargon.`;

function purchaseReviewUserContent(item: string, amount: number | null, businessType: string): string {
  return [
    `BUSINESS TYPE: ${businessType}`,
    `ITEM THEY ARE CONSIDERING: ${item}`,
    amount === null ? "AMOUNT: not given" : `AMOUNT: PHP ${amount.toLocaleString("en-PH")}`,
  ].join("\n");
}

async function reviewPurchaseWithGemini(item: string, amount: number | null, businessType: string): Promise<string> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PURCHASE_REVIEW_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: purchaseReviewUserContent(item, amount, businessType) }] }],
      // A little warmth: the questions should read as though a person thought
      // about this item, not as four rewordings of one template. Still low
      // enough that the classification does not wander between calls.
      generationConfig: { temperature: 0.4, maxOutputTokens: 700, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text content");
  return text;
}

async function reviewPurchaseWithOpenRouter(item: string, amount: number | null, businessType: string): Promise<string> {
  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: PURCHASE_REVIEW_SYSTEM_PROMPT },
        { role: "user", content: purchaseReviewUserContent(item, amount, businessType) },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter responded ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned no text content");
  return text;
}

/**
 * Verdict language, which the prompt forbids and this catches anyway.
 *
 * QUESTIONS ARE EXEMPT, and that exemption is the whole subtlety: "Is it worth
 * buying now, or after the busy season?" is exactly the kind of thing the
 * owner should be asking themselves, while "It is worth buying" is the one
 * thing FinSight must not say. The difference is the question mark, so that is
 * what the check keys on.
 */
const VERDICT_PATTERNS = [
  /\byou should (buy|not buy|get|avoid|skip)\b/i,
  /\bi (would |do )?(recommend|suggest|advise)\b/i,
  /\bdo ?n[o']?t buy\b/i,
  /\bit('s| is) (definitely |probably |certainly )?(worth|not worth) (it|buying|the money)\b/i,
  /\b(go ahead|hold off) (and|on) (buy|purchas)/i,
  /\bskip (this|the) purchase\b/i,
];

function readsAsVerdict(text: string): boolean {
  if (text.trim().endsWith("?")) return false;
  return VERDICT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Price talk the model is not entitled to.
 *
 * Two different overreaches, both caught here. Naming a figure ("expect around
 * ₱15,000") is inventing data — the model has no price feed, and a made-up
 * range beside the owner's real figures would be indistinguishable from the
 * calculated ones. Judging the amount ("that seems fair for a fridge") is the
 * same overreach wearing a softer word: FinSight answers "is this normal" by
 * comparing against what this owner has actually paid, and a model's opinion
 * would contradict that arithmetic in the same card.
 *
 * The one figure it may repeat is the amount the owner typed, so a currency
 * mention is only rejected when it is not that number.
 */
const PRICE_JUDGEMENT_PATTERNS = [
  /\b(fair|reasonable|steep|cheap|expensive|overpriced|underpriced|a good deal|a bargain|too (much|high|low))\b/i,
  /\b(should|would|could) (only )?cost\b/i,
  /\b(typically|usually|normally|generally) (costs?|sells? for|goes? for|priced)\b/i,
  /\b(around|about|roughly|approximately|between)\s*(php|₱|p)?\s*[\d,]{3,}/i,
  /\b(market|going|retail|street) (price|rate)\b/i,
];

function withoutPriceJudgement(text: string | null): string | null {
  if (!text) return null;
  return PRICE_JUDGEMENT_PATTERNS.some((pattern) => pattern.test(text)) ? null : text;
}

/** A model string, trimmed and capped — or null if it is empty or a verdict. */
function cleanSentence(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (readsAsVerdict(text)) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

const PURCHASE_KINDS: readonly PurchaseKind[] = ["asset", "running-cost", "mixed", "unclear"];

/**
 * Turns whatever came back into a review, or into nothing.
 *
 * Nothing is a perfectly good outcome: the card simply does not appear and the
 * page is what it was, which is the same contract every other AI accelerator
 * in this codebase honours. What must never happen is a half-built card — a
 * classification with no reason under it, or an empty question list under a
 * heading promising questions.
 */
export function parsePurchaseReview(raw: string): PurchaseReview | null {
  let parsed: unknown;
  try {
    parsed = parseJsonArray(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const { kind, kindReason, businessUse, ongoingCosts, priceCheck, questions } = parsed as Record<string, unknown>;

  const kindReasonText = cleanSentence(kindReason, 220);
  const businessUseText = cleanSentence(businessUse, 320);
  if (!kindReasonText || !businessUseText) return null;

  const questionList = (Array.isArray(questions) ? questions : [])
    .map((q) => cleanSentence(q, 160))
    .filter((q): q is string => q !== null && q.endsWith("?"))
    .slice(0, 4);
  if (questionList.length < 2) return null;

  return {
    kind: PURCHASE_KINDS.find((k) => k === kind) ?? "unclear",
    kindReason: kindReasonText,
    businessUse: businessUseText,
    ongoingCosts: cleanSentence(ongoingCosts, 220),
    // Dropped rather than shown when it slips into judging the amount — the
    // same treatment a buy/don't-buy verdict gets, for the same reason: it is
    // a claim FinSight has nothing behind.
    priceCheck: withoutPriceJudgement(cleanSentence(priceCheck, 260)),
    questions: questionList,
  };
}

/** The model half, without the database — which is what makes it testable. */
export async function reviewPlannedPurchase(
  item: string,
  amount: number | null,
  businessType: string,
): Promise<PurchaseReview | null> {
  let raw: string;
  try {
    raw = await reviewPurchaseWithGemini(item, amount, businessType);
  } catch (geminiError) {
    logger.error({ err: geminiError }, "Gemini purchase review failed, falling back to OpenRouter");
    try {
      raw = await reviewPurchaseWithOpenRouter(item, amount, businessType);
    } catch (openRouterError) {
      logger.error({ err: openRouterError }, "OpenRouter purchase review also failed");
      return null;
    }
  }
  return parsePurchaseReview(raw);
}

/**
 * The route's entry point: ownership first, then the business's own type as
 * the only context the model is trusted with.
 */
export async function reviewPurchaseForProfile(
  userId: number,
  businessProfileId: number,
  item: string,
  amount: number | null,
): Promise<PurchaseReview | null> {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const profile = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { type: true },
  });
  return reviewPlannedPurchase(item, amount, profile?.type ?? "small business");
}
