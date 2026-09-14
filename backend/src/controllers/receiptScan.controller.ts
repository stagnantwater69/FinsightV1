import type { Request, Response } from "express";
import { z } from "zod";
import * as receiptScanQueue from "../services/receiptScan/queue";
import {
  listReceiptScans,
  RECEIPT_HISTORY_STATUSES,
} from "../services/receiptScan/history";
import { confirmReceipt, deleteScanItem, updateScanItem } from "../services/receiptScan/reconciliation";
import type { ConfirmInput, ReceiptUploadFile } from "../services/receiptScan/types";
import { confirmationModeIssues } from "../services/receiptScan/confirmMode";
import { assessImageQuality } from "../lib/imageQuality";
import { detectReceiptCorners } from "../lib/edgeDetection";
import { assessReceiptLikelihood } from "../lib/receiptLikelihood";
import { ApiError } from "../middleware/error.middleware";
import { transformReceiptPerspective } from "../lib/receiptPerspective";
import { moneyAmountSchema } from "../lib/money";
import {
  inspectReceiptUpload,
  receiptUploadByteLength,
  type ReceiptUploadImageInfo,
  validateReceiptUpload,
} from "../lib/receiptUploadValidation";
import {
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
} from "../lib/receiptUploadContract";
import { cleanupReceiptUploadTemporaryFiles } from "../middleware/upload.middleware";
import {
  requestConfirmedReceiptEvidenceDeletion,
  requestReceiptScanDeletion,
} from "../services/receiptPurge.service";
import { listReceiptDuplicateCandidates } from "../services/receiptDuplicate.service";
import { RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS } from "../services/receiptCaptureBatch.service";

const uploadSchema = z
  .object({
    businessProfileId: z.coerce.number().int().positive(),
    captureMetadata: z.string().max(50_000).optional(),
    idempotencyKey: z.string().min(8).max(100).optional(),
    receiptBatchId: z.coerce.number().int().positive().optional(),
    // A position in a batch, so bounded by the batch size, not by pages per scan.
    receiptOrdinal: z.coerce.number().int().min(1).max(RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS).optional(),
  })
  .superRefine((input, context) => {
    if ((input.receiptBatchId === undefined) !== (input.receiptOrdinal === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Receipt batch id and receipt position must be supplied together",
      });
    }
  });

const pointSchema = z.object({ x: z.number().min(0).max(50_000), y: z.number().min(0).max(50_000) });
const captureMetadataItemSchema = z.object({
  source: z.enum(["manual-camera", "native-document-scanner", "gallery"]).optional(),
  captureMode: z.enum(["standard", "long"]).optional(),
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
}).strict().superRefine((metadata, context) => {
  if ((metadata.originalWidth === undefined) !== (metadata.originalHeight === undefined)) {
    context.addIssue({ code: "custom", message: "Original receipt dimensions require both width and height" });
  }
  if ((metadata.processedWidth === undefined) !== (metadata.processedHeight === undefined)) {
    context.addIssue({ code: "custom", message: "Processed receipt dimensions require both width and height" });
  }
});

const captureMetadataSchema = z.array(captureMetadataItemSchema).max(RECEIPT_UPLOAD_MAX_LOGICAL_PAGES);
type ParsedCaptureMetadata = z.infer<typeof captureMetadataItemSchema>;

function parseCaptureMetadata(raw: string | undefined, pageCount: number) {
  if (!raw) return Array.from({ length: pageCount }, () => ({} as ParsedCaptureMetadata));
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
  return metadata;
}

function dimensionsMatch(
  label: "Original" | "Processed",
  declaredWidth: number | undefined,
  declaredHeight: number | undefined,
  actual: ReceiptUploadImageInfo,
): void {
  if (declaredWidth === undefined || declaredHeight === undefined) return;
  if (declaredWidth !== actual.width || declaredHeight !== actual.height) {
    throw new ApiError(400, `${label} receipt dimensions do not match the uploaded image`);
  }
}

function verifiedCaptureMetadata(
  metadata: ParsedCaptureMetadata,
  source: ReceiptUploadImageInfo,
  derived: ReceiptUploadImageInfo | null,
): ParsedCaptureMetadata {
  dimensionsMatch("Original", metadata.originalWidth, metadata.originalHeight, source);
  dimensionsMatch(
    "Processed",
    metadata.processedWidth,
    metadata.processedHeight,
    derived ?? source,
  );

  if (!derived && metadata.processingMode && metadata.processingMode !== "original") {
    throw new ApiError(400, "A processed receipt page must include its source image");
  }
  if (metadata.corners) {
    const points = Object.values(metadata.corners);
    if (points.some((point) => point.x > source.width || point.y > source.height)) {
      throw new ApiError(400, "Receipt crop corners must stay inside the source image");
    }
  }

  return {
    ...metadata,
    originalWidth: source.width,
    originalHeight: source.height,
    ...(derived ? { processedWidth: derived.width, processedHeight: derived.height } : {}),
  };
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
 *
 * Two modes, decided by which of `splits` and `itemAssignments` is present:
 *
 *   manual    shared + splits
 *   itemised  shared + itemAssignments, optionally additionalItems and
 *             reconciliation
 *
 * The superRefine refuses anything else. Before it, every mode field was
 * independently optional and the service chose the itemised path whenever
 * `itemAssignments` was present, so a body carrying both had its `splits`
 * dropped in silence. The rule lives in receiptScan/confirmMode.ts, where the
 * service applies the same one.
 */
const confirmSharedShape = {
  expectedScanRevision: z.number().int().nonnegative().optional(),
  date: z.string().date(),
  description: z.string().min(1).max(255),
  vendor: z.string().max(150).optional(),
  amount: moneyAmountSchema,
  duplicateDecision: z.object({
    action: z.literal("SAVE_ANYWAY"),
    candidateSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().optional(),
};

// A single-category receipt is a split of one. Empty is left to the service,
// whose refusal names the problem for the owner.
const splitsSchema = z.array(
  z.object({
    categoryId: z.number().int().positive(),
    amount: moneyAmountSchema,
    description: z.string().min(1).max(255).optional(),
  }).strict(),
);

const itemAssignmentsSchema = z.array(
  z.object({
    itemId: z.number().int().positive(),
    categoryId: z.number().int().positive(),
  }).strict(),
);

// Lines the owner typed in because OCR missed them. Same field constraints
// as an extracted item, since they end up in the same table.
const additionalItemsSchema = z.array(
  z.object({
    name: z.string().min(1).max(255),
    amount: moneyAmountSchema,
    categoryId: z.number().int().positive(),
  }).strict(),
);

// How to account for any difference between the items and the confirmed
// total. A discriminated union so "category" cannot arrive without the
// category it needs, and the other modes cannot smuggle one in.
const reconciliationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("proportional") }).strict(),
  z.object({ mode: z.literal("category"), categoryId: z.number().int().positive() }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);

export const confirmSchema = z.object({
  ...confirmSharedShape,
  splits: splitsSchema.optional(),
  itemAssignments: itemAssignmentsSchema.optional(),
  additionalItems: additionalItemsSchema.optional(),
  reconciliation: reconciliationSchema.optional(),
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
   * The nested objects are strict for the same reason: a split carrying
   * `itemIds` names rows directly and must not be accepted and then ignored.
   */
  .strict()
  .superRefine((input, context): input is ConfirmInput => {
    const issues = confirmationModeIssues(input);
    for (const issue of issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    return issues.length === 0;
  });

export const itemUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  amount: moneyAmountSchema,
  expectedScanRevision: z.number().int().nonnegative(),
}).strict();

const receiptHistorySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  status: z.enum(RECEIPT_HISTORY_STATUSES).default("active"),
  cursor: z.string().min(1).max(500).optional(),
  take: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const purgeIdempotencyKeySchema = z.string().trim().min(8).max(100);

const duplicateCandidateQuerySchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  take: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

function parseId(raw: string): number {
  const id = Number(raw);
  // int4 bound: a larger id would reach Prisma and surface as a 500.
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new ApiError(400, "Invalid receipt scan id");
  }
  return id;
}

function parseItemId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new ApiError(400, "Invalid receipt scan item id");
  }
  return id;
}

function parsePageNumber(raw: string): number {
  const pageNumber = Number(raw);
  if (!Number.isInteger(pageNumber) || pageNumber <= 0 || pageNumber > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
    throw new ApiError(400, "Invalid receipt page number");
  }
  return pageNumber;
}

export async function upload(req: Request, res: Response) {
  const scan = await (async () => {
    const grouped = !Array.isArray(req.files) && req.files
      ? req.files as Record<string, Express.Multer.File[]>
      : null;
    const files = Array.isArray(req.files) ? req.files : grouped?.files ?? (req.file ? [req.file] : []);
    const originals = grouped?.originalFiles ?? [];
    if (files.length === 0) throw new ApiError(400, "At least one receipt photo is required");
    if (files.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
      throw new ApiError(400, `A receipt can have at most ${RECEIPT_UPLOAD_MAX_LOGICAL_PAGES} pages`);
    }

    const {
      businessProfileId,
      captureMetadata,
      idempotencyKey,
      receiptBatchId,
      receiptOrdinal,
    } = uploadSchema.parse(req.body);
    if (originals.length > 0 && originals.length !== files.length) {
      throw new ApiError(400, "Original and processed receipt page counts must match");
    }

    const metadata = parseCaptureMetadata(captureMetadata, files.length);
    const uploadedFiles = [...files, ...originals];
    const actualSizes = new Map<Express.Multer.File, number>();
    let aggregateBytes = 0;
    for (const file of uploadedFiles) {
      const size = await receiptUploadByteLength(file);
      actualSizes.set(file, size);
      aggregateBytes += size;
    }
    if (aggregateBytes > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES) {
      throw new ApiError(413, "Receipt upload files must total 80 MiB or less");
    }
    const imageInfo = new Map<Express.Multer.File, ReceiptUploadImageInfo>();
    for (const file of uploadedFiles) imageInfo.set(file, await inspectReceiptUpload(file));

    const queueFile = (file: Express.Multer.File): ReceiptUploadFile => file.path
      ? {
          source: "temporary-file",
          temporaryPath: file.path,
          sizeBytes: actualSizes.get(file)!,
          mimetype: file.mimetype,
          originalname: file.originalname,
        }
      : {
          source: "buffer",
          buffer: file.buffer,
          mimetype: file.mimetype,
          originalname: file.originalname,
        };

    return receiptScanQueue.uploadAndScan(req.user!.id, {
      businessProfileId,
      idempotencyKey,
      receiptBatchId,
      receiptOrdinal,
      pages: files.map((file, index) => {
        const original = originals[index];
        const uploadFile = original ?? file;
        const verifiedMetadata = verifiedCaptureMetadata(
          metadata[index]!,
          imageInfo.get(uploadFile)!,
          original ? imageInfo.get(file)! : null,
        );
        return {
          ...queueFile(uploadFile),
          ...(original ? { processed: queueFile(file) } : {}),
          metadata: verifiedMetadata,
        };
      }),
    });
  })().finally(() => cleanupReceiptUploadTemporaryFiles(req));

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

export async function index(req: Request, res: Response) {
  const input = receiptHistorySchema.parse(req.query);
  res.json(await listReceiptScans(req.user!.id, input));
}

/** One scan as it currently stands — what the client polls after uploading. */
export async function show(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const scan = await receiptScanQueue.getScan(req.user!.id, id);
  res.json(scan);
}

export async function showPageImage(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const pageNumber = parsePageNumber(req.params.pageNumber!);
  const variant = z.enum(["source", "derived"]).parse(req.params.variant);
  const image = await receiptScanQueue.getScanPageImage(req.user!.id, id, pageNumber, variant);
  res.json(image);
}

export async function duplicateCandidates(req: Request, res: Response) {
  const input = duplicateCandidateQuerySchema.parse(req.query);
  const id = parseId(req.params.id!);
  const result = await listReceiptDuplicateCandidates(req.user!.id, id, input);
  // Reviewing duplicates is the owner looking at this scan: a view for the
  // abandoned-scan clock, throttled like the other views.
  await receiptScanQueue.recordScanViewActivity(req.user!.id, id);
  res.json(result);
}

export async function retry(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const scan = await receiptScanQueue.retryScan(req.user!.id, id);
  res.status(202).json(scan);
}

function purgeIdempotencyKey(req: Request): string {
  const key = req.get("Idempotency-Key");
  if (!key) throw new ApiError(400, "Idempotency-Key header is required");
  return purgeIdempotencyKeySchema.parse(key);
}

export async function remove(req: Request, res: Response) {
  const job = await requestReceiptScanDeletion(
    req.user!.id,
    parseId(req.params.id!),
    purgeIdempotencyKey(req),
  );
  res.status(202).json(job);
}

export async function removeImages(req: Request, res: Response) {
  const job = await requestConfirmedReceiptEvidenceDeletion(
    req.user!.id,
    parseId(req.params.id!),
    purgeIdempotencyKey(req),
  );
  res.status(202).json(job);
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
  await validateReceiptUpload(req.file);
  const quality = await assessImageQuality(req.file.buffer);
  res.status(200).json(quality);
}

export async function transform(req: Request, res: Response) {
  if (!req.file) throw new ApiError(400, "A photo is required");
  const raw = z.string().max(2_000).parse(req.body.corners);
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new ApiError(400, "Crop corners must be valid JSON"); }
  const corners = z.object({ topLeft: pointSchema, topRight: pointSchema, bottomRight: pointSchema, bottomLeft: pointSchema }).strict().parse(decoded);
  await validateReceiptUpload(req.file);
  res.setHeader("Cache-Control", "no-store");
  res.json(await transformReceiptPerspective(req.file.buffer, corners));
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
  await validateReceiptUpload(req.file);
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
  const expectedScanRevision = req.query.expectedScanRevision === undefined
    ? undefined
    : z.coerce.number().int().nonnegative().parse(req.query.expectedScanRevision);
  const scan = await deleteScanItem(req.user!.id, id, itemId, expectedScanRevision);
  res.json(scan);
}

export async function updateItem(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const itemId = parseItemId(req.params.itemId!);
  const scan = await updateScanItem(req.user!.id, id, itemId, itemUpdateSchema.parse(req.body));
  res.json(scan);
}

export async function confirm(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const input = confirmSchema.parse(req.body);
  const records = await confirmReceipt(req.user!.id, id, input);
  res.status(201).json(records);
}
