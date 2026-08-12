// Bounded extraction of a planned-expense amount from a plain-language
// message. This exists ONLY for the Spending Impact drawer (Module 6, B5)
// — it is deliberately not general-purpose NLP, and nothing else in the
// app should call it.
//
// The point is that the AI never invents the impact numbers. We pull an
// amount out of the sentence here, run it through the real
// simulateSpendingImpact function, and hand the AI the computed result to
// describe. If we can't confidently find an amount, the caller asks a
// clarifying question instead of guessing.

export interface ExtractedScenario {
  amount: number | null;
  /** Best-effort item label, e.g. "fridge". Null when nothing readable. */
  label: string | null;
  /** True when the message reads like a hypothetical purchase. */
  looksLikeScenario: boolean;
}

// Words that mark a message as "I'm considering spending money", which is
// what makes a missing amount worth asking about rather than ignoring.
const SCENARIO_CUES = [
  "what if",
  "whatif",
  "if i spend",
  "if i buy",
  "if i pay",
  "if i get",
  "spend",
  "spending",
  "buy",
  "buying",
  "purchase",
  "purchasing",
  "afford",
  "invest",
  "plan to",
  "planning",
  "thinking of getting",
  "cost me",
];

// Number words we accept as multipliers. "11k" and "11 thousand" are both
// common in how owners actually write amounts.
const MULTIPLIERS: { pattern: string; factor: number }[] = [
  { pattern: "k", factor: 1_000 },
  { pattern: "thousand", factor: 1_000 },
  { pattern: "m", factor: 1_000_000 },
  { pattern: "million", factor: 1_000_000 },
];

const MULTIPLIER_GROUP = MULTIPLIERS.map((m) => m.pattern).join("|");
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;

// Tier 1: an explicit currency marker. Highest confidence — "₱11,000",
// "PHP 11000", "P11k".
const CURRENCY_PREFIXED = new RegExp(String.raw`(?:₱|php\b\.?|p(?=\s?\d))\s*${NUMBER}\s*(${MULTIPLIER_GROUP})?\b`, "i");
// Tier 2: a bare number carrying a magnitude word — "11k on a fridge".
const WITH_MULTIPLIER = new RegExp(String.raw`\b${NUMBER}\s*(${MULTIPLIER_GROUP})\b`, "i");
// Tier 3: a bare number. Lowest confidence, so percentages and things
// that read as counts rather than money are screened out below.
const BARE_NUMBER = new RegExp(String.raw`\b${NUMBER}\b`, "i");

function applyMultiplier(base: number, multiplier: string | undefined): number {
  if (!multiplier) return base;
  const found = MULTIPLIERS.find((m) => m.pattern === multiplier.toLowerCase());
  return found ? base * found.factor : base;
}

function parseMatch(match: RegExpMatchArray): number | null {
  if (!match[1]) return null;
  const whole = match[1].replace(/,/g, "");
  const cents = match[2];
  const multiplier = match[3];
  const base = Number(cents ? `${whole}.${cents}` : whole);
  if (!Number.isFinite(base) || base <= 0) return null;
  const amount = applyMultiplier(base, multiplier);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// Strip fragments that contain digits which are definitely not a planned
// amount, so the bare-number tier can't grab them:
//   - percentages ("25%") — that's the threshold, not a purchase
//   - 4-digit years ("in 2026")
//   - ordinal dates ("on the 15th")
function maskNonAmounts(text: string): string {
  return text
    .replace(/\d+(?:\.\d+)?\s*%/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, " ");
}

function extractAmount(message: string): number | null {
  const masked = maskNonAmounts(message);
  for (const pattern of [CURRENCY_PREFIXED, WITH_MULTIPLIER, BARE_NUMBER]) {
    const match = masked.match(pattern);
    if (match) {
      const amount = parseMatch(match);
      if (amount !== null) return amount;
    }
  }
  return null;
}

// Pull the thing being bought out of "…on a fridge" / "…for new shelves".
// Cosmetic only — it just lets the answer name the item back. A miss here
// never affects a number.
const LABEL_PATTERN = /\b(?:on|for)\s+(?:a|an|the|some|new)?\s*([a-z][a-z0-9\s\-']{1,40}?)(?=[.,?!]|$)/i;

function extractLabel(message: string): string | null {
  const match = message.match(LABEL_PATTERN);
  if (!match?.[1]) return null;
  const label = match[1].trim().replace(/\s+/g, " ");
  return label.length >= 2 ? label : null;
}

export function extractScenario(message: string): ExtractedScenario {
  const lower = message.toLowerCase();
  return {
    amount: extractAmount(message),
    label: extractLabel(message),
    looksLikeScenario: SCENARIO_CUES.some((cue) => lower.includes(cue)),
  };
}
