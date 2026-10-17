import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  duplicateReviewFrom,
  isEmptyDuplicateCandidatePage,
  type DuplicateCheckStatus,
  type DuplicateReviewState,
} from "./duplicateReview";
import type { ReceiptDuplicateCandidatePage, ReceiptScanResult } from "./types";

/** The duplicate check for the scan under review, reloaded whenever a completed scan opens. */
export function useReceiptDuplicateReview(
  scan: ReceiptScanResult | null,
  setConfirmError: (message: string | null) => void,
) {
  const [duplicateReview, setDuplicateReview] = useState<DuplicateReviewState | null>(null);
  const [duplicateLoading, setDuplicateLoading] = useState(false);
  const [duplicateCheckStatus, setDuplicateCheckStatus] = useState<DuplicateCheckStatus>("idle");
  const [duplicateCheckAttempt, setDuplicateCheckAttempt] = useState(0);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const duplicateRequests = useRef<AbortController | null>(null);

  const duplicateScanId = scan?.id;
  const duplicateScanStatus = scan?.processingStatus;
  useEffect(() => {
    if (duplicateScanId === undefined || duplicateScanStatus !== "Complete") {
      duplicateRequests.current?.abort();
      duplicateRequests.current = null;
      setDuplicateReview(null);
      setDuplicateAcknowledged(false);
      setDuplicateLoading(false);
      setDuplicateCheckStatus("idle");
      return;
    }
    duplicateRequests.current?.abort();
    const controller = new AbortController();
    duplicateRequests.current = controller;
    setDuplicateReview(null);
    setDuplicateAcknowledged(false);
    setDuplicateLoading(true);
    setDuplicateCheckStatus("loading");
    void api.get<ReceiptDuplicateCandidatePage>(`/records/receipts/${duplicateScanId}/duplicate-candidates`, {
      params: { take: 50 },
      signal: controller.signal,
    }).then(({ data }) => {
      if (controller.signal.aborted) return;
      const review = duplicateReviewFrom(data);
      if (!review && !isEmptyDuplicateCandidatePage(data)) {
        throw new Error("Duplicate candidate response was invalid");
      }
      setDuplicateReview(review);
      setDuplicateCheckStatus("success");
    }).catch(() => {
      if (!controller.signal.aborted) setDuplicateCheckStatus("error");
    }).finally(() => {
      if (!controller.signal.aborted) setDuplicateLoading(false);
    });
    return () => {
      controller.abort();
      if (duplicateRequests.current === controller) duplicateRequests.current = null;
    };
  }, [duplicateCheckAttempt, duplicateScanId, duplicateScanStatus]);

  const duplicateListComplete = duplicateReview === null
    || (duplicateReview.nextCursor === null
      && duplicateReview.candidates.length === duplicateReview.candidateCount);

  async function loadMoreDuplicateCandidates() {
    if (!scan || !duplicateReview?.nextCursor || duplicateLoading) return;
    const current = duplicateReview;
    const signal = duplicateRequests.current?.signal;
    if (!signal || signal.aborted) return;
    setDuplicateLoading(true);
    setDuplicateCheckStatus("loading");
    setConfirmError(null);
    try {
      const { data } = await api.get<ReceiptDuplicateCandidatePage>(
        `/records/receipts/${scan.id}/duplicate-candidates`,
        { params: { cursor: current.nextCursor, take: 50 }, signal },
      );
      signal.throwIfAborted();
      const page = duplicateReviewFrom(data, current.changed);
      if (!page) {
        throw new Error("Duplicate candidate page was invalid");
      }
      if (page.candidateSetHash !== current.candidateSetHash) {
        const fresh = await api.get<ReceiptDuplicateCandidatePage>(
          `/records/receipts/${scan.id}/duplicate-candidates`,
          { params: { take: 50 }, signal },
        );
        signal.throwIfAborted();
        const refreshedReview = duplicateReviewFrom(fresh.data, true);
        if (!refreshedReview && !isEmptyDuplicateCandidatePage(fresh.data)) {
          throw new Error("Duplicate candidate response was invalid");
        }
        setDuplicateReview(refreshedReview);
        setDuplicateCheckStatus("success");
        setDuplicateAcknowledged(false);
        setConfirmError("The possible matches changed. Review the current list before saving.");
        return;
      }

      const candidates = [...new Map(
        [...current.candidates, ...page.candidates].map((candidate) => [candidate.id, candidate]),
      ).values()];
      if (candidates.length > page.candidateCount
        || (page.nextCursor === null && candidates.length !== page.candidateCount)) {
        throw new Error("Duplicate candidate page did not match its full-set count");
      }
      setDuplicateReview({
        candidateSetHash: current.candidateSetHash,
        candidates,
        candidateCount: page.candidateCount,
        nextCursor: page.nextCursor,
        changed: current.changed,
      });
      setDuplicateCheckStatus("success");
      setDuplicateAcknowledged(false);
    } catch {
      if (!signal.aborted) {
        setDuplicateCheckStatus("error");
        setConfirmError("FinSight could not load every possible match. Try loading the list again before saving.");
      }
    } finally {
      if (!signal.aborted) setDuplicateLoading(false);
    }
  }

  function retryDuplicateCheck() {
    setConfirmError(null);
    setDuplicateCheckAttempt((attempt) => attempt + 1);
  }

  return {
    duplicateReview,
    setDuplicateReview,
    duplicateLoading,
    setDuplicateLoading,
    duplicateCheckStatus,
    setDuplicateCheckStatus,
    duplicateAcknowledged,
    setDuplicateAcknowledged,
    duplicateListComplete,
    loadMoreDuplicateCandidates,
    retryDuplicateCheck,
  };
}
