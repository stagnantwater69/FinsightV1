import { z } from "zod";

/**
 * The local read's headline fields, shown while the provider is still reading.
 *
 * Local OCR finishes seconds before the provider does, and until now the owner
 * saw nothing until both had. This lets the review screen show what the
 * photograph already gave up, marked as early and liable to change.
 *
 * Display only. It is stored inside `extractorVersions`, which the final
 * persist replaces wholesale, so it disappears when the scan completes or
 * fails, and the API returns it only while the scan is still processing.
 * Confirmation still waits for the finished read, so nothing here can reach
 * the books. Nor does it claim anything: no evidence, no validation.
 */
export const localPreviewSchema = z.object({
  date: z.string().date().nullable(),
  vendor: z.string().max(255).nullable(),
  amount: z.number().finite().nullable(),
});

export type ReceiptLocalPreview = z.infer<typeof localPreviewSchema>;

export const LOCAL_PREVIEW_KEY = "localPreview";

/** The preview a stored `extractorVersions` carries, or null if it has none (or a malformed one). */
export function readLocalPreview(extractorVersions: unknown): ReceiptLocalPreview | null {
  if (!extractorVersions || typeof extractorVersions !== "object") return null;
  const parsed = localPreviewSchema.safeParse((extractorVersions as Record<string, unknown>)[LOCAL_PREVIEW_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Null unless the local read found a date or a total. The vendor is only the
 * parser's guess at a header line, so on its own it is not worth showing: an
 * unreadable photo's first line of noise would appear as the store's name.
 */
export function localPreviewFrom(fields: { date: string | null; vendor: string | null; amount: number | null }): ReceiptLocalPreview | null {
  if (fields.date === null && fields.amount === null) return null;
  return { date: fields.date, vendor: fields.vendor?.slice(0, 255) ?? null, amount: fields.amount };
}
