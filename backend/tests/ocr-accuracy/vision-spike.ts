/**
 * MEASUREMENT ONLY — this is not wired into the app and nothing here runs in
 * production.
 *
 * Phases B (image preprocessing) and C (tesseract engine tuning) both moved
 * corpus accuracy by exactly zero, and neither recovered the two line items
 * lost on the one real crumpled thermal photo. That pointed at an engine
 * limit rather than a configuration one, and the only remaining lever is a
 * different engine — a multimodal model reading the picture directly.
 *
 * Doing that in the product would REVERSE a principle stated in
 * ai.service.ts: extraction is deliberately kept away from language models
 * because one "could invent a line that was never printed", and a number in
 * the owner's books has to come from something measurable. So this script
 * exists to make it measurable BEFORE that trade is made, not after.
 *
 * It answers three questions and stops:
 *   1. Does a vision model read what tesseract cannot?
 *   2. Does it invent lines that were never printed? (the false-positive
 *      count is the one that decides this — a missed item costs a row of
 *      typing, a fabricated one puts money in the books that never existed)
 *   3. What does it actually cost per scan?
 *
 * Scored through tests/ocr-accuracy/scoring.ts — the exact rules the
 * deterministic pipeline is scored by, so the two numbers are comparable.
 *
 *   npx tsx tests/ocr-accuracy/vision-spike.ts            # whole corpus
 *   npx tsx tests/ocr-accuracy/vision-spike.ts real-01-ph-pos-photo
 *
 * Writes vision-spike-results.json and VISION-SPIKE-REPORT.md next to this.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { env } from "../../src/config/env";
import {
  pct,
  scoreAmount,
  scoreDate,
  scoreItems,
  scoreVendor,
  SYMBOL,
  type ExpectedItem,
  type ItemScore,
  type Verdict,
} from "./scoring";

const HERE = __dirname;
const IMAGES = join(HERE, "images");

// Same model the rest of the app talks to, so this measures the cost of a
// capability we already pay for rather than introducing a second vendor.
const MODEL = "gemini-3.5-flash-lite";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Indicative token prices, USD per million tokens.
 *
 * STATED AS AN ASSUMPTION, NOT A FACT — verify against current published
 * pricing before quoting the cost figure in this report anywhere. The token
 * COUNTS below are measured and exact; only the multiplication is an
 * estimate.
 */
const USD_PER_M_INPUT = 0.1;
const USD_PER_M_OUTPUT = 0.4;

/**
 * The extraction prompt.
 *
 * Written to make the model's failure mode "I couldn't read it" rather than
 * "here is a plausible receipt". Every rule below is aimed at the same thing:
 * a value that was not printed must never appear in the answer, because the
 * whole objection to using a model for extraction is that it can produce one.
 */
const PROMPT = `You are reading a photograph of a shop receipt from the Philippines.

Return ONLY a JSON object, no prose and no code fences:
{"date": "YYYY-MM-DD" or null,
 "vendor": "the shop's name" or null,
 "total": the final total as a number, or null,
 "items": [{"name": "...", "quantity": number or null, "amount": number}]}

RULES — these matter more than completeness:
- Transcribe ONLY what is actually printed and legible. If you cannot read a value, use null. Never guess, complete, correct or infer a value that is not visibly there.
- If you cannot read an item's price, LEAVE THE ITEM OUT entirely. A missing item is a minor problem; an invented one puts money in someone's accounts that they never spent.
- "items" means things purchased. Do NOT include subtotals, totals, VAT or tax lines, discounts, change, payment/tender lines, or register metadata.
- "total" is the final amount payable, not the subtotal.
- Numeric dates are DAY/MONTH/YEAR (Philippine convention): 11/07/2026 is 11 July 2026.
- Ignore BIR permit, PTU, accreditation and "valid until" dates — they are not the transaction date.
- Return an empty items array if no individual items are legible.`;

interface Entry {
  id: string;
  file: string;
  kind: "real" | "synthetic" | "degraded";
  conditions: string;
  expected: {
    date: string | null;
    vendor: string | null;
    amount: number | null;
    items?: ExpectedItem[] | null;
  };
}

interface Extracted {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  items: { name: string; quantity: number | null; amount: number }[];
}

interface SpikeResult {
  id: string;
  kind: string;
  conditions: string;
  expected: Entry["expected"];
  actual: Extracted;
  verdict: { date: Verdict; vendor: Verdict; amount: Verdict };
  itemScore: ItemScore | null;
  promptTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
  raw: string;
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerces the model's JSON into the same shape the deterministic parser emits.
 *
 * The single-element array unwrap is not defensive padding — it was MEASURED.
 * At temperature 0, the identical prompt and image returned a bare object on
 * one run and that same object wrapped in an array on the next, which scored
 * as a completely unreadable receipt until handled. The reading itself was
 * correct both times. Any production integration has to tolerate the envelope
 * moving, because the model does not consider it part of the answer.
 */
function coerce(parsed: unknown): Extracted {
  const unwrapped = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  const o = (unwrapped ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(o.items) ? o.items : [];
  const items = rawItems
    .map((it) => {
      const r = (it ?? {}) as Record<string, unknown>;
      const amount = num(r.amount);
      const name = typeof r.name === "string" ? r.name.trim() : "";
      // An item with no readable amount cannot be scored or booked, and the
      // prompt asks for it to be omitted. Dropping it here too keeps a model
      // that ignores that instruction from polluting the comparison.
      if (amount === null || !name) return null;
      return { name, quantity: num(r.quantity), amount };
    })
    .filter((x): x is { name: string; quantity: number | null; amount: number } => x !== null);

  return {
    date: typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null,
    vendor: typeof o.vendor === "string" && o.vendor.trim() ? o.vendor.trim() : null,
    amount: num(o.total),
    items,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries a rate-limited request rather than recording it as an unreadable image. */
async function requestWithBackoff(mimeType: string, buffer: Buffer): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: buffer.toString("base64") } },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" },
      }),
    });

    if (res.ok) return res;
    const body = await res.text();
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const wait = DELAY_MS * 2 ** attempt;
      process.stdout.write(`[429, waiting ${Math.round(wait / 1000)}s] `);
      await sleep(wait);
      continue;
    }
    throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Spacing between requests, to stay inside the API's per-minute quota.
 *
 * A 429 is a quota fact about this key, not a statement about whether the
 * model can read receipts — but it scores as a failed extraction, which would
 * silently understate the result. Throttling keeps the measurement honest.
 */
const DELAY_MS = Number(process.env.VISION_DELAY_MS ?? 4500);
const MAX_ATTEMPTS = 4;

async function extractWithVision(buffer: Buffer, file: string) {
  const mimeType = MIME[extname(file).toLowerCase()] ?? "image/jpeg";
  const res = await requestWithBackoff(mimeType, buffer);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("no text content returned");

  return {
    text,
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

(async () => {
  if (!env.GOOGLE_GEMINI_API_KEY) {
    console.error("GOOGLE_GEMINI_API_KEY is not set — nothing to measure.");
    process.exit(1);
  }

  const corpus: Entry[] = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8"));
  const wanted = process.argv.slice(2);
  const targets = wanted.length > 0 ? corpus.filter((e) => wanted.includes(e.id)) : corpus;

  const results: SpikeResult[] = [];

  for (const [index, entry] of targets.entries()) {
    // Spaced out to stay inside the per-minute quota. See DELAY_MS.
    if (index > 0) await sleep(DELAY_MS);
    process.stdout.write(`  ${entry.id.padEnd(30)} `);
    const buffer = readFileSync(join(IMAGES, entry.file));

    let actual: Extracted = { date: null, vendor: null, amount: null, items: [] };
    let promptTokens = 0;
    let outputTokens = 0;
    let raw = "";
    let error: string | undefined;

    const started = Date.now();
    try {
      const out = await extractWithVision(buffer, entry.file);
      raw = out.text;
      promptTokens = out.promptTokens;
      outputTokens = out.outputTokens;
      actual = coerce(JSON.parse(out.text));
    } catch (err) {
      error = (err as Error).message;
      raw = `ERROR: ${error}`;
    }
    const ms = Date.now() - started;

    const verdict = {
      date: scoreDate(entry.expected.date, actual.date),
      vendor: scoreVendor(entry.expected.vendor, actual.vendor),
      amount: scoreAmount(entry.expected.amount, actual.amount),
    };
    const itemScore = entry.expected.items ? scoreItems(entry.expected.items, actual.items) : null;

    results.push({ id: entry.id, kind: entry.kind, conditions: entry.conditions, expected: entry.expected, actual, verdict, itemScore, promptTokens, outputTokens, ms, error, raw });

    const itemNote = itemScore
      ? `items ${itemScore.matched}/${itemScore.expected}${itemScore.falsePositives ? ` (+${itemScore.falsePositives} FALSE)` : ""}`
      : "items —";
    console.log(
      error
        ? `ERROR ${error.slice(0, 60)}`
        : `date ${SYMBOL[verdict.date]}  vendor ${SYMBOL[verdict.vendor]}  amount ${SYMBOL[verdict.amount]}  ${itemNote}  ${ms}ms`,
    );
  }

  const tally = (field: "date" | "vendor" | "amount") => {
    const scored = results.filter((r) => r.verdict[field] !== "n/a");
    return { correct: scored.filter((r) => r.verdict[field] === "correct").length, scored: scored.length };
  };
  const d = tally("date");
  const v = tally("vendor");
  const a = tally("amount");
  const items = results.reduce(
    (acc, r) => ({
      matched: acc.matched + (r.itemScore?.matched ?? 0),
      expected: acc.expected + (r.itemScore?.expected ?? 0),
      falsePositives: acc.falsePositives + (r.itemScore?.falsePositives ?? 0),
      nameCorrect: acc.nameCorrect + (r.itemScore?.nameCorrect ?? 0),
    }),
    { matched: 0, expected: 0, falsePositives: 0, nameCorrect: 0 },
  );

  const totalIn = results.reduce((s, r) => s + r.promptTokens, 0);
  const totalOut = results.reduce((s, r) => s + r.outputTokens, 0);
  const usdTotal = (totalIn / 1e6) * USD_PER_M_INPUT + (totalOut / 1e6) * USD_PER_M_OUTPUT;
  const usdPerScan = results.length > 0 ? usdTotal / results.length : 0;
  const avgMs = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length) : 0;
  const errors = results.filter((r) => r.error).length;

  writeFileSync(join(HERE, "vision-spike-results.json"), JSON.stringify(results, null, 2));

  const L: string[] = [];
  L.push("# Vision-model extraction — measurement spike");
  L.push("");
  L.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  L.push("");
  L.push(`**Nothing in this report is wired into the app.** This measures whether a multimodal model (\`${MODEL}\`) reads receipts that tesseract cannot, whether it invents lines that were never printed, and what it costs — so the decision to use one for extraction can be made against numbers instead of estimates.`);
  L.push("");
  L.push(`Scored by \`tests/ocr-accuracy/scoring.ts\`, the same rules used for the deterministic pipeline, so these figures are directly comparable to OCR-ACCURACY-REPORT.md.`);
  L.push("");
  L.push("## Results");
  L.push("");
  L.push("| Field | Vision | Deterministic (tesseract) |");
  L.push("|---|---|---|");
  L.push(`| Date | ${d.correct}/${d.scored} (${pct(d.correct, d.scored)}) | 30/30 (100%) |`);
  L.push(`| Vendor | ${v.correct}/${v.scored} (${pct(v.correct, v.scored)}) | 28/29 (97%) |`);
  L.push(`| Amount | ${a.correct}/${a.scored} (${pct(a.correct, a.scored)}) | 30/30 (100%) |`);
  L.push(`| Items found | ${items.matched}/${items.expected} (${pct(items.matched, items.expected)}) | 65/67 (97%) |`);
  L.push(`| **Items invented (false positives)** | **${items.falsePositives}** | **0** |`);
  L.push("");
  if (errors > 0) L.push(`${errors} of ${results.length} images returned an API error.`);
  L.push("");
  L.push("## Cost and latency");
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Images | ${results.length} |`);
  L.push(`| Input tokens (measured) | ${totalIn.toLocaleString()} |`);
  L.push(`| Output tokens (measured) | ${totalOut.toLocaleString()} |`);
  L.push(`| Mean latency | ${avgMs} ms |`);
  L.push(`| Indicative cost per scan | $${usdPerScan.toFixed(5)} |`);
  L.push("");
  L.push(`Token counts are measured and exact. The dollar figure multiplies them by an **assumed** $${USD_PER_M_INPUT}/M input and $${USD_PER_M_OUTPUT}/M output — verify against current published pricing before quoting it.`);
  L.push("");
  L.push("## The number that decides this");
  L.push("");
  L.push(`**${items.falsePositives} invented items across ${results.length} images.**`);
  L.push("");
  L.push("This is the figure the architectural objection rests on. A missed item costs the owner one row of typing; a fabricated one puts a purchase in their books that never happened, and a spending monitor must not do the second.");
  L.push("");
  if (items.falsePositives === 0) {
    L.push("**But zero here is not the same guarantee the parser gives.** The deterministic parser cannot fabricate a line — structurally, not by good behaviour: it only ever reports what a regex matched in text tesseract returned. The model's zero is *empirical*, measured on this corpus on this day. It is strong evidence and it is not a proof, and no number of clean runs converts one into the other. That distinction is the whole of the decision: whether an extractor that is measurably better but only probabilistically safe should be allowed to write numbers into someone's accounts.");
    L.push("");
    L.push("The mitigation the plan already specifies is what makes that trade defensible: this never replaces the deterministic path, it only runs where that path returned nothing, and anything it produces is flagged as a guess rather than presented as a reading — so the failure mode is a wrong number the owner is told to check, not a wrong number presented as fact.");
  } else {
    L.push(`The model invented ${items.falsePositives}. That is the case against using it for extraction, stated in its own numbers — it moves the failure from "the owner types a missing row" to "the owner's books contain a purchase that never happened".`);
  }
  L.push("");
  L.push("## Run-to-run stability");
  L.push("");
  L.push("**Temperature 0 did not make this reproducible.** Repeated full-corpus runs did not produce identical results, which the deterministic parser does by construction.");
  L.push("");
  L.push("The observed instability was in the response *envelope*, not the reading: on one run `deg-05-dark` came back as a bare JSON object and on the next as that same object wrapped in a single-element array. The receipt was read correctly both times — date, vendor and total all exact — but the unhandled shape scored as a totally unreadable image until the parser was taught to unwrap it.");
  L.push("");
  L.push("Two things follow. First, an integration must treat the response shape as untrusted and validate it, exactly as `validateItemCategories` already does for the categoriser. Second, and less comfortably: a component whose output shape moves between identical calls is one whose failure modes cannot be fully enumerated from a single measurement. Budget for surprises this corpus did not produce.");
  L.push("");
  L.push("The reading varied too, on exactly one image and in an instructive way. `syn-03-ambiguous-slash-date` prints `03/09/2026`, where both components are ≤ 12 and nothing in the image can resolve it — the answer is a *convention*, not a reading. Across three runs the model returned 9 March twice and 3 September once, despite the prompt stating the Philippine DD/MM convention explicitly. The deterministic parser gets it right every time, because the convention is written into it as a rule rather than requested as an instruction.");
  L.push("");
  L.push("That is the sharpest statement of what each extractor is good for: **the model is better at reading what is printed; the parser is better at applying a rule the image cannot supply.** The date is the field most in need of a rule, and the one the model is least reliable on.");
  L.push("");
  L.push("## What this corpus cannot tell you");
  L.push("");
  L.push("The same caveat that qualifies the tesseract figures qualifies these: **26 of the 30 images are synthetic renders or programmatic degradations of them**, and only 2 are real photographs. A vision model scoring well on clean renders is no more surprising than tesseract doing so.");
  L.push("");
  L.push("The result that is not explained by corpus composition is `real-01-ph-pos-photo` — the genuine crumpled thermal phone photo, the corpus's hardest image, and the one tesseract reads 0 of 2 items from after preprocessing and engine tuning both failed to move it. Read the comparison as: **strong evidence on the hard real case, weak evidence everywhere else.**");
  L.push("");
  L.push("## Per-image");
  L.push("");
  L.push("| Image | Kind | Date | Vendor | Amount | Items | Invented |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    L.push(
      `| \`${r.id}\` | ${r.kind} | ${SYMBOL[r.verdict.date]} | ${SYMBOL[r.verdict.vendor]} | ${SYMBOL[r.verdict.amount]} | ${r.itemScore ? `${r.itemScore.matched}/${r.itemScore.expected}` : "—"} | ${r.itemScore?.falsePositives ?? 0} |`,
    );
  }
  L.push("");
  const disagreements = results.filter(
    (r) => r.verdict.date === "wrong" || r.verdict.amount === "wrong" || (r.itemScore?.falsePositives ?? 0) > 0,
  );
  if (disagreements.length > 0) {
    L.push("## Where it went wrong");
    L.push("");
    for (const r of disagreements) {
      L.push(`### \`${r.id}\``);
      L.push("");
      L.push(`*${r.conditions}*`);
      L.push("");
      L.push("| Field | Expected | Got |");
      L.push("|---|---|---|");
      if (r.verdict.date === "wrong") L.push(`| date | \`${r.expected.date}\` | \`${r.actual.date}\` |`);
      if (r.verdict.amount === "wrong") L.push(`| amount | \`${r.expected.amount}\` | \`${r.actual.amount}\` |`);
      if ((r.itemScore?.falsePositives ?? 0) > 0) {
        L.push(`| invented items | — | ${r.itemScore!.falsePositives} |`);
        L.push("");
        L.push("Extracted items:");
        L.push("");
        L.push("```json");
        L.push(JSON.stringify(r.actual.items, null, 2));
        L.push("```");
        L.push("");
        L.push("Expected items:");
        L.push("");
        L.push("```json");
        L.push(JSON.stringify(r.expected.items ?? [], null, 2));
        L.push("```");
      }
      L.push("");
    }
  }

  writeFileSync(join(HERE, "VISION-SPIKE-REPORT.md"), L.join("\n") + "\n");

  console.log("");
  console.log(`Date   ${d.correct}/${d.scored} (${pct(d.correct, d.scored)})`);
  console.log(`Vendor ${v.correct}/${v.scored} (${pct(v.correct, v.scored)})`);
  console.log(`Amount ${a.correct}/${a.scored} (${pct(a.correct, a.scored)})`);
  console.log(`Items  ${items.matched}/${items.expected} (${pct(items.matched, items.expected)}), ${items.falsePositives} INVENTED`);
  console.log(`Cost   ~$${usdPerScan.toFixed(5)}/scan (${totalIn} in / ${totalOut} out tokens), ${avgMs}ms mean`);
  console.log("");
  console.log("Wrote VISION-SPIKE-REPORT.md and vision-spike-results.json");
})();
