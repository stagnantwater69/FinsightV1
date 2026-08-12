import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { buildModuleContext, type InteractionModule } from "./aiContext.service";
import type { ExtractedScenario } from "../lib/scenario";
import type { AIInteraction } from "@prisma/client";
import { logger } from "../config/logger";

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
const HISTORY_TURNS_FOR_CONTEXT = 6;

// Cut at a sentence boundary when truncating, so a clipped answer reads as
// finished rather than as if the connection dropped mid-word.
function truncateAnswer(answer: string): string {
  if (answer.length <= MAX_ANSWER_LENGTH) return answer;
  const clipped = answer.slice(0, MAX_ANSWER_LENGTH);
  const lastBreak = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("\n"));
  return lastBreak > MAX_ANSWER_LENGTH * 0.6 ? clipped.slice(0, lastBreak + 1) : clipped;
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
  contextOverride?: string
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
  let context: string;
  let priorTurns: ConversationTurn[] = [];
  let scenario: ExtractedScenario | undefined;

  if (contextOverride) {
    context = contextOverride;
  } else {
    const [built, recent] = await Promise.all([
      buildModuleContext(userId, profile, module, question),
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
