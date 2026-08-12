/**
 * AI response-quality rubric.
 *
 * Deliberately NOT part of `npm test`. Language-model output quality is a
 * judgement, not a pass/fail assertion — and every run costs real API calls and
 * returns slightly different wording. This is a checklist that is run
 * occasionally, recorded, and read by a human.
 *
 * What IS auto-checked per response:
 *   (a) grounded    — every money figure in the answer traces to a real figure
 *                     from the profile/records, or to the deterministic
 *                     simulator. Any unaccounted figure is flagged for review.
 *   (c) no invention — the honesty cases must admit missing data rather than
 *                     producing numbers.
 * What needs a human read:
 *   (b) plain language — heuristically screened for jargon, then eyeballed.
 *
 * Usage (backend must be running, real AI keys loaded):
 *   npx tsx tests/ai-quality/run-rubric.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:4100/api/v1";
const PASSWORD = "RubricPass123";

type Module = "Dashboard" | "Expense Insights" | "Spending Impact" | "Recovery Target";

interface Probe {
  module: Module;
  kind: "factual" | "unanswerable" | "follow-up" | "strategy" | "scenario" | "ambiguous";
  question: string;
  /** Substrings that must appear (real figures the answer should cite). */
  mustMention?: string[];
  /** The answer must admit it lacks data. */
  mustAdmitMissing?: boolean;
  /** The answer must ask a clarifying question rather than guess. */
  mustAskClarification?: boolean;
  /** Run against the sparse (empty) profile instead of the populated one. */
  sparse?: boolean;
}

let token = "";
let sparseToken = "";

async function api(method: string, path: string, body?: unknown, query?: Record<string, string | number>, tok = token) {
  const qs = query ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : "";
  const res = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// Accounting/finance jargon a shopkeeper with no bookkeeping background would
// not be expected to know. Screening only — a hit is a prompt to read the
// sentence, not an automatic failure.
const JARGON = [
  "net margin", "gross margin", "EBITDA", "accrual", "amortis", "amortiz", "depreciat",
  "liquidity ratio", "working capital", "cash flow statement", "balance sheet",
  "P&L", "profit and loss", "COGS", "cost of goods sold", "variance analysis",
  "standard deviation", "z-score", "percentile", "regression", "coefficient",
];

const ADMITS_MISSING =
  /no (expense |sales |actual |specific |recorded )*(records?|spending|expenses|sales|data|categories)|don'?t (have|show)|not (yet |)(been )?recorded|nothing recorded|haven'?t (yet |)recorded|no recorded|can'?t point|0\.00|zero/i;

const ASKS_CLARIFICATION = /\?/;

interface Row {
  module: Module;
  kind: string;
  question: string;
  answer: string;
  provider: string;
  grounded: "yes" | "review";
  plain: "yes" | "review";
  noInvention: "yes" | "no";
  notes: string[];
}

/** Money-shaped figures the answer states. */
function figuresIn(answer: string): number[] {
  return [...answer.matchAll(/(?:PHP|₱|P)?\s?(\d[\d,]*(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

(async () => {
  // ---- Set up two profiles: one populated with known figures, one empty ----
  const email = `finsight.rubric+${Date.now()}@example.com`;
  const reg = await api("POST", "/auth/register", { email, password: PASSWORD, firstName: "Rubric", lastName: "Run" }, undefined, "");
  token = reg.session.access_token;

  const profile = await api("POST", "/business-profiles", {
    name: "Rubric Test Store", type: "Sari-Sari Store",
    availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25,
    largeExpenseThresholdPercent: 25,
  });
  const bp = profile.id;

  const cats: Record<string, number> = {};
  for (const name of ["Inventory", "Utilities", "Transportation", "Rent"]) {
    cats[name] = (await api("POST", "/records/categories", { businessProfileId: bp, name })).id;
  }

  const day = (o: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + o);
    return d.toISOString().slice(0, 10);
  };

  // Known figures the answers should cite. Inventory dominates and contains a
  // planted outlier; Utilities and Transportation are rising.
  const expensesSeed: [string, string, number, number][] = [
    // Seven ordinary restocks, because unusual-expense detection needs
    // MIN_HISTORY_FOR_DETECTION (8) records in a category before it scores.
    ["Inventory", "Supplier stocks", 6000, -2],
    ["Inventory", "Supplier stocks B", 5800, -5],
    ["Inventory", "Supplier stocks C", 6200, -8],
    ["Inventory", "Supplier stocks D", 5500, -11],
    ["Inventory", "Supplier stocks E", 5900, -13],
    ["Inventory", "Supplier stocks F", 6100, -15],
    ["Inventory", "Supplier stocks G", 5700, -17],
    ["Inventory", "Bulk rice delivery", 30000, -3],
    ["Utilities", "Electric bill", 5500, -6],
    ["Transportation", "Fuel", 2600, -4],
    ["Rent", "Monthly rent", 12000, -10],
    // Previous period, lower — creates an upward trend.
    ["Inventory", "Old stocks", 4000, -33],
    ["Utilities", "Old electric", 4100, -36],
    ["Transportation", "Old fuel", 1100, -40],
  ];
  for (const [cat, desc, amount, off] of expensesSeed) {
    await api("POST", "/records/expenses", {
      businessProfileId: bp, categoryId: cats[cat], date: day(off), description: desc, amount,
    });
  }
  for (let i = 0; i < 9; i++) {
    await api("POST", "/records/sales", {
      businessProfileId: bp, date: day(-i * 2), description: `Daily sales ${i}`, amount: 5000,
    });
  }

  const sparseEmail = `finsight.rubric.sparse+${Date.now()}@example.com`;
  const sparseReg = await api("POST", "/auth/register", { email: sparseEmail, password: PASSWORD, firstName: "Sparse", lastName: "Run" }, undefined, "");
  sparseToken = sparseReg.session.access_token;
  const sparseBp = (await api("POST", "/business-profiles", {
    name: "Brand New Store", type: "Sari-Sari Store",
    availableFunds: 500, expectedMonthlyExpenses: 2000, operatingDays: 20,
  }, undefined, sparseToken)).id;

  // Real figures, pulled from the deterministic endpoints, used to judge
  // groundedness rather than hand-guessed.
  const recovery = await api("GET", "/insights/recovery", undefined, { businessProfileId: bp });
  const dash = await api("GET", "/dashboard/summary", undefined, { businessProfileId: bp, periodDays: 30 });
  const behavior = await api("GET", "/insights/expense-behavior", undefined, { businessProfileId: bp, periodDays: 30 });
  const impact11k = await api("GET", "/insights/spending-impact", undefined, { businessProfileId: bp, plannedAmount: 11000, periodDays: 30 });
  const impact3k = await api("GET", "/insights/spending-impact", undefined, { businessProfileId: bp, plannedAmount: 3000, periodDays: 30 });

  const allowedFigures = new Set<number>([
    0, 48500, 125000, 25, 20,
    recovery.dailyNeededTarget, recovery.salesThisMonth, recovery.remainingTarget,
    recovery.remainingOperatingDays, Math.round(recovery.adjustedDailyTarget * 100) / 100,
    recovery.todaysTarget, recovery.todaysSales, Math.abs(recovery.todaysGap),
    Math.round(recovery.monthCoveragePercent * 10) / 10,
    recovery.daysInMonth, recovery.calendarDaysLeftInMonth,
    dash.overview.totalExpenses, dash.overview.totalSalesReference, dash.recordsNeedingReview,
    impact11k.funds.after, impact11k.periodExpenses.before, impact11k.periodExpenses.after,
    Math.round(impact11k.percentOfFunds * 10) / 10, impact11k.thresholdAmount, 11000,
    // The Noticeable-band floor. The context states it as a percentage; the
    // model correctly converts it to pesos (40% of the threshold amount).
    impact11k.thresholdAmount * 0.4,
    ...behavior.categoryTrends.flatMap((t: any) => [t.current, t.previous, Math.round(Math.abs(t.percentChange ?? 0) * 10) / 10]),
    // Period totals and the period-over-period delta. The model legitimately
    // derives these by summing/subtracting figures it was given, so they are
    // grounded even though no single endpoint returns them.
    behavior.categoryTrends.reduce((s: number, t: any) => s + t.previous, 0),
    behavior.categoryTrends.reduce((s: number, t: any) => s + t.current, 0),
    Math.abs(
      behavior.categoryTrends.reduce((s: number, t: any) => s + t.current, 0) -
        behavior.categoryTrends.reduce((s: number, t: any) => s + t.previous, 0)
    ),
    // The 3,000 follow-up scenario in the Spending Impact probes.
    3000,
    impact3k.funds.after,
    impact3k.periodExpenses.after,
    Math.round(impact3k.percentOfFunds * 10) / 10,
    ...behavior.unusualExpenses.flatMap((u: any) => [u.amount, Math.round(u.categoryMean * 100) / 100]),
    ...dash.expenseCategoryBreakdown.map((c: any) => Math.round(c.percent * 10) / 10),
    ...Array.from({ length: 32 }, (_, i) => i),
    new Date().getUTCFullYear(),
  ]);

  const PROBES: Probe[] = [
    // ---- Dashboard ----
    { module: "Dashboard", kind: "factual", question: "How much have I spent in the last 30 days?", mustMention: [dash.overview.totalExpenses.toLocaleString("en-US")] },
    { module: "Dashboard", kind: "factual", question: "How many records need my review?" },
    { module: "Dashboard", kind: "strategy", question: "How can I reduce my expenses?", mustMention: ["Inventory"] },
    { module: "Dashboard", kind: "follow-up", question: "Which of those should I look at first?" },
    { module: "Dashboard", kind: "unanswerable", question: "What was my profit margin last quarter?" },
    { module: "Dashboard", kind: "unanswerable", question: "How much do I owe my suppliers right now?" },

    // ---- Expense Insights ----
    { module: "Expense Insights", kind: "factual", question: "Which expense category is my highest this period?", mustMention: ["Inventory"] },
    { module: "Expense Insights", kind: "follow-up", question: "Why is that one so high?", mustMention: ["30,000"] },
    { module: "Expense Insights", kind: "factual", question: "Did my utilities go up or down compared to last period?", mustMention: ["Utilities"] },
    { module: "Expense Insights", kind: "strategy", question: "Give me practical ways to cut my costs based on my actual records.", mustMention: ["Inventory"] },
    { module: "Expense Insights", kind: "unanswerable", question: "Which supplier gives me the best price?" },
    { module: "Expense Insights", kind: "factual", question: "Are any of my expenses unusual?", mustMention: ["Bulk rice delivery"] },

    // ---- Spending Impact ----
    { module: "Spending Impact", kind: "scenario", question: "What if I spend ₱11,000 on a fridge?", mustMention: [impact11k.funds.after.toLocaleString("en-US"), impact11k.percentOfFunds.toFixed(1)] },
    { module: "Spending Impact", kind: "follow-up", question: "And what if it were only 3,000 instead?" },
    { module: "Spending Impact", kind: "ambiguous", question: "What if I buy a new freezer for the store?", mustAskClarification: true },
    { module: "Spending Impact", kind: "factual", question: "What counts as a large expense for me?", mustMention: ["25"] },
    { module: "Spending Impact", kind: "unanswerable", question: "Will the fridge pay for itself within a year?" },

    // ---- Recovery Target ----
    { module: "Recovery Target", kind: "factual", question: "Did I reach today's target?" },
    { module: "Recovery Target", kind: "factual", question: "What is my adjusted daily target?" },
    { module: "Recovery Target", kind: "follow-up", question: "Why did it change from my original target?" },
    { module: "Recovery Target", kind: "strategy", question: "What should I focus on to catch up?" },
    { module: "Recovery Target", kind: "unanswerable", question: "Will I hit my target by the end of the month?" },

    // ---- Sparse-data honesty, in the open chat form ----
    { module: "Expense Insights", kind: "unanswerable", question: "Which of my expense categories is highest, and why did it go up?", sparse: true, mustAdmitMissing: true },
    { module: "Dashboard", kind: "unanswerable", question: "How is my business doing this month?", sparse: true, mustAdmitMissing: true },
    { module: "Expense Insights", kind: "unanswerable", question: "How can I reduce my expenses?", sparse: true, mustAdmitMissing: true },
    { module: "Recovery Target", kind: "unanswerable", question: "Am I on track?", sparse: true, mustAdmitMissing: true },
  ];

  const rows: Row[] = [];

  for (const probe of PROBES) {
    const targetBp = probe.sparse ? sparseBp : bp;
    const tok = probe.sparse ? sparseToken : token;
    process.stdout.write(`  [${probe.module}/${probe.kind}${probe.sparse ? "/sparse" : ""}] ${probe.question.slice(0, 46)}… `);

    const res = await api("POST", "/ai/ask", { businessProfileId: targetBp, module: probe.module, question: probe.question }, undefined, tok);
    const answer: string = res.answer;
    const notes: string[] = [];

    // (a) grounded
    let grounded: Row["grounded"] = "yes";
    if (!probe.sparse) {
      const allowed = [...allowedFigures];
      const near = (a: number, n: number) => Math.abs(a - n) < 0.75 || (a !== 0 && Math.abs(a - n) / a < 0.005);
      const unaccounted = figuresIn(answer).filter((n) => {
        if (allowedFigures.has(n)) return false;
        if (allowed.some((a) => near(a, n))) return false;
        // A single arithmetic step over two source figures is still grounded —
        // "up by X compared to Y" is the model subtracting two numbers it was
        // given, not inventing one. Two-step chains are not accepted, so a
        // genuinely fabricated figure still surfaces.
        return !allowed.some((a) => allowed.some((b) => near(a - b, n) || near(a + b, n) || near(a * 0.4, n)));
      });
      if (unaccounted.length > 0) {
        grounded = "review";
        notes.push(`figures not traced to source data: ${[...new Set(unaccounted)].join(", ")}`);
      }
    } else {
      const sparseAllowed = new Set([0, 500, 2000, 20, 100, 400, ...Array.from({ length: 32 }, (_, i) => i), new Date().getUTCFullYear()]);
      const bad = figuresIn(answer).filter((n) => !sparseAllowed.has(n));
      if (bad.length > 0) {
        grounded = "review";
        notes.push(`figures on an EMPTY profile: ${[...new Set(bad)].join(", ")}`);
      }
    }
    for (const m of probe.mustMention ?? []) {
      if (!answer.replace(/,/g, "").toLowerCase().includes(m.replace(/,/g, "").toLowerCase())) {
        grounded = "review";
        notes.push(`did not cite expected figure/term "${m}"`);
      }
    }

    // (b) plain language
    const jargonHits = JARGON.filter((j) => answer.toLowerCase().includes(j.toLowerCase()));
    const plain: Row["plain"] = jargonHits.length === 0 ? "yes" : "review";
    if (jargonHits.length) notes.push(`jargon: ${jargonHits.join(", ")}`);

    // (c) no invention
    let noInvention: Row["noInvention"] = "yes";
    if (probe.mustAdmitMissing && !ADMITS_MISSING.test(answer)) {
      noInvention = "no";
      notes.push("did not admit missing data");
    }
    if (probe.mustAskClarification && !ASKS_CLARIFICATION.test(answer)) {
      noInvention = "no";
      notes.push("did not ask for clarification");
    }
    if (probe.kind === "unanswerable" && !probe.sparse && !probe.mustAskClarification) {
      if (!ADMITS_MISSING.test(answer) && !/can'?t|cannot|unable|don'?t know|not able|no way to|would need/i.test(answer)) {
        noInvention = "no";
        notes.push("answered an unanswerable question without caveat");
      }
    }
    if (grounded === "review" && notes.some((n) => n.startsWith("figures on an EMPTY profile"))) noInvention = "no";

    rows.push({ module: probe.module, kind: probe.kind + (probe.sparse ? " (sparse)" : ""), question: probe.question, answer, provider: res.provider, grounded, plain, noInvention, notes });
    console.log(`${grounded === "yes" ? "✅" : "🔍"}${plain === "yes" ? "✅" : "🔍"}${noInvention === "yes" ? "✅" : "❌"}`);
  }

  // ---- Report ----
  const lines: string[] = [];
  lines.push("# FinSight AI Response Quality Rubric");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${rows.length} questions across 4 modules`);
  lines.push("");
  lines.push("Each response is judged on three criteria:");
  lines.push("");
  lines.push("- **(a) Grounded** — every money figure traces to the owner's real profile/record data or to the deterministic simulator. Checked automatically against the same endpoints the screens use, allowing one arithmetic step over two source figures (e.g. \"up by X\" is a subtraction of two given numbers). Anything else is flagged 🔍 for a human to read — a flag is a prompt to check, not a proven error.");
  lines.push("- **(b) Plain language** — no accounting jargon a shopkeeper wouldn't know. Auto-screened against a jargon list, then read.");
  lines.push("- **(c) No invention** — questions the data can't answer must be declined; ambiguous scenarios must ask rather than guess.");
  lines.push("");
  lines.push("✅ pass · 🔍 needs a human read · ❌ fail");
  lines.push("");

  const g = rows.filter((r) => r.grounded === "yes").length;
  const p = rows.filter((r) => r.plain === "yes").length;
  const n = rows.filter((r) => r.noInvention === "yes").length;
  lines.push("## Summary");
  lines.push("");
  lines.push("| Criterion | Pass | Rate |");
  lines.push("|---|---|---|");
  lines.push(`| (a) Grounded in real numbers | ${g}/${rows.length} | ${((g / rows.length) * 100).toFixed(0)}% |`);
  lines.push(`| (b) Plain language | ${p}/${rows.length} | ${((p / rows.length) * 100).toFixed(0)}% |`);
  lines.push(`| (c) Invented nothing | ${n}/${rows.length} | ${((n / rows.length) * 100).toFixed(0)}% |`);
  lines.push("");
  const providers = [...new Set(rows.map((r) => r.provider))];
  lines.push(`Provider(s) used: ${providers.join(", ")}${providers.includes("unavailable") ? " — **an outage occurred during this run; affected rows are not meaningful**" : ""}`);
  lines.push("");

  lines.push("## By question type");
  lines.push("");
  lines.push("| Type | n | Grounded | Plain | No invention |");
  lines.push("|---|---|---|---|---|");
  for (const kind of [...new Set(rows.map((r) => r.kind))]) {
    const s = rows.filter((r) => r.kind === kind);
    lines.push(`| ${kind} | ${s.length} | ${s.filter((r) => r.grounded === "yes").length}/${s.length} | ${s.filter((r) => r.plain === "yes").length}/${s.length} | ${s.filter((r) => r.noInvention === "yes").length}/${s.length} |`);
  }
  lines.push("");

  for (const module of ["Dashboard", "Expense Insights", "Spending Impact", "Recovery Target"] as Module[]) {
    const subset = rows.filter((r) => r.module === module);
    if (!subset.length) continue;
    lines.push(`## ${module}`);
    lines.push("");
    for (const r of subset) {
      lines.push(`**Q (${r.kind}):** ${r.question}`);
      lines.push("");
      lines.push(`> ${r.answer.replace(/\n+/g, "\n> ")}`);
      lines.push("");
      lines.push(`(a) ${r.grounded === "yes" ? "✅" : "🔍"} grounded · (b) ${r.plain === "yes" ? "✅" : "🔍"} plain · (c) ${r.noInvention === "yes" ? "✅" : "❌"} no invention`);
      if (r.notes.length) lines.push("");
      if (r.notes.length) lines.push(`Notes: ${r.notes.join("; ")}`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  const out = join(__dirname, "AI-QUALITY-RUBRIC.md");
  writeFileSync(out, lines.join("\n") + "\n");
  writeFileSync(join(__dirname, "results.json"), JSON.stringify(rows, null, 2) + "\n");

  console.log("");
  console.log(`(a) grounded      ${g}/${rows.length}`);
  console.log(`(b) plain         ${p}/${rows.length}`);
  console.log(`(c) no invention  ${n}/${rows.length}`);
  console.log("");
  console.log(`Wrote ${out}`);
})().catch((e) => { console.error("RUBRIC ERROR:", e.message); process.exit(1); });
