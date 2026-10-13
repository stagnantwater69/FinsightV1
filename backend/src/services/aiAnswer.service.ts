import type { AskInput, AskResult } from "./ai.service";

/**
 * Everything that happens to a model's answer between the provider and the
 * owner's screen.
 *
 * The system prompt asks the model to stay grounded, cite records by tag and
 * end with follow-up questions. This file is where those requests are CHECKED
 * rather than trusted — the same stance the purchase review takes with
 * `stripsVerdict` and the category classifier takes by matching names back
 * against the owner's own list:
 *
 *   1. Every peso amount and percentage in the answer must appear in the
 *      CONTEXT the model was given (or the owner's own question). One retry
 *      with a correction note; after that, sentences carrying an unknown
 *      figure are removed rather than shown.
 *   2. Record tags resolve only to records that were in THIS message's
 *      context. The context is built from the owner's own business profile,
 *      so a tag can never open another owner's record — and a tag the model
 *      invented, or copied from an earlier turn, is simply dropped.
 *   3. Page tags resolve only against a fixed catalogue.
 *   4. Follow-up suggestions are parsed off the last line, bounded, and held
 *      to the same amount rule as the answer.
 */

// ============================================================
// Shapes returned to the clients
// ============================================================

/** A record the answer mentioned, as the server read it — never the model's wording. */
export interface RecordReference {
  kind: "record";
  recordType: "expense" | "sales";
  id: number;
  label: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
}

/**
 * Pages Fin may point to. The clients own the route each key opens — web and
 * mobile name their screens differently — so only the key crosses the wire.
 */
export const PAGE_CATALOGUE = {
  dashboard: "Dashboard",
  records: "Records",
  "review-queue": "Needs review",
  "expense-insights": "Expense Insights",
  recovery: "Recovery Target",
  "spending-impact": "Spending Impact",
  categories: "Categories",
  "add-expense": "Add an expense",
  "add-sales": "Add sales",
  "scan-receipt": "Scan a receipt",
} as const;
export type PageKey = keyof typeof PAGE_CATALOGUE;

export interface PageLink {
  key: PageKey;
  label: string;
}

/**
 * Something the owner can do from the chat with one tap.
 *
 * Built by the SERVER from facts it already holds (the flag the owner opened,
 * the amount it parsed), never chosen by the model. The client still runs the
 * existing endpoint only when the owner presses the button, so nothing happens
 * on the owner's behalf.
 */
export type ChatAction =
  | {
      kind: "review-finding";
      findingId: number;
      label: string;
      status: "CONFIRMED" | "DISMISSED" | "RESOLVED";
      feedback: "CONFIRMED_UNUSUAL" | "EXPECTED_TRANSACTION" | "DUPLICATE" | "INCORRECT_MATCH" | "NO_LONGER_RELEVANT";
    }
  | { kind: "open-spending-impact"; amount: number; label: string };

/** How the amount check went, so the clients can be honest about a trimmed answer. */
export type AmountCheck = "passed" | "revised" | "trimmed";

export interface AnswerMetadata {
  references: RecordReference[];
  pages: PageLink[];
  actions: ChatAction[];
  followUps: string[];
  /** The period the answer was grounded in, e.g. "January 2022". */
  period: string | null;
  amountCheck: AmountCheck;
}

// ============================================================
// Amount grounding
// ============================================================

/**
 * Peso amounts and percentages the answer states. Bare small integers ("9
 * records", "3 flags") and dates are deliberately NOT treated as amounts:
 * counts are not money, and policing every digit would reject answers that
 * are fine.
 */
export interface StatedFigure {
  raw: string;
  value: number;
  kind: "money" | "percent";
}

export type KnownFigure = Pick<StatedFigure, "value" | "kind">;

const ACCOUNTING_MONEY_PATTERN = /\([ \t]*(?:[-−][ \t]*)?(?:PHP|Php|php|₱)[ \t]*(?:[-−][ \t]*)?(\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?[ \t]*\)/g;
const MONEY_PATTERN = /(?:(?<![\d.,])([-−])[ \t]*)?(?:PHP|Php|php|₱)[ \t]*([-−])?[ \t]*(\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?/g;
// A number with thousands separators or two decimals reads as money even
// without a currency mark ("about 11,000", "347.33").
const ACCOUNTING_BARE_MONEY_PATTERN = /\([ \t]*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2})[ \t]*\)/g;
const BARE_MONEY_PATTERN = /(?<![\d.,])([-−]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}))(?![\d%])/g;
const ACCOUNTING_PERCENT_PATTERN = /\([ \t]*(?:[-−][ \t]*)?(\d+(?:\.\d+)?)[ \t]*%[ \t]*\)/g;
const PERCENT_PATTERN = /(?:(?<![\d.,])([-−])[ \t]*)?(\d+(?:\.\d+)?)[ \t]?%/g;

function toNumber(text: string): number {
  return Number(text.replace(/,/g, "").replace("−", "-"));
}

export function statedFigures(text: string): StatedFigure[] {
  const figures: StatedFigure[] = [];
  const moneyFigures: Array<{ start: number; figure: StatedFigure }> = [];
  const covered: Array<[number, number]> = [];

  for (const match of text.matchAll(ACCOUNTING_MONEY_PATTERN)) {
    const thousands = match[2] ? 1000 : 1;
    const start = match.index!;
    moneyFigures.push({ start, figure: { raw: match[0], value: -toNumber(match[1]!) * thousands, kind: "money" } });
    covered.push([start, start + match[0].length]);
  }
  for (const match of text.matchAll(MONEY_PATTERN)) {
    const start = match.index!;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    const thousands = match[4] ? 1000 : 1;
    const negative = Boolean(match[1] || match[2]);
    const magnitude = toNumber(match[3]!) * thousands;
    moneyFigures.push({ start, figure: { raw: match[0], value: negative ? -magnitude : magnitude, kind: "money" } });
    covered.push([start, start + match[0].length]);
  }
  for (const match of text.matchAll(ACCOUNTING_BARE_MONEY_PATTERN)) {
    const start = match.index!;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    moneyFigures.push({ start, figure: { raw: match[0], value: -toNumber(match[1]!), kind: "money" } });
    covered.push([start, start + match[0].length]);
  }
  for (const match of text.matchAll(BARE_MONEY_PATTERN)) {
    const start = match.index!;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    // A date like 2022-01-10 or a time is not money.
    if (/\d{4}-\d{2}$/.test(text.slice(Math.max(0, start - 8), start))) continue;
    moneyFigures.push({ start, figure: { raw: match[0], value: toNumber(match[1]!), kind: "money" } });
  }
  figures.push(...moneyFigures.sort((left, right) => left.start - right.start).map(({ figure }) => figure));
  const percentFigures: Array<{ start: number; figure: StatedFigure }> = [];
  const coveredPercents: Array<[number, number]> = [];
  for (const match of text.matchAll(ACCOUNTING_PERCENT_PATTERN)) {
    const start = match.index!;
    percentFigures.push({ start, figure: { raw: match[0], value: -Number(match[1]), kind: "percent" } });
    coveredPercents.push([start, start + match[0].length]);
  }
  for (const match of text.matchAll(PERCENT_PATTERN)) {
    const start = match.index!;
    if (coveredPercents.some(([a, b]) => start >= a && start < b)) continue;
    const magnitude = Number(match[2]);
    percentFigures.push({ start, figure: { raw: match[0], value: match[1] ? -magnitude : magnitude, kind: "percent" } });
  }
  figures.push(...percentFigures.sort((left, right) => left.start - right.start).map(({ figure }) => figure));
  return figures;
}

/**
 * Every number the model was entitled to use.
 *
 * Dates and record tags are stripped first: "2022-01-10" would otherwise make
 * 2,022 (and with rounding, "PHP 2,000") look like a figure the model was
 * given, and "[ref:e343]" would vouch for PHP 343.
 */
export function knownNumbers(...sources: string[]): KnownFigure[] {
  const values = new Map<string, KnownFigure>();
  for (const raw of sources) {
    const source = raw.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ").replace(/\[(?:ref|page):[^\]]*\]/g, " ");
    for (const figure of statedFigures(source)) {
      if (Number.isFinite(figure.value)) {
        const value = Object.is(figure.value, -0) ? 0 : figure.value;
        values.set(`${figure.kind}:${value}`, {
          kind: figure.kind,
          value,
        });
      }
    }
  }
  return [...values.values()];
}

/**
 * Whether a stated figure is one of the known ones, allowing the rounding a
 * person does when they speak: PHP 347 for 347.33, "about PHP 300" for 347,
 * "PHP 11k" for 11,000. It does NOT allow arithmetic — a difference or a sum
 * the model worked out itself is exactly what RULE 1 forbids.
 */
export function isKnownFigure(figure: StatedFigure, known: KnownFigure[]): boolean {
  const value = Object.is(figure.value, -0) ? 0 : figure.value;
  if (figure.kind === "percent") {
    return known.some((candidate) =>
      candidate.kind === "percent"
      && Math.sign(value) === Math.sign(candidate.value)
      && Math.abs(value - candidate.value) <= 0.5);
  }
  return known.some((candidate) => {
    if (candidate.kind !== "money") return false;
    if (Math.sign(value) !== Math.sign(candidate.value)) return false;
    const diff = Math.abs(value - candidate.value);
    if (diff < 0.5 + 1e-9) return true;
    const magnitude = Math.abs(value);
    if (magnitude >= 1000 && magnitude % 1000 === 0 && diff <= 500) return true;
    if (magnitude >= 100 && magnitude % 100 === 0 && diff <= 50) return true;
    if (magnitude >= 10 && magnitude % 10 === 0 && diff <= 5) return true;
    return false;
  });
}

export function unknownFigures(text: string, known: KnownFigure[]): string[] {
  return statedFigures(text)
    .filter((figure) => !isKnownFigure(figure, known))
    .map((figure) => figure.raw.trim());
}

/**
 * Removes the sentences (or bullet lines) that carry an unknown figure.
 * Keeps the rest of the answer, which is usually still the useful part.
 */
export function withoutUnknownFigures(text: string, known: KnownFigure[]): string {
  const lines = text.split("\n");
  const kept = lines
    .map((line) => {
      if (unknownFigures(line, known).length === 0) return line;
      // A bullet is one claim; drop it whole.
      if (/^\s*(?:[-*•]|\d+\.)\s/.test(line)) return null;
      // Split only where punctuation is followed by a space, so "PHP 202.67"
      // stays one sentence rather than becoming "PHP 202." and "67".
      const sentences = line.split(/(?<=[.!?])\s+/);
      const survivors = sentences.filter((sentence) => unknownFigures(sentence, known).length === 0);
      return survivors.length > 0 ? survivors.join(" ").trim() : null;
    })
    .filter((line): line is string => line !== null);
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ============================================================
// Tags and follow-ups
// ============================================================

const RECORD_TAG = /\[ref:([es])(\d{1,10})\]/g;
const PAGE_TAG = /\[page:([a-z-]{3,30})\]/g;
const FOLLOW_UPS_LINE = /^\s*\**\s*FOLLOW[- ]?UPS?\s*\**\s*:\s*(.*)$/im;

/** The context-side token for a record. Kept here so builder and resolver cannot disagree. */
export function recordTag(recordType: "expense" | "sales", id: number): string {
  return `[ref:${recordType === "expense" ? "e" : "s"}${id}]`;
}

export function splitFollowUps(text: string): { body: string; followUps: string[] } {
  const match = text.match(FOLLOW_UPS_LINE);
  if (!match) return { body: text.trim(), followUps: [] };
  const body = (text.slice(0, match.index) + text.slice(match.index! + match[0].length)).trim();
  const followUps = match[1]!
    .split("|")
    .map((q) => q.replace(/\[(?:ref|page):[^\]]*\]/g, "").trim())
    .filter((q) => q.length >= 6 && q.length <= 90 && q.endsWith("?"));
  return { body, followUps: [...new Set(followUps)].slice(0, 3) };
}

export function resolveTags(
  text: string,
  allowed: ReadonlyMap<string, RecordReference>,
): { text: string; references: RecordReference[]; pages: PageLink[] } {
  const references = new Map<string, RecordReference>();
  const pages = new Map<PageKey, PageLink>();

  for (const match of text.matchAll(RECORD_TAG)) {
    const reference = allowed.get(match[0]);
    if (reference) references.set(match[0], reference);
  }
  for (const match of text.matchAll(PAGE_TAG)) {
    const key = match[1] as PageKey;
    if (key in PAGE_CATALOGUE) pages.set(key, { key, label: PAGE_CATALOGUE[key] });
  }

  // Every tag comes out of the prose, valid or not: the buttons carry the
  // links, and a raw "[ref:e123]" in a sentence reads as a glitch. A tag the
  // model used as a sentence's object ("check it on [page:records].") would
  // leave "check it on." behind, so the preposition goes with it.
  const cleaned = text
    .replace(/\[(?:ref|page):[^\]]*\]/g, "\u0000")
    .replace(/\s+(?:on|at|in|via|from|to|using)(?:\s+the)?\s*\u0000/gi, "\u0000")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return { text: cleaned, references: [...references.values()].slice(0, 8), pages: [...pages.values()].slice(0, 2) };
}

/**
 * The records are the owner's, not Fin's. The prompt says so, and the smaller
 * models still slip into "my records don't show…" when data is missing — which
 * reads as if FinSight kept its own books. A deterministic rewrite of that one
 * phrase is cheaper and surer than another retry.
 */
export function ownersRecords(text: string): string {
  return text.replace(/\b([Mm])y ((?:current |own )?)(records|data)\b/g, (_match, m: string, adjective: string) =>
    `${m === "M" ? "Your" : "your"} ${adjective}records`,
  );
}

// ============================================================
// The whole pass
// ============================================================

export const AMOUNT_FALLBACK_ANSWER =
  "I couldn't answer that without guessing at a figure your records don't show. Try asking about one record, one category, or a specific month.";

export interface GroundedAnswer extends AskResult {
  metadata: AnswerMetadata;
}

export interface GroundAnswerInput extends AskInput {
  references: ReadonlyMap<string, RecordReference>;
  actions?: ChatAction[];
  period?: string | null;
}

/**
 * Asks, checks, and if needed asks once more.
 *
 * `ask` is injected rather than imported so the HTTP tests that replace
 * ai.service's `askFinSight` keep exercising this whole pass.
 */
export async function groundAnswer(
  ask: (input: AskInput) => Promise<AskResult>,
  input: GroundAnswerInput,
): Promise<GroundedAnswer> {
  const { references, actions = [], period = null, ...askInput } = input;
  const baseMetadata: AnswerMetadata = { references: [], pages: [], actions, followUps: [], period, amountCheck: "passed" };

  const first = await ask(askInput);
  // The outage placeholder is FinSight's own sentence, not a model answer.
  if (first.provider === "unavailable") return { ...first, metadata: { ...baseMetadata, actions: [] } };

  const known = knownNumbers(askInput.context, askInput.question);
  let draft = splitFollowUps(first.answer);
  let provider = first.provider;
  let amountCheck: AmountCheck = "passed";

  const unknown = unknownFigures(draft.body, known);
  if (unknown.length > 0) {
    const second = await ask({
      ...askInput,
      revisionNote:
        `Your previous draft used figures that are not in CONTEXT: ${[...new Set(unknown)].join(", ")}. ` +
        "Answer again using only figures that appear in CONTEXT, copied exactly. Do not add, subtract or estimate.",
    });
    if (second.provider !== "unavailable") {
      draft = splitFollowUps(second.answer);
      provider = second.provider;
      amountCheck = "revised";
    }
    if (unknownFigures(draft.body, known).length > 0) {
      draft = { body: withoutUnknownFigures(draft.body, known), followUps: draft.followUps };
      amountCheck = "trimmed";
    }
  }

  const resolved = resolveTags(draft.body, references);
  const text = ownersRecords(resolved.text.trim()) || AMOUNT_FALLBACK_ANSWER;
  const followUps = draft.followUps.filter((q) => unknownFigures(q, known).length === 0);

  return {
    answer: text,
    provider,
    metadata: {
      references: resolved.references,
      pages: resolved.pages,
      actions,
      followUps,
      period,
      amountCheck,
    },
  };
}
