import { isAxiosError } from "axios";
import type {
  ReceiptDuplicateCandidate,
  ReceiptDuplicateCandidatePage,
  ReceiptDuplicateReason,
  ReceiptDuplicateReview,
} from "./types";

export type DuplicateCheckStatus = "idle" | "loading" | "success" | "error";

export interface DuplicateReviewState extends Pick<
  ReceiptDuplicateReview,
  "candidateSetHash" | "candidates" | "candidateCount" | "nextCursor"
> {
  changed: boolean;
}

export const DUPLICATE_REASON_COPY: Record<ReceiptDuplicateReason, string> = {
  EXACT_IMAGE: "same receipt image",
  SAME_VENDOR: "same merchant",
  SAME_DESCRIPTION: "same description",
  SAME_DATE: "same date",
  SAME_TOTAL: "same total",
};
export const DUPLICATE_REASONS = new Set<ReceiptDuplicateReason>(Object.keys(DUPLICATE_REASON_COPY) as ReceiptDuplicateReason[]);

/**
 * The confirm-time hash when a DUPLICATE_REVIEW_CHANGED answer names exactly the
 * acknowledged target records. Row ids move with the edited identity; targets do not.
 */
export function sameMatchesHash(error: unknown, acknowledged: DuplicateReviewState): string | null {
  if (!isAxiosError(error) || error.response?.status !== 409) return null;
  const body = error.response.data as Partial<ReceiptDuplicateReview> | undefined;
  if (body?.code !== "DUPLICATE_REVIEW_CHANGED") return null;
  const current = duplicateReviewFrom(body, true);
  if (!current || current.nextCursor !== null || current.candidates.length !== current.candidateCount) return null;
  const targetKey = (candidate: ReceiptDuplicateCandidate) => `${candidate.target.kind}:${candidate.target.id}`;
  const acknowledgedTargets = new Set(acknowledged.candidates.map(targetKey));
  const currentTargets = new Set(current.candidates.map(targetKey));
  if (acknowledgedTargets.size !== currentTargets.size) return null;
  for (const key of currentTargets) if (!acknowledgedTargets.has(key)) return null;
  return current.candidateSetHash;
}

export function duplicateReviewFrom(value: unknown, changed = false): DuplicateReviewState | null {
  if (!value || typeof value !== "object") return null;
  const candidateSetHash = (value as { candidateSetHash?: unknown }).candidateSetHash;
  const candidates = (value as { candidates?: unknown }).candidates;
  const candidateCountValue = (value as { candidateCount?: unknown }).candidateCount;
  const candidatesTruncatedValue = (value as { candidatesTruncated?: unknown }).candidatesTruncated;
  const nextCursorValue = (value as { nextCursor?: unknown }).nextCursor;
  if (typeof candidateSetHash !== "string" || !/^[0-9a-f]{64}$/.test(candidateSetHash) || !Array.isArray(candidates)) {
    return null;
  }
  const valid = candidates.filter((candidate): candidate is ReceiptDuplicateCandidate => {
    if (!candidate || typeof candidate !== "object") return false;
    const row = candidate as Partial<ReceiptDuplicateCandidate>;
    return Number.isInteger(row.id)
      && typeof row.date === "string"
      && typeof row.total === "number"
      && Number.isFinite(row.total)
      && (row.vendor === null || typeof row.vendor === "string")
      && (row.scoreBand === "EXACT" || row.scoreBand === "LIKELY")
      && Array.isArray(row.reasons)
      && row.reasons.every((reason) => DUPLICATE_REASONS.has(reason))
      && Boolean(row.target && (row.target.kind === "receipt" || row.target.kind === "expense") && Number.isInteger(row.target.id));
  });
  if (valid.length !== candidates.length || valid.length === 0) return null;
  const candidateCount = candidateCountValue === undefined
    ? valid.length
    : candidateCountValue;
  if (!Number.isInteger(candidateCount) || Number(candidateCount) < valid.length) return null;
  const nextCursor = nextCursorValue === undefined ? null : nextCursorValue;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0)) return null;
  if (candidatesTruncatedValue !== undefined
    && (typeof candidatesTruncatedValue !== "boolean"
      || candidatesTruncatedValue !== (nextCursor !== null))) return null;
  return {
    candidateSetHash,
    candidates: valid,
    candidateCount: Number(candidateCount),
    nextCursor,
    changed,
  };
}

export function isEmptyDuplicateCandidatePage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as Partial<ReceiptDuplicateCandidatePage>;
  const sourceFingerprintIsValid = page.sourceFingerprint === null
    || (typeof page.sourceFingerprint === "string" && /^[0-9a-f]{64}$/.test(page.sourceFingerprint));
  return sourceFingerprintIsValid
    && page.candidateSetHash === null
    && Array.isArray(page.candidates)
    && page.candidates.length === 0
    && page.candidateCount === 0
    && page.candidatesTruncated === false
    && page.nextCursor === null;
}
