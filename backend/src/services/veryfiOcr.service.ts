import { env } from "../config/env";
import { logger } from "../config/logger";

/**
 * Reading a receipt photograph with Veryfi's receipt-OCR API — a production
 * rescue, gated by `VERYFI_ENABLED` and a monthly quota (see
 * `receiptScan/veryfiQuota.ts`), for the receipts the deterministic parser
 * cannot read at all.
 *
 * WHY THIS EXISTS ALONGSIDE `visionOcr.service.ts`, NOT INSTEAD OF IT. Veryfi
 * is a receipt-specialised extraction API, not a general vision model —
 * measured directly against this app's own OCR corpus and, during this
 * session, against a real customer receipt tesseract could not read at any
 * confidence (see `tests/ocr-accuracy/VERYFI-SPIKE-REPORT.md` and
 * `docs/superpowers/specs/2026-09-01-veryfi-production-ocr-integration-design.md`).
 * It is tried FIRST among rescues, precisely because it reads harder receipts
 * than Gemini's vision rescue does on the evidence gathered so far — but it is
 * a paid, quota-limited third party, so `extractReceiptWithVision` (Gemini)
 * remains the fallback once Veryfi is disabled, exhausted, or unreachable.
 *
 * Same "never throws" contract as `extractReceiptWithVision`: returns `null`
 * when Veryfi was never usefully reached (no credentials, network failure,
 * timeout), so the caller can fall through to the Gemini rescue exactly as if
 * this function did not exist.
 */

const ENDPOINT = "https://api.veryfi.com/api/v8/partner/documents";
const TIMEOUT_MS = 20_000;
const MAX_ITEMS = 100;

export interface VeryfiPage {
  buffer: Buffer;
  mimetype: string;
}

export interface VeryfiReceiptItem {
  name: string;
  quantity: number | null;
  amount: number;
}

export interface VeryfiReceipt {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  items: VeryfiReceiptItem[];
}

/** Why an answered rescue was thrown away — recorded per scan, same spirit as `VisionRejectReason`. */
export type VeryfiRejectReason = "http" | "empty";

/**
 * Same three-state contract as `VisionExtraction`:
 *   - null (from the function below): the provider was never usefully
 *     reached — no credentials, network failure, timeout;
 *   - { receipt: null, rejectReason }: reached, but no page returned a usable
 *     document;
 *   - { receipt, rejectReason: null }: an accepted reading, possibly merged
 *     from more than one page.
 */
export interface VeryfiExtraction {
  receipt: VeryfiReceipt | null;
  rejectReason: VeryfiRejectReason | null;
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceDate(v: unknown): string | null {
  // Veryfi returns a full timestamp ("2026-07-11 00:00:00"), not the bare
  // YYYY-MM-DD the rest of this pipeline uses — this is Veryfi's own
  // documented response shape, not a guess (see veryfi-spike.ts's `coerce`).
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

function coerceVendor(v: unknown): string | null {
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).name === "string") {
    const name = ((v as Record<string, unknown>).name as string).trim();
    return name ? name.slice(0, 150) : null;
  }
  return null;
}

function coerceItems(v: unknown): VeryfiReceiptItem[] {
  if (!Array.isArray(v)) return [];
  const items: VeryfiReceiptItem[] = [];
  for (const entry of v.slice(0, MAX_ITEMS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const amount = finiteNumber(r.total);
    const name = typeof r.description === "string" ? r.description.trim() : "";
    // No amount or no name cannot be booked or checked against the photo —
    // dropped rather than stored as a mystery, same rule visionOcr.service.ts
    // applies to a model-supplied item.
    if (!name || amount === null || amount <= 0) continue;
    const quantity = finiteNumber(r.quantity);
    items.push({
      name: name.slice(0, 255),
      quantity: quantity !== null && quantity > 0 ? quantity : null,
      amount,
    });
  }
  return items;
}

async function readOnePage(page: VeryfiPage): Promise<{ ok: true; doc: Record<string, unknown> } | { ok: false }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Client-Id": env.VERYFI_CLIENT_ID,
      Authorization: `apikey ${env.VERYFI_USERNAME}:${env.VERYFI_API_KEY}`,
    },
    body: JSON.stringify({
      file_data: page.buffer.toString("base64"),
      file_name: `page.${page.mimetype.split("/")[1] ?? "jpg"}`,
      categories: [],
      boost_mode: 0,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    logger.error(`Veryfi receipt read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { ok: false };
  }
  return { ok: true, doc: (await res.json()) as Record<string, unknown> };
}

/**
 * Reads a receipt with Veryfi — one page, or several pages of one long
 * receipt.
 *
 * Veryfi's document endpoint reads one image per call, unlike Gemini's
 * single multi-part request for every page — so a multi-page receipt costs
 * one Veryfi request PER PAGE. Pages are merged the same way the deterministic
 * parser's own multi-page combination already works: vendor and date from the
 * first page that supplies one, amount from the LAST page that supplies one
 * (the total is conventionally on the final page), and items concatenated
 * across every page in order.
 *
 * A network-level failure (thrown, not an HTTP error response) on ANY page
 * makes the whole call return null — an unreachable provider, not a partial
 * read. An HTTP error response on a page still counts as that page having
 * been reached; if every page comes back that way there is nothing to merge
 * and this returns a `"http"` rejection instead of null.
 */
export async function extractReceiptWithVeryfi(pages: VeryfiPage[]): Promise<VeryfiExtraction | null> {
  if (!env.VERYFI_CLIENT_ID || !env.VERYFI_USERNAME || !env.VERYFI_API_KEY) return null;
  if (pages.length === 0) return null;

  let docs: Record<string, unknown>[];
  try {
    const results = await Promise.all(pages.map(readOnePage));
    docs = results.filter((r): r is { ok: true; doc: Record<string, unknown> } => r.ok).map((r) => r.doc);
  } catch (err) {
    logger.error({ err }, "Veryfi receipt read failed");
    return null;
  }

  if (docs.length === 0) return { receipt: null, rejectReason: "http" };

  const vendor = docs.map((d) => coerceVendor(d.vendor)).find((v) => v !== null) ?? null;
  const date = docs.map((d) => coerceDate(d.date)).find((v) => v !== null) ?? null;
  const amounts = docs.map((d) => finiteNumber(d.total)).filter((v): v is number => v !== null && v > 0);
  const amount = amounts.length > 0 ? amounts[amounts.length - 1]! : null;
  const items = docs.flatMap((d) => coerceItems(d.line_items));

  if (vendor === null && date === null && amount === null && items.length === 0) {
    return { receipt: null, rejectReason: "empty" };
  }
  return { receipt: { vendor, date, amount, items }, rejectReason: null };
}
