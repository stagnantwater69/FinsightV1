import { describe, expect, it } from "vitest";
import {
  duplicateCandidatePageFromResponse,
  duplicateReasonLabel,
  duplicateReviewFromError,
  duplicateReviewIsComplete,
  type ReceiptDuplicateReview,
} from "../src/screens/records/scanReceipt/duplicateReview";

const validBody: ReceiptDuplicateReview = {
  code: "DUPLICATE_REVIEW_REQUIRED",
  sourceFingerprint: "1".repeat(64),
  candidateSetHash: "2".repeat(64),
  candidates: [{
    id: 9,
    target: { kind: "receipt", id: 9 },
    vendor: "Corner Store",
    date: "2026-09-01T00:00:00.000Z",
    total: 125.5,
    scoreBand: "LIKELY",
    reasons: ["SAME_VENDOR", "SAME_TOTAL"],
  }],
  candidateCount: 1,
  candidatesTruncated: false,
  nextCursor: null,
};

describe("receipt duplicate review", () => {
  it("accepts the bounded safe 409 contract", () => {
    expect(duplicateReviewFromError({ status: 409, code: validBody.code, responseBody: validBody }))
      .toEqual(validBody);
    expect(duplicateReviewIsComplete(validBody)).toBe(true);
  });

  it("accepts only a continuation page from the same locked candidate set", () => {
    const page = {
      sourceFingerprint: validBody.sourceFingerprint,
      candidateSetHash: validBody.candidateSetHash,
      candidates: [{ ...validBody.candidates[0], id: 10, target: { kind: "expense" as const, id: 20 } }],
      nextCursor: null,
    };
    expect(duplicateCandidatePageFromResponse(page, validBody)).toEqual(page);
    expect(duplicateCandidatePageFromResponse({ ...page, candidateSetHash: "3".repeat(64) }, validBody)).toBeNull();
    expect(duplicateCandidatePageFromResponse({ ...page, candidates: [page.candidates[0], page.candidates[0]] }, validBody)).toBeNull();
  });

  it.each([
    { status: 400, responseBody: validBody },
    { status: 409, responseBody: { ...validBody, candidateSetHash: "not-a-hash" } },
    { status: 409, responseBody: { ...validBody, candidates: [{ ...validBody.candidates[0], total: -1 }] } },
    { status: 409, responseBody: { ...validBody, candidates: [] } },
    { status: 409, responseBody: { ...validBody, candidateCount: 2 } },
    { status: 409, responseBody: { ...validBody, candidatesTruncated: true, candidateCount: 2, nextCursor: null } },
  ])("rejects malformed or non-review responses", (error) => {
    expect(duplicateReviewFromError(error)).toBeNull();
  });

  it("uses owner-readable reasons without exposing unknown server values", () => {
    expect(duplicateReasonLabel("EXACT_IMAGE")).toBe("Same receipt image");
    expect(duplicateReasonLabel("INTERNAL_MATCH_RULE")).toBe("Similar receipt details");
  });
});
