import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupReceiptUploadTemporaryFiles: vi.fn(),
  inspectReceiptUpload: vi.fn(),
  receiptUploadByteLength: vi.fn(),
  uploadAndScan: vi.fn(),
}));

vi.mock("../../src/lib/receiptUploadValidation", () => ({
  inspectReceiptUpload: mocks.inspectReceiptUpload,
  receiptUploadByteLength: mocks.receiptUploadByteLength,
  validateReceiptUpload: vi.fn(),
}));

vi.mock("../../src/middleware/upload.middleware", () => ({
  cleanupReceiptUploadTemporaryFiles: mocks.cleanupReceiptUploadTemporaryFiles,
}));

vi.mock("../../src/services/receiptScan/queue", () => ({
  uploadAndScan: mocks.uploadAndScan,
}));

import { upload } from "../../src/controllers/receiptScan.controller";

interface DeferredPhase<T> {
  active: number;
  maxActive: number;
  releases: Map<string, () => void>;
  started: string[];
  run: (file: Express.Multer.File) => Promise<T>;
}

function deferredPhase<T>(result: (name: string) => T): DeferredPhase<T> {
  const phase: DeferredPhase<T> = {
    active: 0,
    maxActive: 0,
    releases: new Map(),
    started: [],
    async run(file) {
      phase.active += 1;
      phase.maxActive = Math.max(phase.maxActive, phase.active);
      phase.started.push(file.originalname);
      await new Promise<void>((resolve) => phase.releases.set(file.originalname, resolve));
      phase.active -= 1;
      return result(file.originalname);
    },
  };
  return phase;
}

function receiptFile(name: string): Express.Multer.File {
  return {
    originalname: name,
    mimetype: "image/jpeg",
    path: `/tmp/${name}`,
  } as Express.Multer.File;
}

async function expectStarted(phase: DeferredPhase<unknown>, names: string[]): Promise<void> {
  await vi.waitFor(() => expect(phase.started).toEqual(names));
}

describe("receipt upload acceptance concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanupReceiptUploadTemporaryFiles.mockResolvedValue(undefined);
    mocks.uploadAndScan.mockResolvedValue({ id: 41, processingStatus: "Processing" });
  });

  it("checks two files at a time and keeps source, derived, and metadata page order", async () => {
    const sizes: Record<string, number> = {
      "derived-1.jpg": 11,
      "derived-2.jpg": 12,
      "source-1.jpg": 21,
      "source-2.jpg": 22,
    };
    const dimensions: Record<string, { width: number; height: number }> = {
      "derived-1.jpg": { width: 101, height: 201 },
      "derived-2.jpg": { width: 102, height: 202 },
      "source-1.jpg": { width: 301, height: 401 },
      "source-2.jpg": { width: 302, height: 402 },
    };
    const sizePhase = deferredPhase((name) => sizes[name]!);
    const inspectionPhase = deferredPhase((name) => dimensions[name]!);
    mocks.receiptUploadByteLength.mockImplementation(sizePhase.run);
    mocks.inspectReceiptUpload.mockImplementation(inspectionPhase.run);

    const derived = [receiptFile("derived-1.jpg"), receiptFile("derived-2.jpg")];
    const sources = [receiptFile("source-1.jpg"), receiptFile("source-2.jpg")];
    const req = {
      body: {
        businessProfileId: "7",
        captureMetadata: JSON.stringify([
          { originalWidth: 301, originalHeight: 401, processedWidth: 101, processedHeight: 201 },
          { originalWidth: 302, originalHeight: 402, processedWidth: 102, processedHeight: 202 },
        ]),
      },
      files: { files: derived, originalFiles: sources },
      user: { id: 9 },
    } as unknown as Request;
    const res = {
      json: vi.fn(),
      status: vi.fn(),
    } as unknown as Response;
    vi.mocked(res.status).mockReturnValue(res);

    const pending = upload(req, res);

    await expectStarted(sizePhase, ["derived-1.jpg", "derived-2.jpg"]);
    sizePhase.releases.get("derived-2.jpg")!();
    await expectStarted(sizePhase, ["derived-1.jpg", "derived-2.jpg", "source-1.jpg"]);
    sizePhase.releases.get("source-1.jpg")!();
    await expectStarted(sizePhase, ["derived-1.jpg", "derived-2.jpg", "source-1.jpg", "source-2.jpg"]);
    sizePhase.releases.get("source-2.jpg")!();
    sizePhase.releases.get("derived-1.jpg")!();

    await expectStarted(inspectionPhase, ["derived-1.jpg", "derived-2.jpg"]);
    inspectionPhase.releases.get("derived-2.jpg")!();
    await expectStarted(inspectionPhase, ["derived-1.jpg", "derived-2.jpg", "source-1.jpg"]);
    inspectionPhase.releases.get("source-1.jpg")!();
    await expectStarted(inspectionPhase, ["derived-1.jpg", "derived-2.jpg", "source-1.jpg", "source-2.jpg"]);
    inspectionPhase.releases.get("source-2.jpg")!();
    inspectionPhase.releases.get("derived-1.jpg")!();

    await pending;

    expect(sizePhase.maxActive).toBe(2);
    expect(inspectionPhase.maxActive).toBe(2);
    expect(mocks.uploadAndScan).toHaveBeenCalledWith(9, {
      businessProfileId: 7,
      idempotencyKey: undefined,
      receiptBatchId: undefined,
      receiptOrdinal: undefined,
      pages: [
        {
          source: "temporary-file",
          temporaryPath: "/tmp/source-1.jpg",
          sizeBytes: 21,
          mimetype: "image/jpeg",
          originalname: "source-1.jpg",
          processed: {
            source: "temporary-file",
            temporaryPath: "/tmp/derived-1.jpg",
            sizeBytes: 11,
            mimetype: "image/jpeg",
            originalname: "derived-1.jpg",
          },
          metadata: {
            originalWidth: 301,
            originalHeight: 401,
            processedWidth: 101,
            processedHeight: 201,
          },
        },
        {
          source: "temporary-file",
          temporaryPath: "/tmp/source-2.jpg",
          sizeBytes: 22,
          mimetype: "image/jpeg",
          originalname: "source-2.jpg",
          processed: {
            source: "temporary-file",
            temporaryPath: "/tmp/derived-2.jpg",
            sizeBytes: 12,
            mimetype: "image/jpeg",
            originalname: "derived-2.jpg",
          },
          metadata: {
            originalWidth: 302,
            originalHeight: 402,
            processedWidth: 102,
            processedHeight: 202,
          },
        },
      ],
    });
    expect(mocks.cleanupReceiptUploadTemporaryFiles).toHaveBeenCalledWith(req);
    expect(res.status).toHaveBeenCalledWith(202);
  });
});
