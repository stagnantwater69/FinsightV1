export type ReceiptDuplicateReason =
  | "EXACT_IMAGE"
  | "SAME_VENDOR"
  | "SAME_DESCRIPTION"
  | "SAME_DATE"
  | "SAME_TOTAL";

export interface ReceiptDuplicateCandidate {
  id: number;
  target: { kind: "receipt" | "expense"; id: number };
  vendor: string | null;
  date: string;
  total: number;
  scoreBand: "EXACT" | "LIKELY";
  reasons: string[];
}

export interface ReceiptDuplicateReview {
  code: "DUPLICATE_REVIEW_REQUIRED" | "DUPLICATE_REVIEW_CHANGED";
  sourceFingerprint: string;
  candidateSetHash: string;
  candidates: ReceiptDuplicateCandidate[];
  candidateCount: number;
  candidatesTruncated: boolean;
  nextCursor: string | null;
}

export interface ReceiptDuplicateCandidatePage {
  sourceFingerprint: string;
  candidateSetHash: string;
  candidates: ReceiptDuplicateCandidate[];
  nextCursor: string | null;
}

export interface ReceiptDuplicateDecision {
  action: "SAVE_ANYWAY";
  candidateSetHash: string;
}

const HASH = /^[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

function candidateFrom(value: unknown): ReceiptDuplicateCandidate | null {
  const data = record(value);
  const target = record(data?.target);
  const reasons = data?.reasons;
  if (!data
    || !Number.isInteger(data.id) || Number(data.id) <= 0
    || !target || (target.kind !== "receipt" && target.kind !== "expense")
    || !Number.isInteger(target.id) || Number(target.id) <= 0
    || (data.vendor !== null && typeof data.vendor !== "string")
    || (typeof data.vendor === "string" && data.vendor.length > 255)
    || typeof data.date !== "string" || data.date.length < 10 || data.date.length > 40
    || !Number.isFinite(Date.parse(data.date))
    || typeof data.total !== "number" || !Number.isFinite(data.total) || data.total <= 0
    || (data.scoreBand !== "EXACT" && data.scoreBand !== "LIKELY")
    || !Array.isArray(reasons) || reasons.length > 10
    || reasons.some((reason) => typeof reason !== "string" || reason.length < 1 || reason.length > 64)) {
    return null;
  }
  return {
    id: Number(data.id),
    target: { kind: target.kind, id: Number(target.id) },
    vendor: data.vendor as string | null,
    date: data.date,
    total: data.total,
    scoreBand: data.scoreBand,
    reasons: reasons as string[],
  };
}

function candidatesFrom(value: unknown, maximum: number): ReceiptDuplicateCandidate[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) return null;
  const candidates = value.map(candidateFrom);
  if (candidates.some((candidate) => candidate === null)) return null;
  const ids = candidates.map((candidate) => candidate!.id);
  if (new Set(ids).size !== ids.length) return null;
  return candidates as ReceiptDuplicateCandidate[];
}

function cursorFrom(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && CURSOR.test(value) ? value : undefined;
}

/** Reads only the bounded, owner-safe duplicate summary carried by a 409. */
export function duplicateReviewFromError(error: unknown): ReceiptDuplicateReview | null {
  const failure = record(error);
  const body = record(failure?.responseBody);
  const code = failure?.code ?? body?.code;
  const candidates = candidatesFrom(body?.candidates, 20);
  const nextCursor = cursorFrom(body?.nextCursor);
  if (failure?.status !== 409
    || (code !== "DUPLICATE_REVIEW_REQUIRED" && code !== "DUPLICATE_REVIEW_CHANGED")
    || typeof body?.sourceFingerprint !== "string" || !HASH.test(body.sourceFingerprint)
    || typeof body.candidateSetHash !== "string" || !HASH.test(body.candidateSetHash)
    || !Number.isSafeInteger(body.candidateCount) || Number(body.candidateCount) < 1
    || typeof body.candidatesTruncated !== "boolean"
    || candidates === null || nextCursor === undefined
    || (body.candidatesTruncated && (nextCursor === null || Number(body.candidateCount) <= candidates.length))
    || (!body.candidatesTruncated && (nextCursor !== null || Number(body.candidateCount) !== candidates.length))) {
    return null;
  }
  return {
    code,
    sourceFingerprint: body.sourceFingerprint,
    candidateSetHash: body.candidateSetHash,
    candidates,
    candidateCount: Number(body.candidateCount),
    candidatesTruncated: body.candidatesTruncated,
    nextCursor,
  };
}

/** Verifies a page still belongs to the exact candidate set shown by the locked confirm. */
export function duplicateCandidatePageFromResponse(
  value: unknown,
  expected: Pick<ReceiptDuplicateReview, "sourceFingerprint" | "candidateSetHash">,
): ReceiptDuplicateCandidatePage | null {
  const body = record(value);
  const candidates = candidatesFrom(body?.candidates, 20);
  const nextCursor = cursorFrom(body?.nextCursor);
  if (!body
    || body.sourceFingerprint !== expected.sourceFingerprint
    || body.candidateSetHash !== expected.candidateSetHash
    || candidates === null
    || nextCursor === undefined) {
    return null;
  }
  return {
    sourceFingerprint: body.sourceFingerprint,
    candidateSetHash: body.candidateSetHash,
    candidates,
    nextCursor,
  };
}

export function duplicateReviewIsComplete(review: ReceiptDuplicateReview): boolean {
  return !review.candidatesTruncated
    && review.nextCursor === null
    && review.candidates.length === review.candidateCount;
}

const REASON_LABELS: Record<ReceiptDuplicateReason, string> = {
  EXACT_IMAGE: "Same receipt image",
  SAME_VENDOR: "Same vendor",
  SAME_DESCRIPTION: "Same description",
  SAME_DATE: "Same date",
  SAME_TOTAL: "Same total",
};

export function duplicateReasonLabel(reason: string): string {
  return REASON_LABELS[reason as ReceiptDuplicateReason] ?? "Similar receipt details";
}
