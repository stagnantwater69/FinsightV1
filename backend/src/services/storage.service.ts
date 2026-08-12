import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../config/supabase";
import { env } from "../config/env";
import { ApiError } from "../middleware/error.middleware";
import { logger } from "../config/logger";

// [ADDED] Not provisioned by the Supabase connection step (which only
// created "receipts") — CSVImportBatch.fileReference is NOT NULL in the
// data dictionary, so a real stored reference is needed, not a fake one.
const CSV_IMPORT_BUCKET = "csv-imports";

// Public, unlike receipts/csv-imports — a profile photo or business logo is
// rendered directly as an <img src>, so the URL has to work with no auth
// header attached. Neither bucket holds anything sensitive enough to need
// the signed-URL indirection the private buckets require.
const AVATAR_BUCKET = "avatars";

// One retry, for genuinely transient Storage failures (network blips, 5xx).
//
// HISTORICAL NOTE: this retry was originally added to paper over a
// "mysterious intermittent RLS 403 under concurrent load". That diagnosis
// was wrong. The real cause was that auth.service called
// signInWithPassword on the shared supabaseAdmin client, which left the
// signed-in user's `authenticated`-role session on it, so every later
// upload authenticated as that user instead of as service_role. It only
// looked intermittent because it depended on whether a login had happened
// in the process yet — and no number of retries could ever fix it, since
// the client stayed contaminated until restart. Fixed at the source in
// config/supabase.ts (createPasswordAuthClient). The retry stays because
// it's still reasonable for real transients, but it is no longer load-
// bearing: an RLS 403 here now means something is genuinely misconfigured
// and should be investigated, not retried away.
async function uploadWithRetry(bucket: string, path: string, buffer: Buffer, contentType: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { error } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, { contentType });
    if (!error) return;

    const status = (error as { status?: number }).status;
    const statusCode = (error as { statusCode?: string }).statusCode;
    logger.error(`Storage upload failed (attempt ${attempt}/2): ${error.message} [status=${status} statusCode=${statusCode}]`);

    if (attempt === 2) {
      throw new ApiError(502, `Could not upload file to storage: ${error.message}`);
    }
  }
}

export async function uploadReceiptImage(businessProfileId: number, buffer: Buffer, mimetype: string, originalname: string) {
  const ext = originalname.includes(".") ? originalname.split(".").pop() : mimetype.split("/")[1];
  const path = `${businessProfileId}/${randomUUID()}.${ext}`;
  await uploadWithRetry(env.SUPABASE_STORAGE_BUCKET, path, buffer, mimetype);
  return path;
}

/**
 * How long a receipt image link stays valid. Long enough to open a record,
 * read the receipt and think about it; short enough that a URL copied out of
 * devtools or a shared screenshot stops working well before it could be
 * passed around. The receipts bucket is private precisely so these links are
 * the only way in.
 */
const RECEIPT_URL_TTL_SECONDS = 10 * 60;

/**
 * A temporary link to a stored receipt image.
 *
 * Returns null rather than throwing when the link can't be minted — a record
 * whose thumbnail is missing should still open and still be editable. Losing
 * the picture is a degraded page; a 500 here would be a page the owner cannot
 * use at all, over an image.
 */
export async function signedReceiptImageUrl(path: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(path, RECEIPT_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    logger.error(`Could not sign receipt image URL for "${path}": ${error?.message ?? "no URL returned"}`);
    return null;
  }
  return data.signedUrl;
}

/**
 * Downloads a private receipt image for durable background processing.
 * Unlike the UI's signed URL this is service-to-service and returns the real
 * bytes; a missing object is a failed job, not an empty OCR result.
 */
export async function downloadReceiptImage(path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(env.SUPABASE_STORAGE_BUCKET).download(path);
  if (error || !data) {
    throw new ApiError(502, `Could not download receipt image: ${error?.message ?? "no data returned"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * How long a link to an imported CSV stays valid.
 *
 * The same reasoning as RECEIPT_URL_TTL_SECONDS, and deliberately the same
 * number: an imported spreadsheet holds the owner's actual figures, so the
 * csv-imports bucket is private for exactly the reason the receipts one is,
 * and a link that leaks out of devtools should stop working just as quickly.
 */
const CSV_URL_TTL_SECONDS = 10 * 60;

/**
 * Recovers the name the owner's file had before it was stored.
 *
 * uploadCsvFile writes `<profileId>/<uuid>-<originalname>`, so the original is
 * whatever follows the UUID. Worth undoing rather than serving the stored path
 * as-is: a file that lands in the owner's Downloads folder as
 * "9f2e1c40-...-expenses.csv" is one they cannot recognise a month later,
 * which defeats the point of offering it.
 *
 * Falls back to the stored basename when the path is not the shape uploadCsvFile
 * writes — an ugly but honest name beats a confidently wrong one.
 */
function originalCsvName(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const withoutUuid = basename.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
    "",
  );
  return withoutUuid || basename;
}

/**
 * A temporary link that downloads the file a CSV import came from.
 *
 * `download` rather than an inline view, unlike a receipt photo: a browser
 * renders a spreadsheet as a wall of commas, and the place an owner can
 * actually compare a row against the record it became is their own
 * spreadsheet program.
 *
 * Returns null rather than throwing, exactly as signedReceiptImageUrl does. A
 * record whose source file has since been swept (see lib/sourceCleanup) must
 * still open and still be editable — losing the link is a degraded panel, and
 * a 500 here would be an unusable page over a file the owner may not even want.
 */
export async function signedCsvFileUrl(path: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(CSV_IMPORT_BUCKET)
    .createSignedUrl(path, CSV_URL_TTL_SECONDS, { download: originalCsvName(path) });

  if (error || !data?.signedUrl) {
    logger.error(`Could not sign CSV file URL for "${path}": ${error?.message ?? "no URL returned"}`);
    return null;
  }
  return data.signedUrl;
}

/**
 * Removes a stored object, and never fails the caller if it cannot.
 *
 * Deletion is always the SECOND half of an operation whose first half has
 * already succeeded — the database row is gone by the time this runs. If
 * Storage is briefly unreachable, the right outcome is an orphaned file and a
 * logged warning, not an error thrown at an owner whose record was in fact
 * deleted exactly as they asked. An orphan can be swept later; a 500 on a
 * successful delete cannot be taken back.
 *
 * Returns whether the object is gone, so a caller that wants to report or
 * count failures can.
 */
async function removeObject(bucket: string, path: string): Promise<boolean> {
  const { error } = await supabaseAdmin.storage.from(bucket).remove([path]);
  if (error) {
    logger.error(`Could not delete "${path}" from ${bucket}: ${error.message}`);
    return false;
  }
  return true;
}

/** Deletes a receipt image. Safe to call for a path that is already gone. */
export async function deleteReceiptImage(path: string): Promise<boolean> {
  return removeObject(env.SUPABASE_STORAGE_BUCKET, path);
}

/** Deletes an uploaded CSV. Safe to call for a path that is already gone. */
export async function deleteCsvFile(path: string): Promise<boolean> {
  return removeObject(CSV_IMPORT_BUCKET, path);
}

/** Removes an avatar/logo from its persisted public URL, including cache-bust query strings. */
export async function deletePublicImageUrl(url: string): Promise<boolean> {
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const markerAt = url.indexOf(marker);
  if (markerAt === -1) return true;
  const encodedPath = url.slice(markerAt + marker.length).split("?")[0]!;
  try {
    return removeObject(AVATAR_BUCKET, decodeURIComponent(encodedPath));
  } catch {
    return false;
  }
}

/**
 * Fetches an imported CSV's own bytes back out of storage, for previewing it
 * as a table rather than only offering it as a download.
 *
 * Returns null on any failure — no object at that path, bucket unreachable —
 * for the same reason signedCsvFileUrl does: the panel this feeds must
 * degrade to "no preview available", never take the record's edit page down
 * with it.
 */
export async function downloadCsvFile(path: string): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin.storage.from(CSV_IMPORT_BUCKET).download(path);
  if (error || !data) {
    logger.error(`Could not download CSV file "${path}": ${error?.message ?? "no data returned"}`);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Reduces a client-supplied filename to something safe to embed in a storage
 * key, while keeping it recognisable to the owner.
 *
 * WHY SANITISE RATHER THAN DROP. uploadReceiptImage and uploadPublicImage
 * both discard the original name entirely and keep only the extension, which
 * is the simplest safe thing. This one cannot: signedCsvFileUrl reads the
 * name back out of the key (see originalCsvName) to name the download, so an
 * owner opening their Downloads folder a month later sees "expenses.csv"
 * rather than a bare UUID. The name is load-bearing here, so it has to be
 * made safe rather than thrown away.
 *
 * WHAT IT DEFENDS AGAINST. The name arrives from the client verbatim and was
 * previously interpolated straight into the object key, so a crafted name
 * containing "/" or ".." could steer the written key outside the
 * `<profileId>/` prefix every other object in the bucket lives under. Object
 * stores generally treat keys as opaque strings rather than filesystem paths,
 * which is why this was a latent risk rather than an active break — but the
 * prefix is what makes a key attributable to one business, and nothing should
 * be able to write outside its own.
 *
 * An ALLOWLIST, not a list of bad characters to remove: anything outside
 * [A-Za-z0-9._-] becomes an underscore, which covers path separators,
 * control characters, quotes and unicode lookalikes in one rule rather than
 * as a list of individually-remembered cases. Leading dots are stripped
 * separately, so a name cannot begin ".." even though dots are otherwise
 * allowed.
 *
 * The UUID already guarantees uniqueness, so two different names collapsing
 * to the same sanitised string is harmless. The length cap keeps the whole
 * key inside VARCHAR(255) with room for the profile id and UUID prefix, and
 * the fallback covers a name that sanitises away to nothing at all.
 */
export function safeStoredFileName(originalname: string): string {
  const basename = originalname.split(/[/\\]/).pop() ?? "";
  const cleaned = basename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned || "upload.csv";
}

export async function uploadCsvFile(businessProfileId: number, buffer: Buffer, originalname: string) {
  const path = `${businessProfileId}/${randomUUID()}-${safeStoredFileName(originalname)}`;
  await uploadWithRetry(CSV_IMPORT_BUCKET, path, buffer, "text/csv");
  return path;
}

// `upsert: true` because a re-uploaded photo reuses the same path (see the
// callers below) — old avatars/logos are meant to be replaced, not
// accumulated forever under a new random name each time.
async function uploadPublicImage(prefix: string, buffer: Buffer, mimetype: string, originalname: string) {
  const ext = originalname.includes(".") ? originalname.split(".").pop() : mimetype.split("/")[1];
  const path = `${prefix}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .upload(path, buffer, { contentType: mimetype, upsert: true });
  if (error) {
    throw new ApiError(502, `Could not upload image to storage: ${error.message}`);
  }
  const { data } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  // Cache-bust: the path (and therefore the URL) is stable across re-uploads,
  // so without this the browser and CDN would keep serving the old cached
  // image after a photo change.
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function uploadUserAvatar(userId: number, buffer: Buffer, mimetype: string, originalname: string) {
  return uploadPublicImage(`users/${userId}`, buffer, mimetype, originalname);
}

export async function uploadBusinessLogo(businessProfileId: number, buffer: Buffer, mimetype: string, originalname: string) {
  return uploadPublicImage(`businesses/${businessProfileId}`, buffer, mimetype, originalname);
}
