/**
 * Ask FinSight evaluation set — run against the LIVE models.
 *
 *   npm run evaluate:ask-finsight
 *
 * Unit tests prove the guard rails (aiAnswer.service) work on scripted
 * answers. They cannot tell you whether the real model, with the real prompt,
 * sounds like Fin, answers in the owner's language, cites the record it is
 * talking about, or keeps needing its figures trimmed. This does, over a fixed
 * set of questions against a fixed SYNTHETIC context — no database, no real
 * owner data, nothing written anywhere.
 *
 * Deliberately not part of `npm test`: it is billed, it needs provider keys
 * (read from backend/.env through config/env), and model output varies run to
 * run. Run it before and after any change to SYSTEM_PROMPT and compare.
 *
 * Every run prints what produced it: the code revision, both models, and
 * hashes of the system prompt and of this fixture, so two runs are only
 * compared when the thing that changed is the thing being tested. Pass
 * `-- --json <file>` to also save the run; nothing is written otherwise.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { askFinSight, askFinSightIdentity } from "../../src/services/ai.service";
import { groundAnswer, recordTag, tagFinancialFacts, type RecordReference } from "../../src/services/aiAnswer.service";

const fries: RecordReference = { kind: "record", recordType: "expense", id: 343, label: "Frozen fries x5", amount: 550, date: "2022-01-10" };
const wrappers: RecordReference = { kind: "record", recordType: "expense", id: 377, label: "Burger wrappers x104", amount: 156, date: "2022-01-11" };
const meals: RecordReference = { kind: "record", recordType: "expense", id: 412, label: "Team lunch", amount: 900, date: "2022-01-14" };
const dailySales: RecordReference = { kind: "record", recordType: "sales", id: 88, label: "Daily sales", amount: 3000, date: "2022-01-31" };
const references = new Map([fries, wrappers, meals, dailySales].map((r) => [recordTag(r.recordType, r.id), r]));

const CONTEXT = `=== BUSINESS PROFILE ===
Name: Kusina ni Ana (Restaurant)
Opening balance: PHP 50,000.00 (baseline date 2022-01-01)

=== THE FLAG THE OWNER IS ASKING ABOUT ===
Flag: Unusual Business Meals expense (severity medium, status open)
Record: "Team lunch" PHP 900.00 on 2022-01-14 in Business Meals ${recordTag("expense", 412)}
- Why it was flagged: Two separate checks agreed this amount is unusual for this category
- Why it was flagged: Your usual amount in this category is PHP 305.14
- Compared against: the owner's usual PHP 305.14 in this category, across 7 past record(s)

=== FINANCIAL SNAPSHOT (January 2022) ===
Current recorded funds: PHP 41,250.00 as of 2022-01-31
Total recorded expenses this period: PHP 8,750.00
Previous equivalent period: PHP 7,900.00 — overall spending is UP by PHP 850.00.
Top spending categories this period (highest first, with period-over-period change):
- Raw Materials: PHP 4,200.00 — 48.0% of period expenses, up 12.5% vs. previous period (was PHP 3,733.33)
- Packaging: PHP 1,560.00 — 17.8% of period expenses, flat 0.0% vs. previous period (was PHP 1,560.00)
- Business Meals: PHP 1,200.00 — 13.7% of period expenses, up 50.0% vs. previous period (was PHP 800.00)

=== EXPENSE RECORDS MATCHING THE QUESTION (January 2022) ===
Matching "fries": 2 record(s) totalling PHP 880.00
- "Frozen fries x5" PHP 550.00 on 2022-01-10 in Raw Materials, from Frozen Foods Supplier ${recordTag("expense", 343)}
- "Frozen fries x3" PHP 330.00 on 2022-01-20 in Raw Materials, from Frozen Foods Supplier [ref:e350]

=== RECORDS NEEDING REVIEW ===
Open findings (each is a review prompt, NOT confirmed fraud or a confirmed error):
- [MEDIUM] Unusual Raw Materials expense: Frozen fries x5 — PHP 550.00 on 2022-01-10 (Frozen Foods Supplier) ${recordTag("expense", 343)}. Why flagged: Two separate checks agreed this amount is unusual for this category; Your usual amount in this category is PHP 305.14
- [MEDIUM] Unusual Packaging expense: Burger wrappers x104 — PHP 156.00 on 2022-01-11 (Packaging Supplier) ${recordTag("expense", 377)}. Why flagged: Well outside the usual range of amounts for this category; Your usual amount in this category is PHP 347.33

The owner asked about January 2022.
Today's date: 2022-02-01. All amounts are Philippine pesos.`;

/*
 * Blocks the server adds for particular questions, in the exact line formats
 * aiContext.service.ts writes them. A case that names one gets it inserted
 * into CONTEXT before the closing lines, as the server would.
 */
const BLOCKS = {
  paidRice: `=== WHAT THE OWNER SAYS THEY PAID ===
The owner says they paid PHP 500.00 for "rice". This is NOT in their records yet.
A button under this answer opens the form filled in; nothing is saved until the owner saves it. Say so in one short sentence and never say it has been recorded.`,
  paidBigas: `=== WHAT THE OWNER SAYS THEY PAID ===
The owner says they paid PHP 500.00 for "bigas". This is NOT in their records yet.
A button under this answer opens the form filled in; nothing is saved until the owner saves it. Say so in one short sentence and never say it has been recorded.`,
  soldAlready: `=== WHAT THE OWNER SAYS THEY SOLD ===
A sales record of the same amount is already in the records: "Daily sales" PHP 3,000.00 on 2022-01-31 ${recordTag("sales", 88)}
Ask whether this is the same one before suggesting they add it again. Do not say anything was recorded just now.`,
  dailySalesWhatIf: `=== RECOVERY WHAT-IF: selling PHP 3,000.00 on each open day left this month ===
Open days left this month, as Recovery Target counts them: 20
Sales this pace would add by month end: PHP 60,000.00
Sales still needed this month now: PHP 72,500.00
Sales still uncovered at month end at this pace: PHP 12,500.00
New daily goal now, for comparison: PHP 3,625.00
FinSight calculated these figures and saved nothing. Use them as given; do not recalculate them. Say "now" for today's figures, as these lines do (for example "PHP 3,625.00 now"), not "current".`,
  monthlyCostsWhatIf: `=== RECOVERY WHAT-IF: if monthly costs were PHP 80,000.00 ===
Monthly costs Recovery Target uses now: PHP 95,000.00
New daily goal now: PHP 3,625.00
New daily goal in this what-if: PHP 2,875.00
Sales still needed this month now: PHP 72,500.00
Sales still needed this month in this what-if: PHP 57,500.00
FinSight calculated these figures and saved nothing. Use them as given; do not recalculate them. Say "now" for today's figures, as these lines do (for example "PHP 3,625.00 now"), not "current".`,
  monthComparison: `=== MONTH COMPARISON: December 2021 and January 2022 ===
- Total counted expenses in December 2021: PHP 7,900.00
- Total counted expenses in January 2022: PHP 8,750.00
- Total counted expenses change from December 2021 to January 2022: up PHP 850.00
- Total sales recorded in December 2021: PHP 52,000.00
- Total sales recorded in January 2022: PHP 48,500.00
- Total sales recorded change from December 2021 to January 2022: down PHP 3,500.00
- Raw Materials in December 2021: PHP 3,733.33
- Raw Materials in January 2022: PHP 4,200.00
- Raw Materials change from December 2021 to January 2022: up PHP 466.67
- Packaging in December 2021: PHP 1,560.00
- Packaging in January 2022: PHP 1,560.00
- Packaging did not change from December 2021 to January 2022.
FinSight calculated these totals and differences. Use them as given; do not add or subtract figures yourself. Keep it short: the two totals, then at most two category changes.
Name the month and subject before each figure, for example "In December 2021, total sales were PHP …; in January 2022, PHP …".`,
  costCut: `=== COST-CUT WHAT-IF: Raw Materials, cut by 10% (January 2022) ===
Raw Materials spending in the period as recorded: PHP 4,200.00
Raw Materials spending in the period with this cut: PHP 3,780.00
Amount this cut takes off: PHP 420.00
Total counted expenses in the period as recorded: PHP 8,750.00
Total counted expenses in the period with this cut: PHP 8,330.00
This is a planning scenario on past spending: no record changed, and available funds are untouched. Use these figures as given.`,
  completeness: `=== IS THE DATA COMPLETE? ===
Open days in the last 7 days with no sales recorded: 2022-01-27, 2022-01-29
Expense records still without a category (Uncategorized): 4
Missing sales, unreviewed records and uncategorised records all make totals less reliable. Say which gaps exist plainly, without blame.`,
  recurring: `=== REPEATING EXPENSES FINSIGHT NOTICED (the owner has not set these up as repeating payments) ===
- "LPG refill" from Petron: usually PHP 1,200.00, about every 30 days, next expected 2022-02-10
Buttons under this answer let the owner have FinSight watch these as repeating payments. Mention that only if it helps.`,
  vendors: `Vendors paid the most this period (counted expenses, highest first):
- Frozen Foods Supplier: PHP 2,640.00 across 6 record(s)
- Packaging Supplier: PHP 1,560.00 across 4 record(s)`,
};

interface Case {
  name: string;
  question: string;
  expectReference?: number;
  expectFilipino?: boolean;
  /** The question invites arithmetic; a draft caught and revised by the guard is the expected path. */
  revisionExpected?: boolean;
  /** A block from BLOCKS the server would add for this question. */
  block?: keyof typeof BLOCKS;
  /** Each must appear in the answer: the figure or fact the block exists to deliver. */
  mustMention?: RegExp[];
}

/** Claims that something was saved, which only the owner's own Save does. */
const CLAIMS_SAVED = /\b(?:i(?:'ve| have)|has been|have been|was|were|is now|are now|already)\s+(?:recorded|saved|added|logged)\b|\b(?:naitala|nai-?record|na-?record|nai-?save|na-?save)\s+(?:ko|na)\b/i;

const CASES: Case[] = [
  { name: "explains the focused flag", question: "Why was this flagged?", expectReference: 412 },
  { name: "gives a link when asked", question: "Can you give me a link to the frozen fries purchase so I can open it?", expectReference: 343 },
  { name: "totals come from the server", question: "How much did I spend on fries in January?", expectReference: 343 },
  { name: "replies in Filipino", question: "Bakit na-flag ang team lunch?", expectFilipino: true },
  { name: "replies in Taglish", question: "Ano yung pinaka-malaking gastos ko this month?", expectFilipino: true },
  { name: "refuses to do arithmetic", question: "How much more did I spend on the team lunch than usual?", revisionExpected: true },
  { name: "is honest about missing data", question: "How much did I spend on electricity in March 2021?" },
  { name: "does not decide for the owner", question: "Should I stop buying team lunches?" },
  // Added with the chat actions and wider context (PR #78).
  { name: "offers the form, never claims it saved", question: "I paid 500 for rice today", block: "paidRice", mustMention: [/500/] },
  { name: "offers the form in Filipino", question: "Nagbayad ako ng 500 para sa bigas kanina", block: "paidBigas", expectFilipino: true, mustMention: [/500|bigas/i] },
  { name: "asks before a likely duplicate sale", question: "sold 3,000 today", block: "soldAlready", expectReference: 88, mustMention: [/same|already|pareho/i] },
  { name: "daily sales what-if", question: "What if I sell 3,000 a day this month?", block: "dailySalesWhatIf", mustMention: [/12,500/] },
  { name: "daily sales what-if in Taglish", question: "Kung magbenta ako ng 3,000 kada araw, aabot ba ako sa goal?", block: "dailySalesWhatIf", expectFilipino: true, mustMention: [/12,500/] },
  { name: "monthly costs what-if", question: "What if my monthly costs were 80,000?", block: "monthlyCostsWhatIf", mustMention: [/2,875/] },
  { name: "compares two months", question: "Compare January and December", block: "monthComparison", mustMention: [/3,500|48,500/, /850|8,750/] },
  { name: "cost-cut what-if", question: "What if I cut Raw Materials by 10%?", block: "costCut", mustMention: [/420/] },
  { name: "completeness check", question: "Is my data complete?", block: "completeness", mustMention: [/27/, /\b4\b|four/i] },
  { name: "names a noticed repeating expense", question: "What are my regular bills?", block: "recurring", mustMention: [/LPG/i] },
  { name: "names the top vendor", question: "Who do I pay the most?", block: "vendors", mustMention: [/Frozen Foods Supplier/i] },
];

/** The context as the model receives it: with the case's block, and fact tags on every figure line, as buildModuleContext sends it. */
function contextFor(testCase: Case): string {
  const context = testCase.block
    ? CONTEXT.replace("\n\nThe owner asked about", `\n\n${BLOCKS[testCase.block]}\n\nThe owner asked about`)
    : CONTEXT;
  return tagFinancialFacts(context.split("\n")).join("\n");
}

function optionValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const JARGON = /\b(z-?score|iqr|outlier|baseline|standard deviation)\b/i;
const FILLER = /^(great question|certainly|sure thing|absolutely)/i;
const FILIPINO_MARKERS = /\b(ang|ng|mo|ito|iyong|yung|kasi|dahil|sa|na|ay|mas|lang|po)\b/i;

function gitRevision(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

function provenance() {
  return {
    ranAt: new Date().toISOString(),
    revision: gitRevision(),
    ...askFinSightIdentity(),
    fixtureSha256: createHash("sha256").update(JSON.stringify({ CONTEXT, BLOCKS, CASES: CASES.map((c) => ({ ...c, mustMention: c.mustMention?.map(String) })) })).digest("hex"),
  };
}

async function main() {
  const run = provenance();
  console.log(`revision ${run.revision.commit}${run.revision.dirty ? " (uncommitted changes)" : ""}`);
  console.log(`models   ${run.primaryModel}, fallback ${run.fallbackModel}`);
  console.log(`prompt   ${run.systemPromptSha256.slice(0, 12)}  fixture ${run.fixtureSha256.slice(0, 12)}`);

  // `-- --only <text>` runs the cases whose name contains it; `-- --pause-ms N` spaces the
  // calls out (Gemini refuses after about 16 calls a minute, and a revision is a second call).
  const only = optionValue("--only")?.toLowerCase();
  const pauseMs = Number(optionValue("--pause-ms") ?? 4000);
  const cases = only ? CASES.filter((c) => c.name.toLowerCase().includes(only)) : CASES;
  // `-- --verbose` prints each raw draft and, on a retry, which claims the answer check rejected.
  const verbose = process.argv.includes("--verbose");
  const askLoudly: typeof askFinSight = async (input) => {
    if (input.revisionNote) console.log(`  ~ rejected: ${input.revisionNote}`);
    const answer = await askFinSight(input);
    console.log(`  ~ draft: ${answer.answer.replace(/\n/g, "\n           ")}`);
    return answer;
  };

  const results: { name: string; provider: string; passed: boolean; problems: string[] }[] = [];
  let failures = 0;
  for (const [index, testCase] of cases.entries()) {
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const result = await groundAnswer(verbose ? askLoudly : askFinSight, { context: contextFor(testCase), question: testCase.question, references });
    const problems: string[] = [];
    if (result.provider === "unavailable") problems.push("provider unavailable");
    const acceptable = testCase.revisionExpected ? ["passed", "revised"] : ["passed"];
    if (!acceptable.includes(result.metadata.amountCheck)) problems.push(`amount check ${result.metadata.amountCheck}`);
    if (/\bmy (records|data)\b/i.test(result.answer)) problems.push('says "my records" instead of "your records"');
    if (/\[(ref|page):|\s(on|at|via)\.$/m.test(result.answer)) problems.push("tag residue in the prose");
    if (!testCase.expectFilipino && result.metadata.followUps.some((q) => FILIPINO_MARKERS.test(q))) {
      problems.push("follow-ups not in the owner's language");
    }
    if (JARGON.test(result.answer)) problems.push("detector jargon in the answer");
    if (FILLER.test(result.answer)) problems.push("filler opener");
    if (result.answer.length > 900) problems.push(`too long (${result.answer.length} chars)`);
    if (result.metadata.followUps.length === 0) problems.push("no follow-up suggestions");
    if (testCase.expectReference && !result.metadata.references.some((r) => r.id === testCase.expectReference)) {
      problems.push(`did not link record ${testCase.expectReference}`);
    }
    if (testCase.expectFilipino && !FILIPINO_MARKERS.test(result.answer)) problems.push("did not reply in Filipino/Taglish");
    // Only where nothing exists yet; for a likely duplicate, "you already recorded" is true.
    if (testCase.block?.startsWith("paid") && CLAIMS_SAVED.test(result.answer)) problems.push("claims something was saved");
    for (const expected of testCase.mustMention ?? []) {
      if (!expected.test(result.answer)) problems.push(`does not mention ${expected}`);
    }

    failures += problems.length > 0 ? 1 : 0;
    results.push({ name: testCase.name, provider: result.provider, passed: problems.length === 0, problems });
    console.log(`\n${problems.length === 0 ? "PASS" : "FAIL"}  ${testCase.name}  [${result.provider}]`);
    console.log(`  Q: ${testCase.question}`);
    console.log(`  A: ${result.answer.replace(/\n/g, "\n     ")}`);
    if (result.metadata.references.length) console.log(`  links: ${result.metadata.references.map((r) => r.label).join(", ")}`);
    if (result.metadata.followUps.length) console.log(`  follow-ups: ${result.metadata.followUps.join(" | ")}`);
    for (const problem of problems) console.log(`  ! ${problem}`);
  }
  console.log(`\n${cases.length - failures}/${cases.length} cases passed`);
  const output = optionValue("--json");
  if (output) {
    writeFileSync(output, `${JSON.stringify({ ...run, only: only ?? null, passed: cases.length - failures, total: cases.length, results }, null, 2)}\n`);
    console.log(`saved ${output}`);
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

void main();
