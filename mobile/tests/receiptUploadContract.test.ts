import { describe, expect, it, vi } from "vitest";
import {
  inspectReceiptUpload,
  receiptMultipartObjects,
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
  type ReceiptUploadPageReference,
} from "../src/lib/receiptUploadContract";
import { pagesFromSections, sectionsFromPages } from "../src/screens/records/scanReceipt/helpers";
import type { CapturedPage } from "../src/screens/records/scanReceipt/types";

vi.mock("../src/lib/api", () => ({ api: {} }));

const page = (index: number, originalUri?: string): ReceiptUploadPageReference => ({
  key: `page-${index}`,
  uri: `file:///processed-${index}.jpg`,
  mimeType: "image/jpeg",
  originalUri,
  originalMimeType: originalUri ? "image/jpeg" : undefined,
});

describe("receipt upload byte contract", () => {
  it("pins the backend and web boundaries in bytes", () => {
    expect(RECEIPT_UPLOAD_MAX_OBJECT_BYTES).toBe(10 * 1024 * 1024);
    expect(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES).toBe(80 * 1024 * 1024);
    expect(RECEIPT_UPLOAD_MAX_LOGICAL_PAGES).toBe(8);
    expect(RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS).toBe(16);
    expect(RECEIPT_UPLOAD_ALLOWED_MIME_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("emits paired originals when any page was transformed", () => {
    const paired = [page(1, "file:///processed-1.jpg"), page(2, "file:///original-2.jpg")];
    expect(receiptMultipartObjects(paired).map(({ variant, uri }) => [variant, uri])).toEqual([
      ["processed", "file:///processed-1.jpg"],
      ["processed", "file:///processed-2.jpg"],
      ["original", "file:///processed-1.jpg"],
      ["original", "file:///original-2.jpg"],
    ]);
  });

  it("keeps mixed transformed evidence paired and counts every stored occurrence", async () => {
    const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
    pages[0] = page(1, "file:///original-1.jpg");
    const objects = receiptMultipartObjects(pages);
    expect(objects).toHaveLength(RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS);
    expect(objects.slice(0, 8).map(({ variant, uri }) => [variant, uri])).toEqual(
      pages.map((item) => ["processed", item.uri]),
    );
    expect(objects.slice(8).map(({ variant, uri }) => [variant, uri])).toEqual([
      ["original", "file:///original-1.jpg"],
      ...pages.slice(1).map((item) => ["original", item.uri]),
    ]);

    const size = vi.fn(async () => 5 * 1024 * 1024);
    const result = await inspectReceiptUpload(pages, size);
    expect(result.ok).toBe(true);
    expect(result.totalBytes).toBe(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES);
    expect(size).toHaveBeenCalledTimes(9);
  });

  it("keeps a PNG original's media type after its processed copy becomes JPEG", () => {
    const selected: CapturedPage = {
      key: "cropped-png",
      uri: "file:///original.png",
      fileName: "original.png",
      mimeType: "image/png",
      originalMimeType: "image/png",
      quality: null,
      checkingQuality: false,
      width: 900,
      height: 1600,
    };
    const section = sectionsFromPages([selected])[0]!;
    const [cropped] = pagesFromSections([{
      ...section,
      processedUri: "file:///processed.jpg",
      processedMimeType: "image/jpeg",
      width: 800,
      height: 1500,
    }]);
    const objects = receiptMultipartObjects([cropped!]);
    expect(cropped).toMatchObject({
      uri: "file:///processed.jpg",
      mimeType: "image/jpeg",
      originalUri: "file:///original.png",
      originalMimeType: "image/png",
    });
    expect(objects.map(({ variant, uri, mediaType }) => ({ variant, uri, mediaType }))).toEqual([
      { variant: "processed", uri: "file:///processed.jpg", mediaType: "image/jpeg" },
      { variant: "original", uri: "file:///original.png", mediaType: "image/png" },
    ]);
  });

  it("blocks unsupported processed and original media types without removing either page", async () => {
    const processed = { ...page(1), mimeType: "image/gif" };
    const processedBefore = JSON.stringify(processed);
    const processedResult = await inspectReceiptUpload([processed], async () => 1024);
    expect(processedResult.ok).toBe(false);
    expect(processedResult.issues).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_MEDIA_TYPE",
        pageKey: "page-1",
        variant: "processed",
      }),
    ]);
    expect(JSON.stringify(processed)).toBe(processedBefore);

    const original = {
      ...page(2, "file:///original-2.gif"),
      originalMimeType: "image/gif",
    };
    const originalBefore = JSON.stringify(original);
    const originalResult = await inspectReceiptUpload([original], async () => 1024);
    expect(originalResult.ok).toBe(false);
    expect(originalResult.issues).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_MEDIA_TYPE",
        pageKey: "page-2",
        variant: "original",
      }),
    ]);
    expect(JSON.stringify(original)).toBe(originalBefore);
  });

  it("counts the same local file twice when FormData sends it as two stored objects", async () => {
    const pages = [page(1, "file:///processed-1.jpg"), page(2, "file:///original-2.jpg")];
    const sizes: Record<string, number> = {
      "file:///processed-1.jpg": 2 * 1024 * 1024,
      "file:///processed-2.jpg": 3 * 1024 * 1024,
      "file:///original-2.jpg": 4 * 1024 * 1024,
    };
    const result = await inspectReceiptUpload(pages, async (uri) => sizes[uri]!);
    expect(result.ok).toBe(true);
    expect(result.totalBytes).toBe(11 * 1024 * 1024);
  });

  it("accepts exact object and aggregate limits", async () => {
    const one = await inspectReceiptUpload([page(1)], async () => RECEIPT_UPLOAD_MAX_OBJECT_BYTES);
    expect(one.ok).toBe(true);

    const pages = Array.from({ length: 8 }, (_, index) => page(index + 1, `file:///original-${index + 1}.jpg`));
    const aggregate = await inspectReceiptUpload(pages, async () => 5 * 1024 * 1024);
    expect(aggregate.ok).toBe(true);
    expect(aggregate.totalBytes).toBe(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES);
    expect(aggregate.objects).toHaveLength(RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS);
  });

  it("rejects one byte over either limit without mutating the selected evidence", async () => {
    const oversizedPages = [page(1)];
    const before = JSON.stringify(oversizedPages);
    const objectResult = await inspectReceiptUpload(
      oversizedPages,
      async () => RECEIPT_UPLOAD_MAX_OBJECT_BYTES + 1,
    );
    expect(objectResult.ok).toBe(false);
    expect(objectResult.issues.map((issue) => issue.code)).toContain("OBJECT_TOO_LARGE");
    expect(JSON.stringify(oversizedPages)).toBe(before);

    const paired = Array.from({ length: 8 }, (_, index) => page(index + 1, `file:///original-${index + 1}.jpg`));
    const firstUri = paired[0]!.uri;
    const aggregateResult = await inspectReceiptUpload(
      paired,
      async (uri) => 5 * 1024 * 1024 + (uri === firstUri ? 1 : 0),
    );
    expect(aggregateResult.ok).toBe(false);
    expect(aggregateResult.issues.map((issue) => issue.code)).toContain("AGGREGATE_TOO_LARGE");
  });

  it("rejects a ninth logical page before reading local files", async () => {
    const size = vi.fn(async () => 1);
    const result = await inspectReceiptUpload(
      Array.from({ length: 9 }, (_, index) => page(index + 1)),
      size,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("TOO_MANY_PAGES");
    expect(size).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", async () => 0, "EMPTY_OBJECT"],
    ["unreadable", async () => { throw new Error("missing"); }, "UNREADABLE_OBJECT"],
  ])("keeps %s local evidence out of the upload", async (_label, size, code) => {
    const result = await inspectReceiptUpload([page(1)], size);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
    expect(result.issues[0]?.message).toMatch(/stays in this receipt/);
  });
});
