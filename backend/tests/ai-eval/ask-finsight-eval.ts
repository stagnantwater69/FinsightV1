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
 */
import { askFinSight } from "../../src/services/ai.service";
import { groundAnswer, recordTag, type RecordReference } from "../../src/services/aiAnswer.service";

const fries: RecordReference = { kind: "record", recordType: "expense", id: 343, label: "Frozen fries x5", amount: 550, date: "2022-01-10" };
const wrappers: RecordReference = { kind: "record", recordType: "expense", id: 377, label: "Burger wrappers x104", amount: 156, date: "2022-01-11" };
const meals: RecordReference = { kind: "record", recordType: "expense", id: 412, label: "Team lunch", amount: 900, date: "2022-01-14" };
const references = new Map([fries, wrappers, meals].map((r) => [recordTag(r.recordType, r.id), r]));

const CONTEXT = `=== BUSINESS PROFILE ===
Name: Kusina ni Ana (Restaurant)
Starting available funds: PHP 50,000.00 (baseline date 2022-01-01)

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

interface Case {
  name: string;
  question: string;
  expectReference?: number;
  expectFilipino?: boolean;
  /** The question invites arithmetic; a draft caught and revised by the guard is the expected path. */
  revisionExpected?: boolean;
}

const CASES: Case[] = [
  { name: "explains the focused flag", question: "Why was this flagged?", expectReference: 412 },
  { name: "gives a link when asked", question: "Can you give me a link to the frozen fries purchase so I can open it?", expectReference: 343 },
  { name: "totals come from the server", question: "How much did I spend on fries in January?", expectReference: 343 },
  { name: "replies in Filipino", question: "Bakit na-flag ang team lunch?", expectFilipino: true },
  { name: "replies in Taglish", question: "Ano yung pinaka-malaking gastos ko this month?", expectFilipino: true },
  { name: "refuses to do arithmetic", question: "How much more did I spend on the team lunch than usual?", revisionExpected: true },
  { name: "is honest about missing data", question: "How much did I spend on electricity in March 2021?" },
  { name: "does not decide for the owner", question: "Should I stop buying team lunches?" },
];

const JARGON = /\b(z-?score|iqr|outlier|baseline|standard deviation)\b/i;
const FILLER = /^(great question|certainly|sure thing|absolutely)/i;
const FILIPINO_MARKERS = /\b(ang|ng|mo|ito|iyong|yung|kasi|dahil|sa|na|ay|mas|lang|po)\b/i;

async function main() {
  let failures = 0;
  for (const testCase of CASES) {
    const result = await groundAnswer(askFinSight, { context: CONTEXT, question: testCase.question, references });
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

    failures += problems.length > 0 ? 1 : 0;
    console.log(`\n${problems.length === 0 ? "PASS" : "FAIL"}  ${testCase.name}  [${result.provider}]`);
    console.log(`  Q: ${testCase.question}`);
    console.log(`  A: ${result.answer.replace(/\n/g, "\n     ")}`);
    if (result.metadata.references.length) console.log(`  links: ${result.metadata.references.map((r) => r.label).join(", ")}`);
    if (result.metadata.followUps.length) console.log(`  follow-ups: ${result.metadata.followUps.join(" | ")}`);
    for (const problem of problems) console.log(`  ! ${problem}`);
  }
  console.log(`\n${CASES.length - failures}/${CASES.length} cases passed`);
  process.exitCode = failures > 0 ? 1 : 0;
}

void main();
