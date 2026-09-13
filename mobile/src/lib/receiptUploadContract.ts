export const RECEIPT_UPLOAD_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES = 80 * 1024 * 1024;
export const RECEIPT_UPLOAD_MAX_LOGICAL_PAGES = 8;
export const RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS = RECEIPT_UPLOAD_MAX_LOGICAL_PAGES * 2;
export const RECEIPT_UPLOAD_ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface ReceiptUploadPageReference {
  key: string;
  uri: string;
  mimeType: string;
  originalUri?: string;
  originalMimeType?: string;
}

export interface ReceiptUploadObject {
  pageKey: string;
  pageNumber: number;
  variant: "processed" | "original";
  uri: string;
  mediaType: string;
}

export type ReceiptUploadIssueCode =
  | "EMPTY_RECEIPT"
  | "TOO_MANY_PAGES"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNREADABLE_OBJECT"
  | "EMPTY_OBJECT"
  | "OBJECT_TOO_LARGE"
  | "AGGREGATE_TOO_LARGE";

export interface ReceiptUploadIssue {
  code: ReceiptUploadIssueCode;
  message: string;
  pageKey?: string;
  pageNumber?: number;
  variant?: ReceiptUploadObject["variant"];
}

export interface InspectedReceiptUploadObject extends ReceiptUploadObject {
  bytes: number | null;
}

export type ReceiptUploadInspection =
  | {
      ok: true;
      totalBytes: number;
      objects: InspectedReceiptUploadObject[];
      issues: [];
    }
  | {
      ok: false;
      totalBytes: number | null;
      objects: InspectedReceiptUploadObject[];
      issues: ReceiptUploadIssue[];
    };

/** Mirrors the multipart fields emitted by ScanReceiptScreen. */
export function receiptMultipartObjects(
  pages: readonly ReceiptUploadPageReference[],
): ReceiptUploadObject[] {
  const objects: ReceiptUploadObject[] = pages.map((page, index) => ({
    pageKey: page.key,
    pageNumber: index + 1,
    variant: "processed",
    uri: page.uri,
    mediaType: page.mimeType,
  }));
  const carriesOriginals = pages.some(
    (page) => Boolean(page.originalUri) && page.originalUri !== page.uri,
  );

  if (carriesOriginals) {
    for (const [index, page] of pages.entries()) {
      objects.push({
        pageKey: page.key,
        pageNumber: index + 1,
        variant: "original",
        uri: page.originalUri ?? page.uri,
        mediaType: page.originalUri
          ? page.originalMimeType ?? page.mimeType
          : page.mimeType,
      });
    }
  }
  return objects;
}

function objectName(object: ReceiptUploadObject): string {
  return object.variant === "original"
    ? `Section ${object.pageNumber}'s original photo`
    : `Section ${object.pageNumber}'s photo`;
}

function supportedMediaType(value: string): boolean {
  return (RECEIPT_UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

export async function inspectReceiptUpload(
  pages: readonly ReceiptUploadPageReference[],
  byteSizeOf: (uri: string) => Promise<number>,
): Promise<ReceiptUploadInspection> {
  if (pages.length === 0) {
    return {
      ok: false,
      totalBytes: 0,
      objects: [],
      issues: [{ code: "EMPTY_RECEIPT", message: "Add a receipt photo before scanning." }],
    };
  }
  if (pages.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
    return {
      ok: false,
      totalBytes: null,
      objects: [],
      issues: [{
        code: "TOO_MANY_PAGES",
        message: "A receipt can contain up to 8 sections. The photos stay here so you can remove the extra sections.",
      }],
    };
  }

  const objects = receiptMultipartObjects(pages);
  const reads = new Map<string, Promise<number>>();
  const readOnce = (uri: string) => {
    const existing = reads.get(uri);
    if (existing) return existing;
    const next = byteSizeOf(uri);
    reads.set(uri, next);
    return next;
  };

  const inspected = await Promise.all(objects.map(async (object): Promise<InspectedReceiptUploadObject> => {
    try {
      const bytes = await readOnce(object.uri);
      return { ...object, bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null };
    } catch {
      return { ...object, bytes: null };
    }
  }));

  const issues: ReceiptUploadIssue[] = [];
  for (const object of inspected) {
    const common = {
      pageKey: object.pageKey,
      pageNumber: object.pageNumber,
      variant: object.variant,
    };
    if (!supportedMediaType(object.mediaType)) {
      issues.push({
        ...common,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: `${objectName(object)} is not a JPG, PNG, or WebP image. It stays in this receipt so you can remove it or open Review photos to retake it.`,
      });
    } else if (object.bytes === null) {
      issues.push({
        ...common,
        code: "UNREADABLE_OBJECT",
        message: `${objectName(object)} could not be checked. It stays in this receipt so you can remove it or open Review photos to retake it.`,
      });
    } else if (object.bytes === 0) {
      issues.push({
        ...common,
        code: "EMPTY_OBJECT",
        message: `${objectName(object)} is empty. It stays in this receipt so you can remove it or open Review photos to retake it.`,
      });
    } else if (object.bytes > RECEIPT_UPLOAD_MAX_OBJECT_BYTES) {
      issues.push({
        ...common,
        code: "OBJECT_TOO_LARGE",
        message: `${objectName(object)} is larger than 10 MiB. It stays in this receipt so you can remove it or open Review photos to retake it.`,
      });
    }
  }

  const allSizesKnown = inspected.every((object) => object.bytes !== null);
  const totalBytes = allSizesKnown
    ? inspected.reduce((total, object) => total + object.bytes!, 0)
    : null;
  if (totalBytes !== null && totalBytes > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES) {
    issues.push({
      code: "AGGREGATE_TOO_LARGE",
      message: "The receipt images exceed the 80 MiB total. They stay here so you can remove a section or open Review photos to retake a smaller photo.",
    });
  }

  return issues.length === 0
    ? { ok: true, totalBytes: totalBytes!, objects: inspected, issues: [] }
    : { ok: false, totalBytes, objects: inspected, issues };
}
