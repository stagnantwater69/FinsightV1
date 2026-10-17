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
 *   1. Financial figures must agree with their cited source and named subject.
 *      Question-only figures require conditional or owner-attributed wording.
 *      After one revision, unsupported claims are removed.
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

const ACCOUNTING_MONEY_PATTERN = /\([ \t]*(?:[-−][ \t]*)?(?:PHP|₱)[ \t]*(?:[-−][ \t]*)?(\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?[ \t]*\)/gi;
const MONEY_PATTERN = /(?:(?<![\d.,])([-−])[ \t]*)?(?:PHP|₱)[ \t]*([-−])?[ \t]*(\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?/gi;
const WORD_MONEY_PATTERN = /(?<![\w.,])([-−]?[ \t]*\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?[ \t]*(?:pesos?|pisos?|php)\b/gi;
const PREFIX_WORD_MONEY_PATTERN = /\b(?:pesos?|pisos?)\s+([-−]?[ \t]*\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?/gi;
const ACCOUNTING_WORD_MONEY_PATTERN = /\([ \t]*(?:[-−][ \t]*)?(\d[\d,]*(?:\.\d+)?)([ \t]?[kK]\b)?[ \t]*(?:pesos?|pisos?|php)\b[ \t]*\)/gi;
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
  for (const match of text.matchAll(ACCOUNTING_WORD_MONEY_PATTERN)) {
    const start = match.index!;
    moneyFigures.push({ start, figure: {
      raw: match[0], value: -toNumber(match[1]!) * (match[2] ? 1000 : 1), kind: "money",
    } });
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
  for (const pattern of [WORD_MONEY_PATTERN, PREFIX_WORD_MONEY_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      if (covered.some(([a, b]) => start < b && start + match[0].length > a)) continue;
      moneyFigures.push({ start, figure: {
        raw: match[0], value: toNumber(match[1]!.replace(/\s/g, "")) * (match[2] ? 1000 : 1), kind: "money",
      } });
      covered.push([start, start + match[0].length]);
    }
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
    const source = raw.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ").replace(/\[(?:ref|page|fact):[^\]]*\]/g, " ");
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

interface FinancialFact {
  tag: string;
  figures: KnownFigure[];
  subjects: string[];
}

const SUBJECT_STOP_WORDS = new Set((
  "the a an your you our their this that these those record records equivalent period total amount " +
  "was were are is be been have has had cost costs spent spend spending paid purchase " +
  "today todays reference against about " +
  "from for and with before after on per as of in to at php peso pesos piso pisos"
).split(" "));

function subjectWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}]{3,}/gu) ?? [])
    .filter((word) => !SUBJECT_STOP_WORDS.has(word)))];
}

/** Fact tags bind each financial line before the context budget is applied. */
export function tagFinancialFacts(lines: readonly string[]): string[] {
  let index = 0;
  return lines.map((line) => {
    const clean = line.replace(/\[fact:[^\]]*\]/g, "").trimEnd();
    return statedFigures(clean).length > 0 ? `${clean} [fact:f${++index}]` : clean;
  });
}

function financialFacts(context: string): FinancialFact[] {
  return context.split("\n").flatMap((line, index) => {
    const figures = knownNumbers(line);
    if (figures.length === 0) return [];
    const first = statedFigures(line)[0]!;
    const prefix = line.slice(0, line.indexOf(first.raw));
    return [{ tag: line.match(/\[fact:f\d+\]/)?.[0] ?? `[fact:f${index}]`, figures, subjects: subjectWords(prefix) }];
  });
}

function claimParts(text: string): string[] {
  return text.split("\n").flatMap((line) => /^\s*(?:[-*•]|\d+\.)\s/.test(line)
    ? [line]
    : line.split(/(?<=[.!?])\s+/));
}

function hypothesisClaim(text: string, figurePosition: number, figureLength: number): boolean {
  // A condition in an introductory clause does not qualify a later recorded claim.
  const masked = text.replace(/\[(?:ref|fact|page):[^\]]*\]/g, (tag) => " ".repeat(tag.length));
  const prefix = masked.slice(0, figurePosition + figureLength)
    .split(/(?<!\d),|,(?!\d)|[;:]|[—–]|\b(?:and|but|pero|at)\b/i).at(-1)!;
  const beforeFigure = prefix.slice(0, -figureLength);
  const conditional = beforeFigure.match(/\b(?:if|assum(?:e|ing)|suppose|kung|sakali|halimbawa)\s+(.*)$/i);
  if (conditional) {
    const predicate = conditional[1]!.trim().replace(/^that\s+/i, "");
    const monetaryTail = /^(?:(?:about|around|roughly|approximately|only|a|total|of|ng|nang)\s*)*$/i;
    const governed = predicate.match(/\b(?:is|are|was|were|costs?|would(?:\s+be)?|could(?:\s+be)?|might(?:\s+be)?|spend|spent|pay|paid|buy|bought|have|had|need|want|ay|gagastos|magbabayad|bibili|kailangan|gusto)\b/i);
    if (governed) {
      const subject = predicate.slice(0, governed.index).trim();
      const tail = predicate.slice(governed.index! + governed[0].length).trim();
      // The first predicate must govern this amount, rather than introduce a recap or explanation.
      if (monetaryTail.test(tail) && subject.length > 0) return true;
      if (/^(?:gagastos|magbabayad|bibili)$/i.test(governed[0])
        && /^(?:(?:ako|ka|tayo|kami|sila|siya|ko|mo|ng|nang)\s*)*$/i.test(tail)) return true;
    } else if (predicate.length === 0) return true;
  }
  if (/\bhypothetical(?:\s+(?:amount|expense|cost|purchase|funds|budget|of))*\s*$/i.test(beforeFigure)) return true;
  if (/\b(?:you mentioned|you said|sinabi mo)\b/i.test(prefix)) return true;
  if (/\b(?:was|were|spent|paid|recorded|actual|nagbayad|binayaran|ginastos|naitala)\b/i.test(prefix)) return false;
  const suffixClause = text.slice(figurePosition + figureLength).split(/\b(?:and|but|at|pero)\b|[;,]/i)[0]!;
  return /\b(?:would|could|planned|planning|balak)\b/i.test(prefix + suffixClause);
}

function unsupportedClaims(
  text: string,
  context: string,
  question: string,
  references: ReadonlyMap<string, RecordReference>,
): string[] {
  const contextKnown = knownNumbers(context);
  const questionKnown = knownNumbers(question);
  const facts = financialFacts(context);
  const allSubjects = new Set(facts.flatMap((fact) => fact.subjects));
  return claimParts(text).filter((claim) => {
    const figures = statedFigures(claim);
    if (figures.length === 0) return false;
    const citedTags: string[] = claim.match(/\[fact:f\d+\]/g) ?? [];
    const citedFacts = facts.filter((fact) => citedTags.includes(fact.tag));
    if (citedTags.some((tag) => !facts.some((fact) => fact.tag === tag))) return true;
    const namedRecords = [...references].filter(([tag, record]) => claim.includes(tag)
      || (record.label.length >= 3 && claim.toLowerCase().includes(record.label.toLowerCase())));
    let cursor = 0;
    return figures.some((figure) => {
      const previousEnd = cursor;
      const position = claim.indexOf(figure.raw, cursor);
      cursor = position + figure.raw.length;
      if (isKnownFigure(figure, questionKnown) && hypothesisClaim(claim, position, figure.raw.length)) return false;
      if (!isKnownFigure(figure, contextKnown)) {
        return true;
      }
      if (citedTags.length > 0 && !citedFacts.some((fact) => isKnownFigure(figure, fact.figures))) return true;
      const nearby = claim.slice(Math.max(0, position - 35), position).toLowerCase();
      const comparison = /\b(?:usual|average|mean|normally|share|target|gap|basis|karaniwan|average)\b/.test(nearby);
      if (figure.kind === "money" && namedRecords.length > 0 && !comparison) {
        const nearest = namedRecords.map(([tag, record]) => ({
          record,
          distance: Math.min(...[claim.indexOf(tag), claim.toLowerCase().indexOf(record.label.toLowerCase())]
            .filter((offset) => offset >= 0).map((offset) => Math.abs(offset - position))),
        })).sort((left, right) => left.distance - right.distance
          || right.record.label.length - left.record.label.length)[0]!;
        if (!isKnownFigure(figure, [{ kind: "money", value: nearest.record.amount }])) return true;
      }
      const candidates = facts.filter((fact) => isKnownFigure(figure, fact.figures));
      const localSubjects = subjectWords(claim.slice(previousEnd, position))
        .filter((word) => allSubjects.has(word));
      const claimSubjects = localSubjects.length > 0 ? localSubjects
        : subjectWords(claim).filter((word) => allSubjects.has(word));
      const distinguishingSubjects = claimSubjects.filter((subject) =>
        facts.some((fact) => !fact.subjects.includes(subject)),
      );
      const requiredSubjects = distinguishingSubjects.length > 0 ? distinguishingSubjects : claimSubjects;
      // Named subjects must agree with the source line; a value alone is insufficient.
      return requiredSubjects.length > 0 && !candidates.some((fact) =>
        requiredSubjects.every((subject) => fact.subjects.includes(subject)));
    });
  });
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
    .map((q) => q.replace(/\[(?:ref|page|fact):[^\]]*\]/g, "").trim())
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
    .replace(/(?:\s+(?:on|at|in|via|from|to|using)(?:\s+the)?\s*)?\[(?:ref|page|fact):[^\]]*\]/gi, "")
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

  let draft = splitFollowUps(first.answer);
  let provider = first.provider;
  let amountCheck: AmountCheck = "passed";

  const invalidClaims = unsupportedClaims(draft.body, askInput.context, askInput.question, references);
  if (invalidClaims.length > 0) {
    const second = await ask({
      ...askInput,
      revisionNote:
        `Your previous draft contains unsupported financial claims: ${invalidClaims.join(" ")}. ` +
        "Copy the figure with its own source subject and fact or record tag from CONTEXT. " +
        "A number in the question is an owner-supplied assumption, never a recorded fact. " +
        "Label hypothetical figures conditionally. Do not add, subtract or estimate.",
    });
    if (second.provider !== "unavailable") {
      draft = splitFollowUps(second.answer);
      provider = second.provider;
      amountCheck = "revised";
    }
    const stillInvalid = new Set(unsupportedClaims(draft.body, askInput.context, askInput.question, references));
    if (stillInvalid.size > 0) {
      draft = { body: claimParts(draft.body).filter((claim) => !stillInvalid.has(claim)).join("\n").trim(), followUps: draft.followUps };
      amountCheck = "trimmed";
    }
  }

  const resolved = resolveTags(draft.body, references);
  const text = ownersRecords(resolved.text.trim()) || AMOUNT_FALLBACK_ANSWER;
  const followUps = draft.followUps.filter((q) => unsupportedClaims(q, askInput.context, askInput.question, references).length === 0);

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
