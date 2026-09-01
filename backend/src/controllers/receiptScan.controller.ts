import type { Request, Response } from "express";
import { z } from "zod";
import * as receiptScanService from "../services/receiptScan.service";
import { assessImageQuality } from "../lib/imageQuality";
import { detectReceiptCorners } from "../lib/edgeDetection";
import { assessReceiptLikelihood } from "../lib/receiptLikelihood";
import { ApiError } from "../middleware/error.middleware";

const uploadSchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  captureMetadata: z.string().max(50_000).optional(),
});

const pointSchema = z.object({ x: z.number().min(0).max(50_000), y: z.number().min(0).max(50_000) });
const captureMetadataSchema = z.array(
  z.object({
    source: z.enum(["manual-camera", "native-document-scanner", "gallery"]).optional(),
    processingMode: z.enum(["original", "manual-crop", "native-selected", "clear-colour", "grayscale", "black-white"]).optional(),
    originalWidth: z.number().int().positive().max(50_000).optional(),
    originalHeight: z.number().int().positive().max(50_000).optional(),
    processedWidth: z.number().int().positive().max(50_000).optional(),
    processedHeight: z.number().int().positive().max(50_000).optional(),
    corners: z.object({
      topLeft: pointSchema,
      topRight: pointSchema,
      bottomRight: pointSchema,
      bottomLeft: pointSchema,
    }).optional(),
    transformVersion: z.string().min(1).max(80).optional(),
    documentConfidence: z.number().min(0).max(1).optional(),
    ownerOverrodeLikelihood: z.boolean().optional(),
  }).strict(),
).max(receiptScanService.MAX_PAGES);

function parseCaptureMetadata(raw: string | undefined, pageCount: number) {
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Receipt capture metadata must be valid JSON");
  }
  const metadata = captureMetadataSchema.parse(decoded);
  if (metadata.length !== pageCount) {
    throw new ApiError(400, "Receipt capture metadata must have one entry per page");
  }
  for (const page of metadata) {
    if (!page.corners || !page.originalWidth || !page.originalHeight) continue;
    const points = Object.values(page.corners);
    if (points.some((point) => point.x > page.originalWidth! || point.y > page.originalHeight!)) {
      throw new ApiError(400, "Receipt crop corners must stay inside the original image");
    }
  }
  return metadata;
}

/**
 * Exported so the contract tests can check real client payloads against the
 * real schema rather than a copy of it.
 *
 * This endpoint has already broken a client silently once: mobile posted a
 * `categoryId` long after this schema stopped accepting one, and because zod
 * strips unknown keys instead of rejecting them, the field vanished without
 * an error and every mobile receipt confirmation failed. A copy of the schema
 * in a test would have drifted the same way the client did.
 */
export const confirmSchema = z.object({
  date: z.string().date(),
  description: z.string().min(1).max(255),
  vendor: z.string().max(150).optional(),
  amount: z.number().positive(),
  // Either shape is accepted, and the service requires that one of them
  // resolves to at least one category. `splits` is the manual path (a
  // single-category receipt is just a split of one); `itemAssignments` is
  // the itemised path, where the server does the grouping itself.
  splits: z
    .array(
      z.object({
        categoryId: z.number().int().positive(),
        amount: z.number().positive(),
        description: z.string().min(1).max(255).optional(),
      }),
    )
    .optional(),
  itemAssignments: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        categoryId: z.number().int().positive(),
      }),
    )
    .optional(),
  // Lines the owner typed in because OCR missed them. Same field constraints
  // as an extracted item, since they end up in the same table.
  additionalItems: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        amount: z.number().positive(),
        categoryId: z.number().int().positive(),
      }),
    )
    .optional(),
  // How to account for any difference between the items and the confirmed
  // total. A discriminated union so "category" cannot arrive without the
  // category it needs, and the other modes cannot smuggle one in.
  reconciliation: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("proportional") }),
      z.object({ mode: z.literal("category"), categoryId: z.number().int().positive() }),
      z.object({ mode: z.literal("none") }),
    ])
    .optional(),
})
  /*
   * Unknown keys are REJECTED here, not quietly dropped.
   *
   * Zod's default is to strip them, and that default is what turned a small
   * client mistake into a mystery: mobile kept sending `categoryId` after this
   * endpoint moved to splits, the field was silently discarded, and the owner
   * saw "Assign the receipt to at least one category" on a screen where they
   * had very obviously assigned one. The real fault — a field the server no
   * longer understood — was never mentioned to anyone.
   *
   * Refusing costs nothing when a client is correct, and when one is wrong it
   * names the offending key instead of failing somewhere unrelated. Both
   * clients are checked against this in tests/contract/clientPayloads.test.ts.
   */
  .strict();

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid receipt scan id");
  }
  return id;
}

function parseItemId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid receipt scan item id");
  }
  return id;
}

export async function upload(req: Request, res: Response) {
  // multer's .array() always sets req.files to an array (possibly empty),
  // never to req.file — checking both is what lets this controller serve
  // both the field name older clients might still send and the current one.
  const grouped = !Array.isArray(req.files) && req.files ? req.files as Record<string, Express.Multer.File[]> : null;
  const files = Array.isArray(req.files) ? req.files : grouped?.files ?? (req.file ? [req.file] : []);
  const originals = grouped?.originalFiles ?? [];
  if (files.length === 0) {
    throw new ApiError(400, "At least one receipt photo is required");
  }
  const { businessProfileId, captureMetadata } = uploadSchema.parse(req.body);
  if (originals.length > 0 && originals.length !== files.length) {
    throw new ApiError(400, "Original and processed receipt page counts must match");
  }
  const metadata = parseCaptureMetadata(captureMetadata, files.length);

  const scan = await receiptScanService.uploadAndScan(req.user!.id, {
    businessProfileId,
    pages: files.map((file, index) => {
      const original = originals[index];
      return {
        buffer: original?.buffer ?? file.buffer,
        mimetype: original?.mimetype ?? file.mimetype,
        originalname: original?.originalname ?? file.originalname,
        ...(original ? { processed: { buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname } } : {}),
        ...(metadata[index] ? { metadata: metadata[index] } : {}),
      };
    }),
  });

  /*
   * 202, not 201: the photographs have been accepted and a scan exists, but
   * reading them is still in progress. The client polls `show` below until
   * processingStatus leaves "Processing". The body is the same DTO shape the
   * finished scan will have — the extracted fields are simply still null — so
   * a client can render from one type throughout rather than switching shapes
   * halfway through.
   */
  res.status(202).json(scan);
}

/** One scan as it currently stands — what the client polls after uploading. */
export async function show(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const scan = await receiptScanService.getScan(req.user!.id, id);
  res.json(scan);
}

export async function retry(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const scan = await receiptScanService.retryScan(req.user!.id, id);
  res.status(202).json(scan);
}

/**
 * A single page's own readability, with none of the rest of the pipeline —
 * no OCR, no vision call, no storage write, no database row.
 *
 * WHY THIS EXISTS SEPARATELY FROM `upload`. A capture session takes its
 * photos one at a time, and a blurry page is far cheaper to catch while the
 * camera is still open than after the whole set has been OCR'd — retaking
 * costs a tap; discovering it later costs an OCR pass, a possible vision
 * call, and a wrong set of figures the owner has to notice and undo. This
 * gives the client that answer after every shutter press, not only once at
 * the end.
 */
export async function checkQuality(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "A photo is required");
  }
  const quality = await assessImageQuality(req.file.buffer);
  res.status(200).json(quality);
}

/**
 * Where the receipt appears to be in a photograph, as four corners.
 *
 * SAME SHAPE AS `checkQuality` AND FOR THE SAME REASONS: no OCR, no vision
 * call, no Storage write, no database row. It answers a question the capture
 * screen asks on every shutter press, and it only ever PROPOSES — the corners
 * become the starting position of handles the owner drags, and the crop is
 * not applied until they say so.
 *
 * WHY THE SERVER DOES THIS AT ALL. Detecting edges on the phone needs a
 * native module, and none of the candidates exists in Expo Go; adopting one
 * means a development-build migration, the same cost that ruled out on-device
 * OCR. `sharp` is already loaded in this process and the phone is already
 * posting this exact image to `checkQuality` on the same press.
 *
 * 200 with `corners: null` rather than a 404 or an error when nothing is
 * found. Finding no receipt is a perfectly ordinary answer — a dark counter,
 * a white table, a hand across the frame — and the client's behaviour is
 * identical either way: open the crop editor on default handles.
 */
export async function detectEdges(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "A photo is required");
  }
  const result = await detectReceiptCorners(req.file.buffer);
  res.status(200).json({
    ...result,
    likelihood: assessReceiptLikelihood({
      documentConfidence: result.confidence,
      candidates: result.candidates,
    }),
  });
}

/**
 * Returns the scan as it now stands rather than 204, so the review screen
 * re-renders from the server's list instead of its own optimistic copy.
 */
export async function deleteItem(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const itemId = parseItemId(req.params.itemId!);
  const scan = await receiptScanService.deleteScanItem(req.user!.id, id, itemId);
  res.json(scan);
}

export async function confirm(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const input = confirmSchema.parse(req.body);
  const records = await receiptScanService.confirmReceipt(req.user!.id, id, input);
  res.status(201).json(records);
}
