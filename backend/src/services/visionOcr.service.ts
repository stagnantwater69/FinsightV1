import { env } from "../config/env";
import { GEMINI_ENDPOINT } from "./ai.service";
import { logger } from "../config/logger";

/**
 * Reading a receipt photograph with a multimodal model, for the receipts the
 * deterministic parser cannot read at all.
 *
 * ============================================================
 * THIS REVERSES A RULE THIS CODEBASE STATED, AND HERE IS WHY
 * ============================================================
 * ai.service says extraction is deliberately kept away from language models,
 * because one "could invent a line that was never printed" and a number in
 * the owner's books must come from something measurable. That reasoning was
 * right, and it is still right about the MAIN path — which is why this is not
 * the main path and never runs on a receipt tesseract could read.
 *
 * What changed is that the alternative was measured rather than assumed. On
 * the 30-image corpus (tests/ocr-accuracy/VISION-SPIKE-REPORT.md):
 *
 *   - the real crumpled thermal photo, which tesseract reads 0 of 2 items
 *     from and which neither image preprocessing nor engine tuning moved at
 *     all, reads 2 of 2 here;
 *   - items overall: 67/67 versus 65/67;
 *   - items INVENTED: 0, across three full runs.
 *
 * That last number is the one the original objection rests on, and it is also
 * the one to be most careful about. Zero invented lines is an EMPIRICAL
 * result on one corpus, not the structural guarantee the regex parser gives:
 * that parser cannot fabricate a line because it only ever reports what it
 * matched. This can, in principle, on an input unlike anything measured.
 *
 * So the design confines that risk rather than accepting it:
 *   1. tesseract always runs first and always wins where it read anything;
 *   2. this only runs where the deterministic path produced nothing, so it
 *      can only ever add to an otherwise empty result;
 *   3. everything it produces is flagged all the way to the screen, so the
 *      owner is told a machine guessed rather than read;
 *   4. nothing is saved until the owner confirms it, exactly as before.
 *
 * The failure mode this leaves is "a wrong number the owner was told to
 * check", not "a wrong number presented as fact".
 */

/**
 * How long to wait before giving up on the model.
 *
 * The owner is watching a spinner. Measured latency was ~1.7s per receipt, so
 * this is generous — but a provider that hangs must cost the scan a few
 * seconds and then be abandoned, not hold the upload open indefinitely.
 */
const TIMEOUT_MS = 20_000;

/** A receipt cannot plausibly have more lines than this; a longer list is a runaway answer. */
const MAX_ITEMS = 100;

export interface VisionReceipt {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  items: { name: string; quantity: number | null; amount: number }[];
}

/**
 * The extraction prompt.
 *
 * Every rule below points at the same thing: make the model's failure mode
 * "I could not read it" rather than "here is a plausible receipt". The
 * instruction to omit an item whose price is illegible is the load-bearing
 * one — a missing row costs the owner some typing, an invented row puts
 * money in their accounts that they never spent.
 */
const PROMPT = `You are reading a photograph of a shop receipt from the Philippines. You may
be given more than one image — if so, they are PAGES OF THE SAME RECEIPT, in
order (a receipt too long for one photograph). Read them as one continuous
document: items may appear on any page, and the total is usually on the last
one.

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
- If more than one page shows a total, they are the SAME receipt's total repeated (a running total, or the same figure reprinted) — report it once, not summed.
- Numeric dates are DAY/MONTH/YEAR (Philippine convention): 11/07/2026 is 11 July 2026.
- Ignore BIR permit, PTU, accreditation and "valid until" dates — they are not the transaction date.
- Return an empty items array if no individual items are legible.`;

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Turns whatever came back into the shape the rest of the pipeline expects,
 * discarding anything that does not survive checking.
 *
 * The single-element array unwrap is not defensive padding, it was MEASURED:
 * at temperature 0 the identical prompt and image returned a bare object on
 * one run and that same object wrapped in an array on the next. The reading
 * was correct both times; only the envelope moved. A model whose output shape
 * varies between identical calls has to be treated as untrusted input, which
 * is the same discipline validateItemCategories already applies to the
 * categoriser's answers.
 */
export function validateVisionReceipt(raw: string): VisionReceipt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim());
  } catch {
    return null;
  }

  const unwrapped = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (typeof unwrapped !== "object" || unwrapped === null || Array.isArray(unwrapped)) return null;
  const o = unwrapped as Record<string, unknown>;

  const items: VisionReceipt["items"] = [];
  for (const entry of Array.isArray(o.items) ? o.items.slice(0, MAX_ITEMS) : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const amount = finiteNumber(r.amount);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    // A line with no name or no positive price cannot be booked or checked
    // against the photo, so it is dropped rather than stored as a mystery.
    if (!name || amount === null || amount <= 0) continue;
    const quantity = finiteNumber(r.quantity);
    items.push({
      name: name.slice(0, 255),
      quantity: quantity !== null && quantity > 0 ? quantity : null,
      amount,
    });
  }

  const amount = finiteNumber(o.total);
  return {
    // Only a real calendar-shaped date. The deterministic parser guards this
    // heavily because an impossible date fails the whole upload at Prisma.
    date: typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && !Number.isNaN(Date.parse(o.date))
      ? o.date
      : null,
    vendor: typeof o.vendor === "string" && o.vendor.trim() ? o.vendor.trim().slice(0, 150) : null,
    amount: amount !== null && amount > 0 ? amount : null,
    items,
  };
}

/** One photographed page, as the vision call needs it. */
export interface VisionPage {
  buffer: Buffer;
  mimetype: string;
}

/**
 * Reads a receipt with the vision model — one page, or several pages of one
 * long receipt.
 *
 * Every page rides in the SAME request as additional `inlineData` parts
 * rather than one request per page. Gemini reads a multi-part message as one
 * document in the order the parts arrive, so a 3-page receipt costs exactly
 * what a 1-page one does — the alternative, one call per page, would both
 * triple the bill and hand back three unrelated extractions with no shared
 * notion of "the total is on the last page, the items span all three".
 *
 * Returns null rather than throwing on every failure path — no key, provider
 * down, timeout, unparseable answer. This is a last-ditch attempt to rescue a
 * scan that already failed to parse; it must never be the reason an upload is
 * lost, which is the same promise the categoriser makes.
 */
export async function extractReceiptWithVision(pages: VisionPage[]): Promise<VisionReceipt | null> {
  if (!env.GOOGLE_GEMINI_API_KEY) return null;
  if (pages.length === 0) return null;

  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              // Pages first, in capture order, then the instruction — so a
              // model reading front-to-back sees every page before it is told
              // what to do with them.
              ...pages.map((p) => ({ inlineData: { mimeType: p.mimetype, data: p.buffer.toString("base64") } })),
              { text: PROMPT },
            ],
          },
        ],
        // temperature 0 for the most repeatable answer available, though the
        // spike measured that this does NOT make it deterministic.
        generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.error(`Vision receipt read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    return validateVisionReceipt(text);
  } catch (err) {
    logger.error({ err }, "Vision receipt read failed");
    return null;
  }
}
