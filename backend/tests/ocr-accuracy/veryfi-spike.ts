/**
 * MEASUREMENT ONLY — this is not wired into the app and nothing here runs in
 * production. See vision-spike.ts, its sibling, for the full rationale for
 * why alternative extractors get measured here before any product decision
 * is made about them.
 *
 * This one asks a narrower question: Veryfi is a receipt-specific OCR/data
 * extraction API (not a general vision model) — does its structured field
 * extraction beat FinSight's deterministic tesseract pipeline on the fields
 * that actually feed the books (date, vendor, amount)? It exists purely as a
 * reference point for where the tesseract pipeline's extraction is weakest,
 * not as a candidate to integrate.
 *
 * Scored through tests/ocr-accuracy/scoring.ts — the exact rules the
 * deterministic pipeline is scored by, so the numbers are comparable to
 * OCR-ACCURACY-REPORT.md and VISION-SPIKE-REPORT.md.
 *
 * Veryfi's free tier caps monthly requests hard, and this corpus is 79
 * images — running the whole thing in one go can burn the entire month's
 * quota. Always pass explicit image ids until you know your plan's limit:
 *
 *   npx tsx tests/ocr-accuracy/veryfi-spike.ts real-01-ph-pos-photo
 *   npx tsx tests/ocr-accuracy/veryfi-spike.ts real-01-ph-pos-photo syn-03-ambiguous-slash-date
 *   npx tsx tests/ocr-accuracy/veryfi-spike.ts            # whole corpus — asks for confirmation first
 *
 * Writes veryfi-spike-results.json and VERYFI-SPIKE-REPORT.md next to this.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { env } from "../../src/config/env";
import {
  pct,
  scoreAmount,
  scoreDate,
  scoreVendor,
  SYMBOL,
  type Verdict,
} from "./scoring";

const HERE = __dirname;
const IMAGES = join(HERE, "images");

const ENDPOINT = "https://api.veryfi.com/api/v8/partner/documents";

interface Entry {
  id: string;
  file: string;
  kind: "real" | "synthetic" | "degraded";
  conditions: string;
  expected: {
    date: string | null;
    vendor: string | null;
    amount: number | null;
  };
}

interface Extracted {
  date: string | null;
  vendor: string | null;
  amount: number | null;
}

interface SpikeResult {
  id: string;
  kind: string;
  conditions: string;
  expected: Entry["expected"];
  actual: Extracted;
  verdict: { date: Verdict; vendor: Verdict; amount: Verdict };
  ms: number;
  error?: string;
  raw: unknown;
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/**
 * Coerces Veryfi's document response into the same shape the deterministic
 * parser emits, so scoring.ts can compare them without caring which produced
 * either value.
 *
 * Veryfi's `date` comes back as a full timestamp ("2026-07-11 00:00:00"),
 * not the bare YYYY-MM-DD the corpus's ground truth and tesseract path both
 * use — the slice below is not a guess at the format, it is Veryfi's own
 * documented response shape.
 */
function coerce(doc: Record<string, unknown>): Extracted {
  const rawDate = typeof doc.date === "string" ? doc.date : null;
  const date = rawDate && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : null;

  const vendor = doc.vendor && typeof doc.vendor === "object"
    ? (doc.vendor as Record<string, unknown>).name
    : undefined;

  const total = doc.total;

  return {
    date,
    vendor: typeof vendor === "string" && vendor.trim() ? vendor.trim() : null,
    amount: typeof total === "number" && Number.isFinite(total) ? total : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spacing between requests. Not a quota-imposed necessity the way
 * vision-spike.ts's throttle is (Veryfi's free tier is request-capped, not
 * rate-capped per minute) — kept anyway so a burst of failures reads as
 * Veryfi's answer rather than this script hammering the endpoint.
 */
const DELAY_MS = Number(process.env.VERYFI_DELAY_MS ?? 1200);
const MAX_ATTEMPTS = 3;

async function extractWithVeryfi(buffer: Buffer, file: string): Promise<Record<string, unknown>> {
  const mimeType = MIME[extname(file).toLowerCase()] ?? "image/jpeg";
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Client-Id": env.VERYFI_CLIENT_ID,
        Authorization: `apikey ${env.VERYFI_USERNAME}:${env.VERYFI_API_KEY}`,
      },
      body: JSON.stringify({
        file_data: buffer.toString("base64"),
        file_name: file,
        categories: [],
        boost_mode: 0,
      }),
    });

    if (res.ok) return (await res.json()) as Record<string, unknown>;
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const wait = DELAY_MS * 2 ** attempt;
      process.stdout.write(`[${res.status}, waiting ${Math.round(wait / 1000)}s] `);
      await sleep(wait);
      continue;
    }
    throw new Error(`${res.status}: ${body.slice(0, 300)}`);
  }
}

async function confirmWholeCorpusRun(count: number): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `No image id given — this will send all ${count} images to Veryfi, using ${count} requests of your plan's quota. Continue? [y/N] `,
  );
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

(async () => {
  const missing = ["VERYFI_CLIENT_ID", "VERYFI_USERNAME", "VERYFI_API_KEY"].filter(
    (k) => !env[k as "VERYFI_CLIENT_ID" | "VERYFI_USERNAME" | "VERYFI_API_KEY"],
  );
  if (missing.length > 0) {
    console.error(`${missing.join(", ")} not set — nothing to measure.`);
    process.exit(1);
  }

  const corpus: Entry[] = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8"));
  const wanted = process.argv.slice(2);
  const targets = wanted.length > 0 ? corpus.filter((e) => wanted.includes(e.id)) : corpus;

  if (wanted.length === 0) {
    const ok = await confirmWholeCorpusRun(targets.length);
    if (!ok) {
      console.log("Cancelled. Pass one or more image ids to run a subset instead.");
      process.exit(0);
    }
  }

  const results: SpikeResult[] = [];

  for (const [index, entry] of targets.entries()) {
    if (index > 0) await sleep(DELAY_MS);
    process.stdout.write(`  ${entry.id.padEnd(30)} `);
    const buffer = readFileSync(join(IMAGES, entry.file));

    let actual: Extracted = { date: null, vendor: null, amount: null };
    let raw: unknown = null;
    let error: string | undefined;

    const started = Date.now();
    try {
      raw = await extractWithVeryfi(buffer, entry.file);
      actual = coerce(raw as Record<string, unknown>);
    } catch (err) {
      error = (err as Error).message;
      raw = { error };
    }
    const ms = Date.now() - started;

    const verdict = {
      date: scoreDate(entry.expected.date, actual.date),
      vendor: scoreVendor(entry.expected.vendor, actual.vendor),
      amount: scoreAmount(entry.expected.amount, actual.amount),
    };

    results.push({ id: entry.id, kind: entry.kind, conditions: entry.conditions, expected: entry.expected, actual, verdict, ms, error, raw });

    console.log(
      error
        ? `ERROR ${error.slice(0, 60)}`
        : `date ${SYMBOL[verdict.date]}  vendor ${SYMBOL[verdict.vendor]}  amount ${SYMBOL[verdict.amount]}  ${ms}ms`,
    );
  }

  const tally = (field: "date" | "vendor" | "amount") => {
    const scored = results.filter((r) => r.verdict[field] !== "n/a");
    return { correct: scored.filter((r) => r.verdict[field] === "correct").length, scored: scored.length };
  };
  const d = tally("date");
  const v = tally("vendor");
  const a = tally("amount");
  const avgMs = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length) : 0;
  const errors = results.filter((r) => r.error).length;

  writeFileSync(join(HERE, "veryfi-spike-results.json"), JSON.stringify(results, null, 2));

  const L: string[] = [];
  L.push("# Veryfi extraction — measurement spike");
  L.push("");
  L.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  L.push("");
  L.push("**Nothing in this report is wired into the app.** This measures whether Veryfi's receipt-specific OCR/data-extraction API reads the fields tesseract gets wrong (date, vendor, amount) — a reference point for where the deterministic pipeline is weakest, not a candidate being integrated.");
  L.push("");
  L.push("Scored by `tests/ocr-accuracy/scoring.ts`, the same rules used for the deterministic pipeline, so these figures are directly comparable to `OCR-ACCURACY-REPORT.md`.");
  L.push("");
  L.push("## Results");
  L.push("");
  L.push("| Field | Veryfi | Deterministic (tesseract) |");
  L.push("|---|---|---|");
  L.push(`| Date | ${d.correct}/${d.scored} (${pct(d.correct, d.scored)}) | 30/30 (100%) |`);
  L.push(`| Vendor | ${v.correct}/${v.scored} (${pct(v.correct, v.scored)}) | 28/29 (97%) |`);
  L.push(`| Amount | ${a.correct}/${a.scored} (${pct(a.correct, a.scored)}) | 30/30 (100%) |`);
  L.push("");
  if (errors > 0) L.push(`${errors} of ${results.length} images returned an API error.`);
  L.push("");
  L.push("## Latency");
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Images | ${results.length} |`);
  L.push(`| Mean latency | ${avgMs} ms |`);
  L.push("");
  L.push("## What this corpus cannot tell you");
  L.push("");
  L.push("The same caveat that qualifies the tesseract figures qualifies these: most of this corpus is synthetic renders or programmatic degradations of them, and only a couple of images are real photographs. Read any strong Veryfi showing on the synthetic majority as weak evidence; the real photo(s) are where a genuine capability gap would actually show.");
  L.push("");
  L.push("## Per-image");
  L.push("");
  L.push("| Image | Kind | Date | Vendor | Amount |");
  L.push("|---|---|---|---|---|");
  for (const r of results) {
    L.push(`| \`${r.id}\` | ${r.kind} | ${SYMBOL[r.verdict.date]} | ${SYMBOL[r.verdict.vendor]} | ${SYMBOL[r.verdict.amount]} |`);
  }
  L.push("");
  const disagreements = results.filter((r) => r.verdict.date === "wrong" || r.verdict.vendor === "wrong" || r.verdict.amount === "wrong" || r.error);
  if (disagreements.length > 0) {
    L.push("## Where it went wrong");
    L.push("");
    for (const r of disagreements) {
      L.push(`### \`${r.id}\``);
      L.push("");
      L.push(`*${r.conditions}*`);
      L.push("");
      if (r.error) {
        L.push(`Error: ${r.error}`);
      } else {
        L.push("| Field | Expected | Got |");
        L.push("|---|---|---|");
        if (r.verdict.date === "wrong") L.push(`| date | \`${r.expected.date}\` | \`${r.actual.date}\` |`);
        if (r.verdict.vendor === "wrong") L.push(`| vendor | \`${r.expected.vendor}\` | \`${r.actual.vendor}\` |`);
        if (r.verdict.amount === "wrong") L.push(`| amount | \`${r.expected.amount}\` | \`${r.actual.amount}\` |`);
      }
      L.push("");
    }
  }

  writeFileSync(join(HERE, "VERYFI-SPIKE-REPORT.md"), L.join("\n") + "\n");

  console.log("");
  console.log(`Date   ${d.correct}/${d.scored} (${pct(d.correct, d.scored)})`);
  console.log(`Vendor ${v.correct}/${v.scored} (${pct(v.correct, v.scored)})`);
  console.log(`Amount ${a.correct}/${a.scored} (${pct(a.correct, a.scored)})`);
  console.log(`Mean latency ${avgMs}ms`);
  console.log("");
  console.log("Wrote VERYFI-SPIKE-REPORT.md and veryfi-spike-results.json");
})();
