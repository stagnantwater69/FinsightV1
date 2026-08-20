import { z } from "zod";
import { env } from "../config/env";
import { GEMINI_ENDPOINT } from "./ai.service";
import { logger } from "../config/logger";
import { isReceiptWarningCode, WARNING_CODES, type ReceiptWarningCode } from "../lib/receiptWarnings";

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
 * Version tags for the vision half of the extraction pipeline, recorded on
 * every scan (ReceiptScan.extractorVersions). Bump PROMPT_VERSION with any
 * wording change to PROMPT, and SCHEMA_VERSION with any change to
 * RESPONSE_SCHEMA / the Zod validation shape — a regression that appears in
 * the correction metrics must be attributable to the exact prompt and schema
 * that produced it, not to "the vision model".
 */
export const PROMPT_VERSION = "vision-prompt-v2";
export const SCHEMA_VERSION = "vision-schema-v1";

/**
 * The model actually being called, PARSED from the endpoint rather than
 * declared a second time. ai.service owns the endpoint (and therefore the
 * model choice); duplicating the model name here would let the recorded
 * version and the model actually billed silently disagree after an
 * ai.service upgrade — the exact attribution failure version recording
 * exists to prevent.
 */
export const VISION_MODEL: string | null = /\/models\/([^:/]+):/.exec(GEMINI_ENDPOINT)?.[1] ?? null;

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

export interface VisionReceiptItem {
  name: string;
  quantity: number | null;
  amount: number;
  /** Which photographed page the model says the line is on. 1-indexed, null when it did not say. */
  pageNumber: number | null;
  /** The visible printed text the model transcribed the line from, or null. */
  sourceText: string | null;
}

/** A warning the model itself raised — unreadable field, ambiguous date. Codes from the shared union. */
export interface VisionWarning {
  code: ReceiptWarningCode;
  field?: string;
  detail?: string;
}

export interface VisionReceipt {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  items: VisionReceiptItem[];
  warnings: VisionWarning[];
}

/**
 * The extraction prompt (PROMPT_VERSION).
 *
 * Every rule below points at the same thing: make the model's failure mode
 * "I could not read it" rather than "here is a plausible receipt". The
 * instruction to omit an item whose price is illegible is the load-bearing
 * one — a missing row costs the owner some typing, an invented row puts
 * money in their accounts that they never spent. v2 adds per-line evidence
 * (page number + the visible text transcribed), machine-readable warnings,
 * and explicit ambiguous-date flagging, so the model's answer arrives with
 * the same accountability the deterministic parser now records.
 */
const PROMPT = `You are a senior document-extraction specialist for Philippine retail receipts
and invoices, reading a photograph of one receipt. You may be given more than
one image — if so, they are PAGES OF THE SAME RECEIPT, in order (a receipt too
long for one photograph). Read them as one continuous document: items may
appear on any page, and the total is usually on the last one.

Perform EXACT TRANSCRIPTION, not interpretation. Treat every financial value
as untrusted until visibly supported by the document. Return only JSON valid
against the response schema:
{"date": "YYYY-MM-DD" or null,
 "vendor": "the shop's name" or null,
 "total": the final total as a number, or null,
 "items": [{"name": "...", "quantity": number or null, "amount": number,
            "pageNumber": which image (1-based) the line is printed on, or null,
            "sourceText": the visible printed text you transcribed the line from, or null}],
 "warnings": [{"code": one of UNREADABLE_FIELD | AMBIGUOUS_DATE,
               "field": which field ("date","vendor","total","items"), "detail": the visible text or what was unreadable}]}

RULES — these matter more than completeness:
- Transcribe ONLY what is actually printed and legible. Never guess, complete,
  correct or infer missing text, quantities, dates, vendors, prices, taxes,
  discounts, or totals. If a value is unreadable or the evidence conflicts,
  return null for it AND add a warning {"code":"UNREADABLE_FIELD","field":...}.
- If you cannot read an item's printed price, LEAVE THE ITEM OUT entirely. A
  missing item is a minor problem; an invented one puts money in someone's
  accounts that they never spent.
- For each item, report pageNumber (which image it is printed on) and
  sourceText (the visible line you transcribed). Do not invent either; use
  null when unsure.
- "items" means things purchased. Do NOT include subtotal, VAT or tax lines,
  discount, change, tender/payment, loyalty, register or BIR metadata lines.
- "total" is the final amount payable, not the subtotal.
- If more than one page shows a total, they are the SAME receipt's total
  repeated (a running total, or the same figure reprinted) — report it once,
  not summed.
- Numeric dates are DAY/MONTH/YEAR (Philippine convention): 11/07/2026 is
  11 July 2026. When BOTH components could be a month (e.g. 05/03/2026),
  still apply DAY/MONTH but ALSO add a warning
  {"code":"AMBIGUOUS_DATE","field":"date","detail":"<the visible text, e.g. 05/03/2026>"} —
  preserve the visible text and flag the ambiguity rather than hiding it.
- Ignore BIR permit, PTU, accreditation and "valid until" dates — they are not
  the transaction date.
- Return an empty items array if no individual items are legible.`;

/**
 * Provider-enforced response schema (SCHEMA_VERSION), in Gemini's JSON-Schema
 * subset. Belt AND braces with the Zod validation below, deliberately: the
 * provider constraint stops the model emitting a wrong shape at generation
 * time, and the Zod pass re-checks the answer as hostile input anyway,
 * because a transport-level promise from a third party is not something the
 * owner's books get to depend on.
 */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    date: { type: "STRING", nullable: true },
    vendor: { type: "STRING", nullable: true },
    total: { type: "NUMBER", nullable: true },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          quantity: { type: "NUMBER", nullable: true },
          amount: { type: "NUMBER" },
          pageNumber: { type: "INTEGER", nullable: true },
          sourceText: { type: "STRING", nullable: true },
        },
        required: ["name", "amount"],
      },
    },
    warnings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING", enum: [...WARNING_CODES] },
          field: { type: "STRING", nullable: true },
          detail: { type: "STRING", nullable: true },
        },
        required: ["code"],
      },
    },
  },
  required: ["date", "vendor", "total", "items"],
} as const;

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Why a model answer was rejected — recorded per scan so rejection rates are attributable. */
export type VisionRejectReason = "parse" | "schema" | "empty";

export type VisionValidation =
  | { ok: true; receipt: VisionReceipt }
  | { ok: false; reason: VisionRejectReason };

/**
 * The Zod boundary. Field-level leniency is DELIBERATE and preserved from the
 * hand-rolled validator this replaces: a single unreadable item or a garbled
 * date must cost that value, not the whole rescue — so leaves coerce or drop
 * to null/[] rather than failing the parse. Only the ENVELOPE is strict
 * (a JSON object, not an array of several, not a scalar), because an
 * ambiguous envelope means there is no single receipt to read at all.
 */
const visionItemsSchema = z.unknown().transform((value): VisionReceiptItem[] => {
  const items: VisionReceiptItem[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const amount = finiteNumber(r.amount);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    // A line with no name or no positive price cannot be booked or checked
    // against the photo, so it is dropped rather than stored as a mystery.
    if (!name || amount === null || amount <= 0) continue;
    const quantity = finiteNumber(r.quantity);
    const pageNumber = finiteNumber(r.pageNumber);
    items.push({
      name: name.slice(0, 255),
      quantity: quantity !== null && quantity > 0 ? quantity : null,
      amount,
      // Only a plausible 1-indexed integer page; anything else is "did not say".
      pageNumber: pageNumber !== null && Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null,
      sourceText: typeof r.sourceText === "string" && r.sourceText.trim() ? r.sourceText.trim().slice(0, 500) : null,
    });
  }
  return items;
});

const visionWarningsSchema = z.unknown().transform((value): VisionWarning[] => {
  const warnings: VisionWarning[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, 20) : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    // An unknown code is dropped, not passed through: the union is the
    // contract the clients render from, and a model-invented code would be
    // an unrenderable sentence.
    if (!isReceiptWarningCode(r.code)) continue;
    warnings.push({
      code: r.code,
      ...(typeof r.field === "string" && r.field.trim() ? { field: r.field.trim().slice(0, 50) } : {}),
      ...(typeof r.detail === "string" && r.detail.trim() ? { detail: r.detail.trim().slice(0, 500) } : {}),
    });
  }
  return warnings;
});

const visionReceiptSchema = z
  .object({
    date: z.unknown().optional(),
    vendor: z.unknown().optional(),
    total: z.unknown().optional(),
    items: visionItemsSchema.optional(),
    warnings: visionWarningsSchema.optional(),
  })
  .transform((o): VisionReceipt => {
    const amount = finiteNumber(o.total);
    return {
      // Only a real calendar-shaped date. The deterministic parser guards this
      // heavily because an impossible date fails the whole upload at Prisma.
      date:
        typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && !Number.isNaN(Date.parse(o.date))
          ? o.date
          : null,
      vendor: typeof o.vendor === "string" && o.vendor.trim() ? o.vendor.trim().slice(0, 150) : null,
      amount: amount !== null && amount > 0 ? amount : null,
      items: o.items ?? [],
      warnings: o.warnings ?? [],
    };
  });

/**
 * Turns whatever came back into the shape the rest of the pipeline expects,
 * discarding anything that does not survive checking — and now SAYING WHY a
 * whole answer was refused, so the scan can record its rejection reason
 * instead of a rejected rescue looking identical to an unreachable provider.
 *
 * The single-element array unwrap is not defensive padding, it was MEASURED:
 * at temperature 0 the identical prompt and image returned a bare object on
 * one run and that same object wrapped in an array on the next. The reading
 * was correct both times; only the envelope moved. A model whose output shape
 * varies between identical calls has to be treated as untrusted input, which
 * is the same discipline validateItemCategories already applies to the
 * categoriser's answers.
 */
export function validateVisionReceipt(raw: string): VisionValidation {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!stripped) return { ok: false, reason: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: "parse" };
  }

  const unwrapped = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  const result = visionReceiptSchema.safeParse(unwrapped);
  return result.success ? { ok: true, receipt: result.data } : { ok: false, reason: "schema" };
}

/** One photographed page, as the vision call needs it. */
export interface VisionPage {
  buffer: Buffer;
  mimetype: string;
}

/**
 * What a vision call produced. Three states, and the distinction is what the
 * per-scan version record needs:
 *   - null (from the function below):   the provider was never usefully
 *     reached — no key, network failure, timeout, HTTP error;
 *   - { receipt: null, rejectReason }:  the provider ANSWERED and the answer
 *     was refused at the validation boundary;
 *   - { receipt, rejectReason: null }:  an accepted reading.
 */
export interface VisionExtraction {
  receipt: VisionReceipt | null;
  rejectReason: VisionRejectReason | null;
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
 * Returns null rather than throwing on every UNREACHABLE-provider path — no
 * key, provider down, timeout. This is a last-ditch attempt to rescue a scan
 * that already failed to parse; it must never be the reason an upload is
 * lost, which is the same promise the categoriser makes. An answer that
 * arrived but failed validation returns { receipt: null, rejectReason }
 * instead, so the caller can record WHY the rescue bought nothing.
 */
export async function extractReceiptWithVision(pages: VisionPage[]): Promise<VisionExtraction | null> {
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
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4000,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
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
    if (!text) return { receipt: null, rejectReason: "empty" };

    const validated = validateVisionReceipt(text);
    return validated.ok ? { receipt: validated.receipt, rejectReason: null } : { receipt: null, rejectReason: validated.reason };
  } catch (err) {
    logger.error({ err }, "Vision receipt read failed");
    return null;
  }
}

// ============================================================
// Verifier — a second opinion that may only say yes or no
// ============================================================

/** The verifier's whole vocabulary. It accepts, or it rejects named fields. It never rewrites a value. */
export interface VisionVerifierVerdict {
  accept: boolean;
  rejectedFields: string[];
}

const VERIFIER_FIELDS = ["date", "vendor", "amount", "items"] as const;

const VERIFIER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    accept: { type: "BOOLEAN" },
    rejectedFields: { type: "ARRAY", items: { type: "STRING", enum: [...VERIFIER_FIELDS] } },
  },
  required: ["accept"],
} as const;

const verifierSchema = z
  .object({ accept: z.unknown(), rejectedFields: z.unknown().optional() })
  .transform((o): VisionVerifierVerdict | null => {
    if (typeof o.accept !== "boolean") return null;
    const rejectedFields = (Array.isArray(o.rejectedFields) ? o.rejectedFields : []).filter(
      (f): f is string => typeof f === "string" && (VERIFIER_FIELDS as readonly string[]).includes(f),
    );
    return { accept: o.accept, rejectedFields };
  });

/**
 * One accept/reject pass over a HIGH-RISK vision result, against the same
 * page images.
 *
 * WHY THIS IS NOT A SECOND EXTRACTION. A verifier that may rewrite values is
 * just a second extractor whose disagreements need a third opinion. This one
 * is structurally incapable of putting a number in the owner's books: its
 * entire response schema is a boolean and a list of field names, so the worst
 * it can do is send the scan back to the deterministic result — which is the
 * state the rescue started from.
 *
 * Returns null when it cannot run or cannot be understood (no key, provider
 * down, malformed verdict). The caller treats null as "no verdict" and keeps
 * the vision result, because the verifier is an ADDED check on a path that
 * previously shipped unverified — its unavailability must not regress the
 * rescue into never working.
 */
export async function verifyVisionReceipt(
  pages: VisionPage[],
  candidate: { date: string | null; vendor: string | null; amount: number | null; items: { name: string; amount: number }[] },
): Promise<VisionVerifierVerdict | null> {
  if (!env.GOOGLE_GEMINI_API_KEY) return null;
  if (pages.length === 0) return null;

  const prompt = `You are verifying a proposed extraction against the attached photograph(s) of ONE receipt (pages in order).

Proposed extraction:
${JSON.stringify({ date: candidate.date, vendor: candidate.vendor, total: candidate.amount, items: candidate.items.map((i) => ({ name: i.name, amount: i.amount })) })}

Your ONLY job is to accept or reject. You must NOT rewrite, correct or supply values.
Return JSON: {"accept": true} when every proposed value is visibly supported by the document,
or {"accept": false, "rejectedFields": [...]} naming each unsupported field ("date","vendor","amount","items").
Reject a field when its value is not legibly printed on the receipt, contradicts what is printed, or cannot be checked because the region is unreadable.
A null proposed value needs no support — do not reject a field for being null.`;

  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              ...pages.map((p) => ({ inlineData: { mimeType: p.mimetype, data: p.buffer.toString("base64") } })),
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 500,
          responseMimeType: "application/json",
          responseSchema: VERIFIER_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.error(`Vision verifier failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim());
    } catch {
      return null;
    }
    const result = verifierSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (err) {
    logger.error({ err }, "Vision verifier failed");
    return null;
  }
}
