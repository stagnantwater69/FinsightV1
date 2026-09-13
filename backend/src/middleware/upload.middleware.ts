import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pipeline, Transform } from "node:stream";
import type { Request, RequestHandler } from "express";
import multer from "multer";
import type { StorageEngine } from "multer";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { ApiError } from "./error.middleware";
import {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "../lib/receiptUploadContract";

const storage = multer.memoryStorage();
const receiptMimeTypes = new Set<string>(RECEIPT_UPLOAD_ALLOWED_MIME_TYPES);

interface ReceiptTemporaryUploadState {
  directory: string;
  receivedBytes: number;
  activeMarkerHeartbeat?: ReturnType<typeof setInterval>;
  cleanupPromise?: Promise<void>;
}

const receiptTemporaryUploads = new WeakMap<Request, ReceiptTemporaryUploadState>();

export function validateReceiptUploadTempRoot(configuredRoot: string): string {
  const root = resolve(configuredRoot);
  const standardLeaf = basename(root) === "finsight-receipt-uploads";
  const containerLeaf = basename(root) === "receipt-uploads" && basename(dirname(root)) === "finsight";
  if (
    !isAbsolute(configuredRoot) ||
    normalize(configuredRoot) !== configuredRoot ||
    root === resolve("/") ||
    root === resolve(tmpdir()) ||
    (!standardLeaf && !containerLeaf)
  ) {
    throw new ApiError(500, "Receipt upload temporary storage is unavailable");
  }
  return root;
}

function receiptUploadState(req: Request): ReceiptTemporaryUploadState {
  const state = receiptTemporaryUploads.get(req);
  if (!state) throw new ApiError(500, "Receipt upload temporary storage is unavailable");
  return state;
}

async function removeReceiptTemporaryFiles(state: ReceiptTemporaryUploadState): Promise<void> {
  if (!state.cleanupPromise) {
    if (state.activeMarkerHeartbeat) clearInterval(state.activeMarkerHeartbeat);
    state.cleanupPromise = rm(state.directory, { recursive: true, force: true }).catch((error: unknown) => {
      logger.error({ failureKind: error instanceof Error ? error.name : "unknown" }, "Could not clean receipt upload temporary files");
    });
  }
  await state.cleanupPromise;
}

export async function cleanupReceiptUploadTemporaryFiles(req: Request): Promise<void> {
  const state = receiptTemporaryUploads.get(req);
  if (state) await removeReceiptTemporaryFiles(state);
}

export const prepareReceiptUploadTemporaryFiles: RequestHandler = async (req, res, next) => {
  let directory: string | undefined;
  try {
    const temporaryRoot = validateReceiptUploadTempRoot(env.RECEIPT_UPLOAD_TEMP_ROOT);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(temporaryRoot);
    const processUid = process.getuid?.();
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (processUid !== undefined && root.uid !== processUid)
    ) {
      throw new ApiError(500, "Receipt upload temporary storage is unavailable");
    }
    await chmod(temporaryRoot, 0o700);
    directory = await mkdtemp(join(temporaryRoot, "finsight-receipt-"));
    await chmod(directory, 0o700);
    const activeMarker = join(directory, ".active");
    await writeFile(activeMarker, "active\n", { flag: "wx", mode: 0o600 });
    const state: ReceiptTemporaryUploadState = { directory, receivedBytes: 0 };
    state.activeMarkerHeartbeat = setInterval(() => {
      void writeFile(activeMarker, "active\n", { mode: 0o600 }).catch(() => undefined);
    }, 60_000);
    state.activeMarkerHeartbeat.unref();
    receiptTemporaryUploads.set(req, state);

    const cleanup = () => void removeReceiptTemporaryFiles(state);
    req.once("aborted", cleanup);
    req.once("error", cleanup);
    req.once("timeout", cleanup);
    req.once("close", () => {
      if (!req.complete) cleanup();
    });
    res.once("finish", cleanup);
    res.once("close", cleanup);
    res.once("error", cleanup);
    res.once("timeout", cleanup);
    next();
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    next(error instanceof ApiError ? error : new ApiError(500, "Receipt upload temporary storage is unavailable"));
  }
};

const receiptTemporaryStorage: StorageEngine = {
  _handleFile(req, file, callback) {
    let state: ReceiptTemporaryUploadState;
    try {
      state = receiptUploadState(req);
    } catch (error) {
      callback(error);
      return;
    }

    const filename = randomUUID();
    const path = join(state.directory, filename);
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    file.path = path;

    const aggregateLimit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        state.receivedBytes += chunk.length;
        if (state.receivedBytes > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES) {
          done(new ApiError(413, "Receipt upload files must total 80 MiB or less"));
          return;
        }
        done(null, chunk);
      },
    });

    pipeline(file.stream, aggregateLimit, output, (error) => {
      if (error) {
        void unlink(path).catch(() => undefined).then(() => callback(error));
        return;
      }
      callback(null, {
        destination: state.directory,
        filename,
        path,
        size: output.bytesWritten,
      });
    });
  },
  _removeFile(_req, file, callback) {
    const path = file.path;
    if (!path) {
      callback(null);
      return;
    }
    void unlink(path).then(() => callback(null), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") callback(null);
      else callback(error);
    });
  },
};

export const uploadReceiptEvidence = multer({
  storage: receiptTemporaryStorage,
  limits: {
    fileSize: RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
    files: RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS,
    fields: 8,
    parts: RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS + 8,
    fieldNameSize: 100,
    fieldSize: 64 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!receiptMimeTypes.has(file.mimetype)) {
      cb(new ApiError(400, "Receipt image must be JPEG, PNG, or WEBP"));
      return;
    }
    cb(null, true);
  },
});

export const uploadReceiptImage = multer({
  storage,
  limits: { fileSize: RECEIPT_UPLOAD_MAX_OBJECT_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!receiptMimeTypes.has(file.mimetype)) {
      cb(new ApiError(400, "Receipt image must be JPEG, PNG, or WEBP"));
      return;
    }
    cb(null, true);
  },
});

export const uploadCsv = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["text/csv", "application/vnd.ms-excel", "application/csv", "text/plain"];
    if (!allowed.includes(file.mimetype) && !file.originalname.toLowerCase().endsWith(".csv")) {
      cb(new ApiError(400, "File must be a CSV"));
      return;
    }
    cb(null, true);
  },
});

export const uploadPhoto = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      cb(new ApiError(400, "Photo must be JPEG, PNG, or WEBP"));
      return;
    }
    cb(null, true);
  },
});
