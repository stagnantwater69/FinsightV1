import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { isAxiosError } from "axios";
import { Link, useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { CategorySelect } from "../components/CategorySelect";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
/*
 * The payload builder and the plan type both come from lib/receiptConfirm, so
 * this screen and the request it sends cannot disagree about either. "shrink"
 * is the escape hatch for the case where OCR misread the TOTAL rather than
 * missing an item — there the items are the trustworthy figure.
 */
import { buildReceiptConfirmPayload, type GapPlan } from "../lib/receiptConfirm";
import { everyLineIsReady, groupByCategory, sumCentavos, toReviewLines } from "../lib/receiptReview";
/*
 * The confidence BAND, not the raw percentage, is what the owner is shown —
 * ADR-4. One mapping for the whole product replaces the three inconsistent
 * cutoffs this screen used to carry (80/60 for the page, 75 per item).
 */
import { BAND_COPY, confidenceBand, scanConfidenceBand } from "../lib/confidenceBands";
import { Callout, Card, PageHead, FormPage, Pill } from "../components/ui";
import { Button } from "../components/Button";
import { Checkbox, Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { Money } from "../components/Money";
import { useToast } from "../components/Toast";
import { EvidenceNote } from "./scanReceipt/EvidenceNote";
import { GapOption } from "./scanReceipt/GapOption";
import { MultiFileInput } from "./scanReceipt/MultiFileInput";
import { ScannedField } from "./scanReceipt/ScannedField";
import { ScanProgress } from "./scanReceipt/ScanProgress";
import { attentionFieldsFor, originOf, provisionalClass } from "./scanReceipt/helpers";
import {
  FIELD_LABELS,
  SCAN_POLL_INTERVAL_MS,
  SCAN_POLL_TIMEOUT_MS,
  receiptUploadSelectionError,
} from "./scanReceipt/constants";
import type {
  AddedItem,
  Origin,
  ReceiptCaptureBatch,
  ReceiptDuplicateCandidate,
  ReceiptDuplicateCandidatePage,
  ReceiptDuplicateReason,
  ReceiptDuplicateReview,
  ReceiptPurgeJob,
  ReceiptHistoryPage,
  ReceiptHistoryItem,
  ScannedItem,
  ReceiptScanResult,
  ScanStage,
  Split,
} from "./scanReceipt/types";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { ResultDetails } from "../components/ResultDetails";
import { ReceiptResultNotes } from "./scanReceipt/ReceiptResultNotes";
import { randomId } from "../lib/uuid";
import { PrintedReceiptDetails } from "./scanReceipt/PrintedReceiptDetails";
import { ReceiptProviderConsent } from "./scanReceipt/ReceiptProviderConsent";
import { ReceiptPagePreview } from "./scanReceipt/ReceiptPagePreview";
import { useConfirm } from "../components/ConfirmDialog";
import {
  EMPTY_RECOVERY_HISTORY,
  appendOlderPage,
  reconcileFirstPage,
  recoveryRowNames,
  recoveryRowTitle,
  seedLocalScans,
  summaryFromScan,
  withoutScan,
  type RecoveryHistoryState,
} from "./scanReceipt/recoveryHistory";

interface BatchReceiptBinding {
  batchId: number;
  receiptOrdinal: number;
}

interface DuplicateReviewState extends Pick<
  ReceiptDuplicateReview,
  "candidateSetHash" | "candidates" | "candidateCount" | "nextCursor"
> {
  changed: boolean;
}

const DUPLICATE_REASON_COPY: Record<ReceiptDuplicateReason, string> = {
  EXACT_IMAGE: "same receipt image",
  SAME_VENDOR: "same merchant",
  SAME_DESCRIPTION: "same description",
  SAME_DATE: "same date",
  SAME_TOTAL: "same total",
};
const DUPLICATE_REASONS = new Set<ReceiptDuplicateReason>(Object.keys(DUPLICATE_REASON_COPY) as ReceiptDuplicateReason[]);

/**
 * A receipt batch response controls which private uploads are attached to a
 * selection. Do not trust its TypeScript annotation at the HTTP boundary.
 */
function isCollectingReceiptBatch(
  value: unknown,
  businessProfileId: number,
  expectedReceiptCount: number,
): value is ReceiptCaptureBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const batch = value as Record<string, unknown>;
  return Number.isInteger(batch.id)
    && Number(batch.id) > 0
    && batch.businessProfileId === businessProfileId
    && batch.expectedReceiptCount === expectedReceiptCount
    && batch.status === "COLLECTING"
    && batch.uploadedReceiptCount === 0
    && Array.isArray(batch.receipts)
    && batch.receipts.length === 0;
}

function isCancelledReceiptBatch(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { status?: unknown }).status === "CANCELLED");
}

/**
 * DELETE /records/receipts/:id answers 409 for more than one reason. Only the
 * "purge already running" one means the row is gone; a scan that already has
 * financial records, or a reused idempotency key, still needs the owner to read
 * the message.
 */
function isDeletionAlreadyUnderway(error: unknown): boolean {
  if (!isAxiosError(error) || error.response?.status !== 409) return false;
  const body = error.response.data as { error?: unknown; code?: unknown } | undefined;
  // The stable code is the contract; the message match keeps older servers working.
  return body?.code === "PURGE_IN_PROGRESS" || (typeof body?.error === "string" && /already being deleted/i.test(body.error));
}

/**
 * The confirm-time hash when a DUPLICATE_REVIEW_CHANGED answer names exactly the
 * acknowledged target records. Row ids move with the edited identity; targets do not.
 */
function sameMatchesHash(error: unknown, acknowledged: DuplicateReviewState): string | null {
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

function recoveryRowId(scanId: number): string {
  return `unfinished-scan-${scanId}`;
}

function recoveryRowActionId(scanId: number): string {
  return `${recoveryRowId(scanId)}-action`;
}

function scannedItemRowId(itemId: number): string {
  return `scanned-item-${itemId}`;
}

function scannedItemRemoveId(itemId: number): string {
  return `${scannedItemRowId(itemId)}-remove`;
}

/** The server binds an upload key to one batch slot or to a single receipt. */
function uploadBindingKey(batch?: BatchReceiptBinding): string {
  return batch ? `batch:${batch.batchId}:${batch.receiptOrdinal}` : "single";
}

function duplicateReviewFrom(value: unknown, changed = false): DuplicateReviewState | null {
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

export function ScanReceipt() {
  const { selected } = useBusinessProfiles();
  return <ScanReceiptForm key={selected?.id ?? "no-profile"} />;
}

function ScanReceiptForm() {
  const { selected } = useBusinessProfiles();
  const { categories, refresh: refreshCategories, createCategory } = useExpenseCategories();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const [reviewFiles, setReviewFiles] = useState<File[]>([]);
  const [scanning, setScanning] = useState(false);
  /**
   * Which stage of the read is actually happening right now.
   *
   * Four honest stages replacing one flat "Reading your receipt…". Every
   * transition below is tied to a real event — the upload responding, the
   * server's own processingStatus turning Complete, the category list coming
   * back — and NOT to a timer. There is deliberately no determinate bar: the
   * server reports no percentage, so any bar drawn here would be an animation
   * pretending to be a measurement, which is the specific thing ADR-4's
   * "never fake determinate progress" rule forbids.
   */
  const [scanStage, setScanStage] = useState<ScanStage>("uploading");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<ReceiptScanResult | null>(null);
  const [pausedScan, setPausedScan] = useState<ReceiptScanResult | null>(null);
  const [resumeHistory, setResumeHistory] = useState<RecoveryHistoryState>(EMPTY_RECOVERY_HISTORY);
  const resumeScans = resumeHistory.scans;
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeLoadingOlder, setResumeLoadingOlder] = useState(false);
  // A failed refresh offers a reload; a failed older page keeps its cursor,
  // so "Show older scans" is itself the retry.
  const [resumeError, setResumeError] = useState<{ message: string; failed: "refresh" | "older" } | null>(null);
  const [duplicateReview, setDuplicateReview] = useState<DuplicateReviewState | null>(null);
  const [duplicateLoading, setDuplicateLoading] = useState(false);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [deletingScanId, setDeletingScanId] = useState<number | null>(null);

  /**
   * Photos picked at the file-choosing stage, before scanning starts.
   *
   * Separate from `reviewFiles` above, which are the ordered photos of
   * whichever receipt is CURRENTLY being scanned or reviewed. `pickedFiles` is spent the moment
   * scanning starts — into the pages of one upload, or into the queue below —
   * and is never touched again until the owner returns to pick more.
   */
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const pickedFilesError = receiptUploadSelectionError([], pickedFiles);
  /**
   * How to treat more than one picked photo. Meaningless with one photo.
   *
   * Defaults to "separate" deliberately: a mis-click here still produces N
   * correctable records, whereas defaulting to "one" and being wrong would
   * silently merge unrelated receipts into a single one. Wrong-but-visible
   * beats wrong-but-hidden in bookkeeping.
   */
  const [combineChoice, setCombineChoice] = useState<"separate" | "one">("separate");
  /**
   * Photos still waiting to be scanned as their OWN receipt, when the owner
   * chose "separate receipts" for more than one photo. `handleConfirm` pops
   * the next one off this list instead of returning to an empty picker, so a
   * batch of receipts is reviewed one after another without extra clicks.
   */
  const [fileQueue, setFileQueue] = useState<File[]>([]);
  /** 1-based "which receipt is this" for a queued batch; 0 outside one. */
  const [queuePosition, setQueuePosition] = useState(0);
  const [queueTotal, setQueueTotal] = useState(0);
  /**
   * Receipts already confirmed earlier in this batch, so the owner reviewing
   * receipt 2 of 3 has a way to check receipt 1 again.
   *
   * WHY THIS EXISTS: confirming a receipt saves it and immediately advances
   * to the next one — by design, so a batch reviews as a sequence rather than
   * bouncing back to an empty picker between each. But that meant a receipt,
   * once confirmed, was simply gone from the screen with no way back to it
   * short of leaving the batch entirely to search Records. This is what
   * "confirmed" actually left behind: which position it was, and the record
   * ids Confirm created, so a link to it can be shown without abandoning the
   * receipt currently being reviewed.
   */
  const [queueHistory, setQueueHistory] = useState<{ position: number; recordIds: number[] }[]>([]);

  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  /**
   * How the receipt's total is divided between categories.
   *
   * One entry is the ordinary case and behaves exactly as the single Category
   * field used to — its amount is the receipt total, so it needs no amount
   * input of its own. A second entry turns on the split editor, because a
   * receipt that covers two categories can no longer be described by one.
   */
  const [splits, setSplits] = useState<Split[]>([{ categoryId: "", amount: "" }]);
  const isSplit = splits.length > 1;

  /**
   * The owner's category for each extracted item, keyed by item id.
   *
   * Seeded from what FinSight assigned automatically, then owned by the
   * owner — every row is editable and nothing is written until Confirm.
   */
  const [itemCategories, setItemCategories] = useState<Record<number, number | "">>({});
  /** The proposed category currently being created, so its row can show progress. */
  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);

  /** Lines the owner added because OCR missed them. */
  const [addedItems, setAddedItems] = useState<AddedItem[]>([]);
  /** The extracted line currently being deleted, so its row can show progress. */
  const [removingItemId, setRemovingItemId] = useState<number | null>(null);
  const [editingItem, setEditingItem] = useState<{ id: number; name: string; amount: number | "" } | null>(null);
  const [updatingItemId, setUpdatingItemId] = useState<number | null>(null);
  /** Their choice for whatever difference remains after any added lines. */
  const [gapPlan, setGapPlan] = useState<GapPlan>(null);
  /** The category for the "put it all in one category" plan. */
  const [gapCategoryId, setGapCategoryId] = useState<number | "">("");

  // Accepted scans and keys survive a stopped poll or transient request
  // failure, so retry resumes the stored scan instead of uploading twice.
  // An accepting promise is held separately from reading: a receipt batch must
  // finish storing every child before the first one is presented for review.
  // Keyed by File plus batch binding: the server ties an upload key and its
  // scan to one binding and answers 409 when the same key arrives bound differently.
  const acceptingScans = useRef<Map<File, { binding: string; promise: Promise<ReceiptScanResult> }>>(new Map());
  const acceptedScans = useRef<Map<File, { binding: string; scan: ReceiptScanResult }>>(new Map());
  const uploadKeys = useRef<Map<File, { binding: string; key: string }>>(new Map());
  const combinedUpload = useRef<{ files: File[]; key: string; scan?: ReceiptScanResult } | null>(null);
  const batchUpload = useRef<{
    clientBatchKey: string;
    expectedReceiptCount: number;
    id?: number;
  } | null>(null);
  const currentFiles = useRef<File[]>([]);
  const requests = useRef(new AbortController());
  // Kept apart from `requests`: handleStopWaiting aborts that one, and a
  // history refresh caught by it would never clear its loading state.
  const historyRequests = useRef(new AbortController());
  const duplicateRequests = useRef<AbortController | null>(null);
  const startPending = useRef(false);
  const savePending = useRef(false);
  const stopRequested = useRef(false);
  /** The unfinished-scans row being waited on, when the wait is not a local upload. */
  const waitingStoredScan = useRef<Pick<ReceiptHistoryItem, "id" | "extractedVendor" | "extractedDescription"> | null>(null);
  const deleteKeys = useRef<Map<number, string>>(new Map());
  // A history page requested before a delete can settle after it and put the row back.
  const purgedScanIds = useRef<Set<number>>(new Set());
  const [focusRowAfterDelete, setFocusRowAfterDelete] = useState<{ deletedScanId: number; nextScanId: number | null } | null>(null);
  const [focusItemAfterRemove, setFocusItemAfterRemove] = useState<{ removedItemId: number; nextItemId: number | null } | null>(null);

  useEffect(() => {
    requests.current = new AbortController();
    // Stop waiting swaps in a fresh controller, so the cleanup has to abort
    // whichever one is current at unmount, not the one made here.
    const live = requests;
    const history = historyRequests.current;
    const pending = acceptingScans.current;
    const accepted = acceptedScans.current;
    const keys = uploadKeys.current;
    return () => {
      live.current.abort();
      history.abort();
      pending.clear();
      accepted.clear();
      keys.clear();
    };
  }, []);

  const selectedBusinessProfileId = selected?.id;
  const refreshActiveReceiptHistory = useCallback(async (requestSignal?: AbortSignal, excludeScanId?: number) => {
    if (selectedBusinessProfileId === undefined) return;
    const signal = requestSignal ?? historyRequests.current.signal;
    setResumeLoading(true);
    setResumeError(null);
    try {
      const { data } = await api.get<ReceiptHistoryPage>("/records/receipts", {
        params: { businessProfileId: selectedBusinessProfileId, status: "active", take: 20 },
        signal,
      });
      signal.throwIfAborted();
      const purged = purgedScanIds.current;
      const page = {
        ...data,
        items: data.items.filter((candidate) => candidate.id !== excludeScanId && !purged.has(candidate.id)),
      };
      setResumeHistory((current) => reconcileFirstPage(current, page));
    } catch (error) {
      if (!signal.aborted) setResumeError({ message: getErrorMessage(error), failed: "refresh" });
    } finally {
      if (!signal.aborted) setResumeLoading(false);
    }
  }, [selectedBusinessProfileId]);

  const resumeCursor = resumeHistory.nextCursor;
  async function loadOlderReceiptHistory() {
    if (selectedBusinessProfileId === undefined || resumeCursor === null || resumeLoading || resumeLoadingOlder) return;
    const signal = historyRequests.current.signal;
    setResumeLoadingOlder(true);
    setResumeError(null);
    try {
      const { data } = await api.get<ReceiptHistoryPage>("/records/receipts", {
        params: { businessProfileId: selectedBusinessProfileId, status: "active", take: 20, cursor: resumeCursor },
        signal,
      });
      signal.throwIfAborted();
      const purged = purgedScanIds.current;
      setResumeHistory((current) => appendOlderPage(current, {
        ...data,
        items: data.items.filter((candidate) => !purged.has(candidate.id)),
      }));
    } catch (error) {
      if (!signal.aborted) setResumeError({ message: getErrorMessage(error), failed: "older" });
    } finally {
      if (!signal.aborted) setResumeLoadingOlder(false);
    }
  }

  useEffect(() => {
    if (selectedBusinessProfileId === undefined) return;
    const controller = new AbortController();
    void refreshActiveReceiptHistory(controller.signal);
    return () => controller.abort();
  }, [refreshActiveReceiptHistory, selectedBusinessProfileId]);

  const duplicateScanId = scan?.id;
  const duplicateScanStatus = scan?.processingStatus;
  useEffect(() => {
    if (duplicateScanId === undefined || duplicateScanStatus !== "Complete") {
      duplicateRequests.current?.abort();
      duplicateRequests.current = null;
      setDuplicateReview(null);
      setDuplicateAcknowledged(false);
      setDuplicateLoading(false);
      return;
    }
    duplicateRequests.current?.abort();
    const controller = new AbortController();
    duplicateRequests.current = controller;
    setDuplicateReview(null);
    setDuplicateAcknowledged(false);
    setDuplicateLoading(true);
    void api.get<ReceiptDuplicateCandidatePage>(`/records/receipts/${duplicateScanId}/duplicate-candidates`, {
      params: { take: 50 },
      signal: controller.signal,
    }).then(({ data }) => {
      if (!controller.signal.aborted) setDuplicateReview(duplicateReviewFrom(data));
    }).catch(() => {
      // Confirmation performs the authoritative locked recheck. A failed
      // preview request must not discard the owner's review edits.
    }).finally(() => {
      if (!controller.signal.aborted) setDuplicateLoading(false);
    });
    return () => {
      controller.abort();
      if (duplicateRequests.current === controller) duplicateRequests.current = null;
    };
  }, [duplicateScanId, duplicateScanStatus]);

  const duplicateListComplete = duplicateReview === null
    || (duplicateReview.nextCursor === null
      && duplicateReview.candidates.length === duplicateReview.candidateCount);

  async function loadMoreDuplicateCandidates() {
    if (!scan || !duplicateReview?.nextCursor || duplicateLoading) return;
    const current = duplicateReview;
    const signal = duplicateRequests.current?.signal;
    if (!signal || signal.aborted) return;
    setDuplicateLoading(true);
    setConfirmError(null);
    try {
      const { data } = await api.get<ReceiptDuplicateCandidatePage>(
        `/records/receipts/${scan.id}/duplicate-candidates`,
        { params: { cursor: current.nextCursor, take: 50 }, signal },
      );
      signal.throwIfAborted();
      const page = duplicateReviewFrom(data, current.changed);
      if (!page) {
        setDuplicateReview(null);
        setDuplicateAcknowledged(false);
        return;
      }
      if (page.candidateSetHash !== current.candidateSetHash) {
        const fresh = await api.get<ReceiptDuplicateCandidatePage>(
          `/records/receipts/${scan.id}/duplicate-candidates`,
          { params: { take: 50 }, signal },
        );
        signal.throwIfAborted();
        setDuplicateReview(duplicateReviewFrom(fresh.data, true));
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
      setDuplicateAcknowledged(false);
    } catch {
      if (!signal.aborted) {
        setConfirmError("FinSight could not load every possible match. Try loading the list again before saving.");
      }
    } finally {
      if (!signal.aborted) setDuplicateLoading(false);
    }
  }

  /**
   * Focus lands on the first field that needs a decision.
   *
   * "Check a few fields" that leaves the keyboard at the top of the form makes
   * the owner hunt for what it meant. Only ever moves focus when there IS
   * something to check — a clean read leaves focus alone, because taking it
   * for no reason is its own accessibility problem. Keyed on the scan id, so
   * it happens once per receipt rather than on every keystroke.
   */
  const attentionFocusedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!scan) return;
    // Once per receipt. Every item save or 409 refresh replaces the scan
    // object, and moving focus back to the top on each would throw a keyboard
    // user out of the item they were editing.
    if (attentionFocusedFor.current === scan.id) return;
    attentionFocusedFor.current = scan.id;
    const first = attentionFieldsFor(scan)[0];
    if (!first) return;
    // The Field wrapper puts its `htmlFor` straight onto the control, so the
    // field's own name is the element id.
    const el = document.getElementById(first);
    if (el instanceof HTMLElement) el.focus({ preventScroll: false });
  }, [scan]);

  useEffect(() => {
    const item = scan?.items.length === 1 ? scan.items[0] : null;
    if (item?.categoryId === null || item?.categoryId === undefined) return;
    const categoryId = item.categoryId;
    const category = categories.find((candidate) => candidate.id === categoryId);
    if (!category || category.name.toLowerCase() === "uncategorized") return;
    setSplits((current) =>
      current.length === 1 && current[0]!.categoryId === ""
        ? [{ categoryId, amount: "" }]
        : current,
    );
  }, [categories, scan]);

  useEffect(() => {
    if (!focusRowAfterDelete) return;
    setFocusRowAfterDelete(null);
    const { deletedScanId, nextScanId } = focusRowAfterDelete;
    // The delete took a round trip. If the owner has moved on to a form field
    // meanwhile, taking focus away from it would undo their keystroke.
    const active = document.activeElement;
    const focusLostWithRow = !active
      || active === document.body
      || active.closest(`#${recoveryRowId(deletedScanId)}`) !== null;
    if (!focusLostWithRow) return;
    // Next row's action, or the photo picker once the list is empty.
    const next = nextScanId === null ? null : document.getElementById(recoveryRowActionId(nextScanId));
    (next ?? document.getElementById("receipt-files"))?.focus();
  }, [focusRowAfterDelete]);

  // Same problem one table down: the × unmounts with its row, so without this
  // a keyboard user is dropped onto <body> after every removal.
  useEffect(() => {
    if (!focusItemAfterRemove) return;
    setFocusItemAfterRemove(null);
    const { removedItemId, nextItemId } = focusItemAfterRemove;
    const active = document.activeElement;
    const focusLostWithRow = !active
      || active === document.body
      || active.closest(`#${scannedItemRowId(removedItemId)}`) !== null;
    if (!focusLostWithRow) return;
    // The neighbouring row's × if any line is left, otherwise the Amount
    // field — the item table is gone once it empties.
    const next = nextItemId === null ? null : document.getElementById(scannedItemRemoveId(nextItemId));
    (next ?? document.getElementById("amount"))?.focus();
  }, [focusItemAfterRemove]);

  if (!selected) return <NoBusinessProfile />;

  async function ensureReceiptBatch(expectedReceiptCount: number): Promise<number> {
    let pending = batchUpload.current;
    if (!pending || pending.expectedReceiptCount !== expectedReceiptCount) {
      pending = { clientBatchKey: randomId(), expectedReceiptCount };
      batchUpload.current = pending;
    }
    if (pending.id !== undefined) return pending.id;

    const create = async () => {
      const { data } = await api.post<ReceiptCaptureBatch>("/records/receipt-batches", {
        businessProfileId: selected!.id,
        clientBatchKey: pending!.clientBatchKey,
        expectedReceiptCount,
      }, { signal: requests.current.signal });
      return data;
    };

    let data = await create();
    // A timed-out create can replay a batch that was cancelled before the
    // browser received its first response. Replace that stale key once; a
    // second CANCELLED response is rejected by the validation below.
    if (isCancelledReceiptBatch(data)) {
      pending = { clientBatchKey: randomId(), expectedReceiptCount };
      batchUpload.current = pending;
      data = await create();
    }
    if (!isCollectingReceiptBatch(data, selected!.id, expectedReceiptCount)) {
      if (batchUpload.current === pending) batchUpload.current = null;
      throw new Error("This receipt batch no longer matches the selected images.");
    }
    pending.id = data.id;
    return data.id;
  }

  function ensureAccepted(file: File, batch?: BatchReceiptBinding): Promise<ReceiptScanResult> {
    const binding = uploadBindingKey(batch);
    const accepted = acceptedScans.current.get(file);
    if (accepted?.binding === binding) return Promise.resolve(accepted.scan);
    const existing = acceptingScans.current.get(file);
    if (existing?.binding === binding) return existing.promise;

    const promise = (async () => {
      const signal = requests.current.signal;
      const formData = new FormData();
      formData.append("files", file);
      formData.append("businessProfileId", String(selected!.id));
      let upload = uploadKeys.current.get(file);
      if (upload?.binding !== binding) {
        upload = { binding, key: randomId() };
        uploadKeys.current.set(file, upload);
      }
      formData.append("idempotencyKey", upload.key);
      if (batch) {
        formData.append("receiptBatchId", String(batch.batchId));
        formData.append("receiptOrdinal", String(batch.receiptOrdinal));
      }
      const { data } = await api.post<ReceiptScanResult>("/records/receipts", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        signal,
      });
      signal.throwIfAborted();
      acceptedScans.current.set(file, { binding, scan: data });
      return data;
    })();
    acceptingScans.current.set(file, { binding, promise });
    const settle = () => {
      if (acceptingScans.current.get(file)?.promise === promise) acceptingScans.current.delete(file);
    };
    void promise.then(settle, settle);
    return promise;
  }

  async function ensureScanned(file: File, batch?: BatchReceiptBinding): Promise<ReceiptScanResult> {
    const accepted = await ensureAccepted(file, batch);
    // The photos are on the server. Whether OCR has started is the server's
    // business; what the client knows is that the upload is over.
    setScanStage("reading");
    return pollUntilRead(accepted, requests.current.signal);
  }

  /**
   * Persists a separate-receipt batch one child at a time before review begins.
   *
   * A browser cannot restore chosen File handles after reload, so queuing only
   * local files made every child after the first disappear from an interrupted
   * batch. The server already owns ordinal/idempotency semantics; accepting
   * sequentially keeps memory and request pressure bounded while making every
   * child visible to history-based resume as soon as the first review opens.
   */
  async function acceptBatchFiles(files: File[], batchId: number): Promise<void> {
    const signal = requests.current.signal;
    currentFiles.current = files;
    setScanning(true);
    setScanStage("uploading");
    setScanError(null);
    try {
      for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        await ensureAccepted(file, { batchId, receiptOrdinal: index + 1 });
      }
      signal.throwIfAborted();
    } catch (error) {
      if (!signal.aborted) setPickedFiles(files);
      throw error;
    } finally {
      if (!signal.aborted) setScanning(false);
    }
  }

  /** Polls an accepted scan until it is complete, failed, or times out locally. */
  async function pollUntilRead(
    initial: ReceiptScanResult,
    signal = requests.current.signal,
  ): Promise<ReceiptScanResult> {
    signal.throwIfAborted();
    if (initial.processingStatus && initial.processingStatus !== "Processing") {
      return initial;
    }

    const deadline = Date.now() + SCAN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_INTERVAL_MS));
      signal.throwIfAborted();
      const { data } = await api.get<ReceiptScanResult>(`/records/receipts/${initial.id}`, { signal });
      if (data.processingStatus === "Failed") return data;
      if (data.processingStatus === "Complete") return data;
    }
    /*
     * A scan that never finishes is a real possibility, not a hypothetical:
     * the durable worker may be recovering from a provider outage. Giving up
     * visibly is better than polling forever behind a spinner; the server
     * keeps the queued scan and can still finish it after this screen stops.
     */
    throw new Error("This receipt is taking longer than expected to read. Try scanning it again.");
  }

  async function presentCompletedScan(data: ReceiptScanResult, signal: AbortSignal) {
    setScanStage("checking");
    await refreshCategories();
    signal.throwIfAborted();
    setScanStage("categorising");
    setScan(data);
    setDate(data.extractedDate ? data.extractedDate.slice(0, 10) : "");
    setDescription(data.extractedDescription ?? "");
    setVendor(data.extractedVendor ?? "");
    setAmount(data.extractedAmount ?? "");
    setItemCategories(Object.fromEntries(data.items.map((item) => [item.id, item.categoryId ?? ""])));
    setSplits([{ categoryId: "", amount: "" }]);
  }

  /** Uploads one receipt, retaining its ordered local pages for review. */
  async function scanFiles(filesToSend: File[], batch?: BatchReceiptBinding) {
    const signal = requests.current.signal;
    currentFiles.current = filesToSend;
    setReviewFiles(filesToSend);
    setScanning(true);
    setScanStage("uploading");
    setScanError(null);
    try {
      // Single-photo retries use the accepted-scan cache. A multi-page receipt
      // keeps one combined upload key and one accepted scan for the same reason.
      const data =
        filesToSend.length === 1
          ? await ensureScanned(filesToSend[0]!, batch)
          : await (async () => {
              if (!combinedUpload.current || combinedUpload.current.files.length !== filesToSend.length ||
                  combinedUpload.current.files.some((file, index) => file !== filesToSend[index])) {
                combinedUpload.current = { files: filesToSend, key: randomId() };
              }
              const upload = combinedUpload.current;
              if (upload.scan) return pollUntilRead(upload.scan, signal);
              const formData = new FormData();
              // "files" — plural — even for one photo: the server has one
              // upload route for both shapes, and it reads this field name
              // for either.
              filesToSend.forEach((f) => formData.append("files", f));
              formData.append("businessProfileId", String(selected!.id));
              formData.append("idempotencyKey", upload.key);
              const res = await api.post<ReceiptScanResult>("/records/receipts", formData, {
                headers: { "Content-Type": "multipart/form-data" },
                signal,
              });
              signal.throwIfAborted();
              upload.scan = res.data;
              setScanStage("reading");
              // Polled here too, not only in ensureScanned: this branch is a
              // multi-page receipt, which is the SLOWEST read there is (up to
              // MAX_RECEIPT_FILES pages of OCR). It has no single File to key
              // the promise cache on, which is the only reason it bypasses
              // that path — the waiting is identical.
              return pollUntilRead(res.data, signal);
            })();
      signal.throwIfAborted();
      setPausedScan(null);
      if (data.processingStatus === "Failed") {
        setScan(data);
        return data;
      }
      await presentCompletedScan(data, signal);
    } catch (err) {
      if (!signal.aborted) {
        setPickedFiles(filesToSend);
        setScanError(getErrorMessage(err));
      }
      throw err;
    } finally {
      if (!signal.aborted) setScanning(false);
    }
  }

  /**
   * Turns the picked photos into a scanning plan and starts it.
   *
   * One photo, or "one long receipt" chosen for several: every photo becomes
   * a page of ONE upload. "Separate receipts" instead: every child is first
   * accepted in ordinal order, then `fileQueue` advances the local review
   * sequence one receipt at a time. That keeps the review focused without
   * making a reload lose a child that had not yet reached the screen.
   */
  async function handleStartScanning(e: FormEvent) {
    e.preventDefault();
    if (pickedFiles.length === 0 || startPending.current) return;
    const selectionError = receiptUploadSelectionError([], pickedFiles);
    if (selectionError) {
      setScanError(selectionError);
      return;
    }
    startPending.current = true;
    stopRequested.current = false;
    try {
      const existingBatchId = batchUpload.current?.id;
      if (queueTotal > 0 && existingBatchId !== undefined && pickedFiles.length === queueTotal) {
        const [first, ...rest] = pickedFiles;
        setPickedFiles([]);
        setFileQueue(rest);
        setQueuePosition(1);
        await acceptBatchFiles(pickedFiles, existingBatchId);
        await scanFiles([first!], { batchId: existingBatchId, receiptOrdinal: 1 });
        return;
      }

      if (queueTotal > 0 && existingBatchId !== undefined && pickedFiles.length === 1) {
        const toScan = pickedFiles;
        setPickedFiles([]);
        await scanFiles(toScan, { batchId: existingBatchId, receiptOrdinal: queuePosition });
        return;
      }

      if (pickedFiles.length === 1 || combineChoice === "one") {
        const toScan = pickedFiles;
        setPickedFiles([]);
        await scanFiles(toScan);
        return;
      }

      const selectedFiles = pickedFiles;
      const [first, ...rest] = selectedFiles;
      const batchId = await ensureReceiptBatch(selectedFiles.length);
      setPickedFiles([]);
      setFileQueue(rest);
      setQueuePosition(1);
      setQueueTotal(selectedFiles.length);

      // Accept every child in ordinal order before showing the first review.
      // The work remains sequential, not an unbounded fan-out, and a reload
      // can then rediscover every accepted child from receipt history.
      await acceptBatchFiles(selectedFiles, batchId);
      await scanFiles([first!], { batchId, receiptOrdinal: 1 });
    } catch (err) {
      if (!stopRequested.current) setScanError(getErrorMessage(err));
    } finally {
      startPending.current = false;
    }
  }

  function handleStopWaiting() {
    stopRequested.current = true;
    requests.current.abort();
    requests.current = new AbortController();
    currentFiles.current.forEach((file) => acceptingScans.current.delete(file));

    const stored = waitingStoredScan.current;
    if (stored) {
      // Nothing local was sent, so the picked photos and any paused upload stay put.
      waitingStoredScan.current = null;
      setScanning(false);
      setScanError(`Stopped waiting. ${recoveryRowTitle(stored)} stays in unfinished scans.`);
      return;
    }

    const accepted = currentFiles.current.length === 1
      ? acceptedScans.current.get(currentFiles.current[0]!)?.scan
      : combinedUpload.current?.scan
        ?? currentFiles.current.map((file) => acceptedScans.current.get(file)?.scan).find(Boolean);
    setPausedScan(accepted ?? null);
    setPickedFiles(currentFiles.current);
    setScanning(false);
    setScanError(
      accepted
        ? "Stopped waiting. Your upload is safe and can be checked again."
        : "Upload cancelled. Your selected image is still here.",
    );
  }

  async function retryProcessing() {
    if (!scan || scan.processingStatus !== "Failed") return;
    const signal = requests.current.signal;
    // A Failed scan opened from unfinished scans has no local photos; Stop
    // waiting must then leave the row where it is rather than "cancel an upload".
    if (currentFiles.current.length === 0) waitingStoredScan.current = scan;
    setScanning(true);
    setScanStage("reading");
    setScanError(null);
    try {
      const { data: queued } = await api.post<ReceiptScanResult>(
        `/records/receipts/${scan.id}/retry`,
        undefined,
        { signal },
      );
      const result = await pollUntilRead(queued, signal);
      signal.throwIfAborted();
      if (result.processingStatus === "Failed") {
        setScan(result);
        return;
      }
      await presentCompletedScan(result, signal);
    } catch (err) {
      if (!signal.aborted) setScanError(getErrorMessage(err));
    } finally {
      if (!signal.aborted) {
        waitingStoredScan.current = null;
        setScanning(false);
      }
    }
  }

  async function openStoredScan(summary: ReceiptHistoryItem) {
    const signal = requests.current.signal;
    waitingStoredScan.current = summary;
    setScanning(true);
    setScanStage(summary.allowedActions.retryProcessing ? "reading" : "checking");
    setScanError(null);
    setReviewFiles([]);
    currentFiles.current = [];
    try {
      const response = summary.allowedActions.retryProcessing
        ? await api.post<ReceiptScanResult>(`/records/receipts/${summary.id}/retry`, undefined, { signal })
        : await api.get<ReceiptScanResult>(`/records/receipts/${summary.id}`, { signal });
      const result = response.data.processingStatus === "Processing"
        ? await pollUntilRead(response.data, signal)
        : response.data;
      signal.throwIfAborted();
      if (result.processingStatus === "Failed") {
        setScan(result);
        return;
      }
      await presentCompletedScan(result, signal);
    } catch (err) {
      if (!signal.aborted) setScanError(getErrorMessage(err));
    } finally {
      if (!signal.aborted) {
        waitingStoredScan.current = null;
        setScanning(false);
      }
    }
  }

  async function deleteUnconfirmedScan(target: Pick<ReceiptHistoryItem, "id" | "extractedVendor" | "extractedDescription">) {
    if (deletingScanId !== null) return;
    const label = target.extractedVendor ?? target.extractedDescription ?? `scan ${target.id}`;
    const approved = await confirm({
      title: `Delete ${label}?`,
      body: "This removes the unfinished scan from review and queues its private receipt files for deletion. It cannot be undone.",
      confirmLabel: "Delete scan",
      tone: "danger",
    });
    if (!approved) return;

    let key = deleteKeys.current.get(target.id);
    if (!key) {
      key = randomId();
      deleteKeys.current.set(target.id, key);
    }

    setDeletingScanId(target.id);
    setScanError(null);
    try {
      const { data: job } = await api.delete<ReceiptPurgeJob>(`/records/receipts/${target.id}`, {
        headers: { "Idempotency-Key": key },
      });
      if (job.receiptScanId !== target.id || !Number.isInteger(job.id)) {
        throw new Error("FinSight returned a deletion result that did not match this receipt scan.");
      }
      deleteKeys.current.delete(target.id);
      purgedScanIds.current.add(target.id);
      const rowIndex = resumeScans.findIndex((row) => row.id === target.id);
      const neighbour = rowIndex === -1
        ? null
        : resumeScans[rowIndex + 1] ?? resumeScans[rowIndex - 1] ?? null;
      setResumeHistory((current) => withoutScan(current, target.id));

      if (scan?.id === target.id) {
        const wasBatchChild = scan.receiptBatchId !== null && scan.receiptBatchId !== undefined;
        resetScanSession();
        // Every batch child was accepted before review. Re-queuing local Files
        // here would upload those same stored scans again and strand their
        // original pending reviews. History is the durable continuation path.
        await refreshActiveReceiptHistory(undefined, target.id);
        toast(wasBatchChild
          ? "Scan removed. This batch is no longer continuing here; accepted receipts remain in unfinished scans."
          : "Scan removed. Its private files will be deleted in the background.");
        return;
      }
      // The focused Delete button unmounts with its row; otherwise focus drops to <body>.
      setFocusRowAfterDelete({ deletedScanId: target.id, nextScanId: neighbour?.id ?? null });
      toast("Scan removed. Its private files will be deleted in the background.");
    } catch (error) {
      if (isDeletionAlreadyUnderway(error)) {
        // Another tab or an earlier retry won the delete. The purge is running,
        // so the row is as gone as a fresh 200 would have made it; keeping it
        // with an error would invite a third attempt at the same thing.
        deleteKeys.current.delete(target.id);
        purgedScanIds.current.add(target.id);
        const rowIndex = resumeScans.findIndex((row) => row.id === target.id);
        const neighbour = rowIndex === -1
          ? null
          : resumeScans[rowIndex + 1] ?? resumeScans[rowIndex - 1] ?? null;
        setResumeHistory((current) => withoutScan(current, target.id));
        if (scan?.id === target.id) resetScanSession();
        else setFocusRowAfterDelete({ deletedScanId: target.id, nextScanId: neighbour?.id ?? null });
        toast("This scan is already being deleted. Its private files will be deleted in the background.");
        return;
      }
      setScanError(getErrorMessage(error));
    } finally {
      setDeletingScanId(null);
    }
  }


  /**
   * Accepts a category FinSight proposed for items nothing existing fitted.
   *
   * Creates it, then files every UNPLACED row FinSight proposed it for — not
   * only the row that was clicked. A grocery run proposes "Packaging" on all
   * four packaging lines, and making the owner create it once and then assign
   * it three more times by hand would be busywork on a decision they have
   * just made. Rows they have already placed themselves are left alone, and
   * every row stays editable afterwards.
   */
  async function acceptSuggestedCategory(name: string) {
    setCreatingCategoryFor(name);
    setConfirmError(null);
    try {
      const created = await createCategory({ name });
      setItemCategories((prev) => {
        const next = { ...prev };
        for (const item of items) {
          const isUnplaced = next[item.id] === "" || next[item.id] === undefined || next[item.id] === uncategorisedId;
          if (isUnplaced && item.suggestedCategoryName?.toLowerCase() === name.toLowerCase()) {
            next[item.id] = created.id;
          }
        }
        return next;
      });
      toast(`Category "${created.name}" created`);
    } catch {
      setConfirmError(`Couldn't create the category "${name}". Try again, or pick one from the list.`);
    } finally {
      setCreatingCategoryFor(null);
    }
  }

  async function finishConfirmedReceipt(saved: { id: number }[] | null) {
    if (saved) {
      toast(saved.length === 1 ? "Expense saved from receipt" : `${saved.length} expenses saved from receipt`);
    } else {
      toast("Receipt was saved before the connection ended.");
    }

    if (fileQueue.length > 0) {
      setQueueHistory((prev) => [...prev, { position: queuePosition, recordIds: saved?.map((record) => record.id) ?? [] }]);
      const [next, ...rest] = fileQueue;
      resetReviewFields();
      setFileQueue(rest);
      setQueuePosition((position) => position + 1);
      try {
        await scanFiles([next!], {
          batchId: batchUpload.current!.id!,
          receiptOrdinal: queuePosition + 1,
        });
      } catch {
        // The confirmed receipt remains saved; its next batch slot can be retried.
      }
      return;
    }
    if (queueTotal > 0) {
      setQueuePosition(0);
      setQueueTotal(0);
      batchUpload.current = null;
    }
    navigate("/records");
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (!scan || amount === "" || !readyToConfirm || savePending.current || foreignCurrency) return;
    if (duplicateReview && (!duplicateListComplete || !duplicateAcknowledged)) {
      setConfirmError(duplicateListComplete
        ? "Review the possible matches and choose whether to save this receipt anyway."
        : "Load and review every possible match before saving this receipt anyway.");
      return;
    }
    savePending.current = true;
    const signal = requests.current.signal;
    setConfirming(true);
    setConfirmError(null);
    const acknowledged = duplicateReview && duplicateListComplete && duplicateAcknowledged
      ? duplicateReview
      : null;
    const send = (candidateSetHash: string | null) => api.post(
      `/records/receipts/${scan.id}/confirm`,
      // Two shapes, one endpoint — both built in lib/receiptConfirm, where
      // they are tested against the server's real schema. This request is the
      // one that silently broke against it on mobile.
      buildReceiptConfirmPayload({
        expectedScanRevision: scan.scanRevision,
        ...(candidateSetHash === null
          ? {}
          : { duplicateDecision: { action: "SAVE_ANYWAY" as const, candidateSetHash } }),
        date,
        description,
        vendor,
        amount: Number(amount),
        isItemised,
        itemAssignments: items.map((i) => ({ itemId: i.id, categoryId: Number(itemCategories[i.id]) })),
        additionalItems: addedItems.map((a) => ({
          name: a.name.trim(),
          amount: Number(a.amount),
          categoryId: Number(a.categoryId),
        })),
        itemsTotal: itemsTotalCentavos / 100,
        gapPlan,
        gapCategoryId: gapCategoryId === "" ? null : gapCategoryId,
        splits: splits.map((s) => ({
          categoryId: Number(s.categoryId),
          amount: Number(isSplit ? s.amount : amount),
        })),
      }),
      { signal },
    );
    try {
      let records;
      try {
        records = await send(acknowledged?.candidateSetHash ?? null);
      } catch (err) {
        // The set hash covers the confirm-time identity, so a field edit changes it
        // even when the matches are the same records the owner already acknowledged.
        const retryHash = acknowledged && !signal.aborted ? sameMatchesHash(err, acknowledged) : null;
        if (retryHash === null) throw err;
        records = await send(retryHash);
      }
      signal.throwIfAborted();
      const saved = records.data as { id: number }[];
      await finishConfirmedReceipt(saved);
    } catch (err) {
      if (!signal.aborted && isAxiosError(err) && err.response?.status === 409) {
        const body = err.response.data as Partial<ReceiptDuplicateReview> | undefined;
        if (body?.code === "DUPLICATE_REVIEW_REQUIRED" || body?.code === "DUPLICATE_REVIEW_CHANGED") {
          const review = duplicateReviewFrom(body, body.code === "DUPLICATE_REVIEW_CHANGED");
          if (review) {
            setDuplicateReview(review);
            setDuplicateAcknowledged(false);
            setConfirmError(null);
            return;
          }
        }
      }
      const status = isAxiosError(err) ? err.response?.status : undefined;
      if (!signal.aborted && (status === undefined || status === 409 || status >= 500)) {
        try {
          const latest = await api.get<ReceiptScanResult>(`/records/receipts/${scan.id}`, { signal });
          signal.throwIfAborted();
          if (latest.data.id === scan.id && latest.data.confirmationStatus === "Confirmed") {
            await finishConfirmedReceipt(null);
            return;
          }
          if (status === 409 && latest.data.id === scan.id) {
            // The receipt moved on under this review. Take the newer revision
            // so the next Save can succeed; the owner's field edits stay put.
            setScan((current) => (current?.id === latest.data.id ? latest.data : current));
            setConfirmError("This receipt changed while you were reviewing it. The latest version is shown; check it and save again.");
            return;
          }
        } catch {
          // Keep the original confirmation error when its outcome cannot be resolved.
        }
      }
      if (!signal.aborted) setConfirmError(getErrorMessage(err));
    } finally {
      savePending.current = false;
      if (!signal.aborted) setConfirming(false);
    }
  }

  /** Clears one review without changing the remaining batch queue. */
  function resetReviewFields() {
    setScan(null);
    setPausedScan(null);
    setSplits([{ categoryId: "", amount: "" }]);
    setItemCategories({});
    setCreatingCategoryFor(null);
    setAddedItems([]);
    setEditingItem(null);
    setUpdatingItemId(null);
    setGapPlan(null);
    setGapCategoryId("");
    setDate("");
    setDescription("");
    setVendor("");
    setAmount("");
    setConfirmError(null);
    setScanError(null);
    setDuplicateReview(null);
    setDuplicateLoading(false);
    setDuplicateAcknowledged(false);
  }

  /**
   * Abandons the local selection and any unfinished separate-receipt queue.
   * The scans left behind are still pending on the server, so they enter the
   * unfinished list at once; a refresh then reconciles them.
   */
  function handleRescan() {
    const abandoned: ReceiptScanResult[] = [];
    if (scan && scan.confirmationStatus !== "Confirmed") abandoned.push(scan);
    for (const file of fileQueue) {
      const accepted = acceptedScans.current.get(file)?.scan;
      if (accepted && !abandoned.some((row) => row.id === accepted.id)) abandoned.push(accepted);
    }
    resetScanSession();
    if (selectedBusinessProfileId === undefined || abandoned.length === 0) return;
    const now = new Date().toISOString();
    setResumeHistory((current) => seedLocalScans(
      current,
      abandoned.map((row) => summaryFromScan(row, selectedBusinessProfileId, now)),
    ));
    void refreshActiveReceiptHistory();
  }

  /** Clears the review and the batch queue without touching history. */
  function resetScanSession() {
    resetReviewFields();
    setPickedFiles([]);
    setFileQueue([]);
    setQueuePosition(0);
    setQueueTotal(0);
    setQueueHistory([]);
    batchUpload.current = null;
    currentFiles.current = [];
    acceptingScans.current.clear();
    acceptedScans.current.clear();
    uploadKeys.current.clear();
    combinedUpload.current = null;
  }

  // OCR never reads a description. The backend synthesises one from the vendor
  // ("Purchase from X") and falls back to the literal "Receipt purchase" when
  // it found no vendor — which means a null check would call that fallback a
  // successful read. Treating it as "not found" is the honest reading, and it
  // is what prompts the owner to write something meaningful.
  const descriptionOrigin: Origin =
    scan?.extractedDescription === "Receipt purchase"
      ? description === ""
        ? "missing"
        : "edited"
      : description === scan?.extractedDescription
        ? "derived"
        : "edited";

  /*
    Reconciliation, in centavos.

    Mirrors the server's check (receiptScan.service) exactly, so the button
    enables precisely when the request would be accepted — computed in whole
    centavos for the same reason: 1200.10 + 800.20 is not 2000.30 in binary
    floating point, and an owner whose split is right must never be told it
    isn't.
  */
  const totalCentavos = amount === "" ? 0 : Math.round(amount * 100);
  const allocatedCentavos = isSplit
    ? splits.reduce((sum, s) => sum + (s.amount === "" ? 0 : Math.round(s.amount * 100)), 0)
    : totalCentavos;
  const unallocatedCentavos = totalCentavos - allocatedCentavos;
  const everySplitHasCategory = splits.every((s) => s.categoryId !== "");
  const splitsAreComplete = everySplitHasCategory && (!isSplit || unallocatedCentavos === 0);

  function updateSplit(index: number, patch: Partial<Split>) {
    setSplits((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addSplit() {
    setSplits((prev): Split[] => {
      // Turning one category into two: the first row inherits the total it
      // already implicitly had, and the new row starts on whatever is left.
      const seeded: Split[] = prev.length === 1 ? [{ ...prev[0]!, amount }] : prev;
      return [...seeded, { categoryId: "", amount: "" }];
    });
  }

  function removeSplit(index: number) {
    setSplits((prev): Split[] => {
      const next = prev.filter((_, i) => i !== index);
      // Back to a single category — drop its amount so it re-inherits the total.
      return next.length === 1 ? [{ ...next[0]!, amount: "" }] : next;
    });
  }

  /*
   * The itemised path.
   *
   * A receipt with more than one extractable line is reviewed item by item;
   * anything less keeps the single-category flow exactly as it was. One item
   * is not a "split" — showing a grouping UI for it would be ceremony around
   * a decision the single Category dropdown already makes.
   */
  const items = scan?.items ?? [];
  const isItemised = items.length > 1;
  /** True when the item lines came from AI reading the photo, not from OCR text. */
  const itemsAreFromPhoto = items.some((i) => i.extractedByVision);
  const hasHistoryCategoryMatches = items.some((item) => {
    if (item.categoryId === null) return false;
    const category = categories.find((candidate) => candidate.id === item.categoryId);
    return Boolean(category && category.name.toLowerCase() !== "uncategorized");
  });

  /**
   * The one confidence cue this screen shows, resolved from the page reading,
   * every item amount and whether a model was involved. See
   * lib/confidenceBands.ts for why the cutoffs are what they are.
   */
  const receiptBand = scanConfidenceBand(scan ?? {});
  const attentionFields = attentionFieldsFor(scan);

  /*
   * Warnings split by tone so the amber ones can share a single callout. One
   * card per code stacked six full-width amber boxes above the fields on a
   * poor photo, which reads as a wall rather than as six things to check.
   * The informational ones stay separate: OVERLAPPING_PAGES is a note about
   * the capture the guide asked for, not a problem, and folding it into a
   * list of problems would make it read as one.
   */
  const allWarnings = scan?.warnings ?? [];
  const foreignCurrency = scan?.receiptDetails?.currency && scan.receiptDetails.currency !== "PHP"
    ? scan.receiptDetails.currency : scan?.requiresManualCurrencyConversion ? "another currency" : null;

  /**
   * Items grouped by the category the owner currently has them in, with a
   * subtotal each. Recomputed on every render, so moving one row between
   * categories updates both subtotals immediately — there is no separate
   * state to fall out of step with the rows.
   */
  /**
   * Extracted lines and owner-added lines, in one list.
   *
   * Everything downstream — the subtotals, the gap, whether Confirm is
   * enabled — works off this rather than off `items`, so an added line counts
   * the moment it is complete instead of only after saving.
   */
  // All of the review arithmetic lives in lib/receiptReview, where it can be
  // tested on its own — it decides how this receipt's money is split across
  // categories and whether Confirm is allowed.
  const reviewLines = toReviewLines(items, itemCategories, addedItems);
  const itemGroups = groupByCategory(reviewLines);
  const itemsTotalCentavos = sumCentavos(reviewLines);
  const everyItemHasCategory = everyLineIsReady(items, itemCategories, addedItems);

  const itemGapCentavos = totalCentavos - itemsTotalCentavos;

  /*
    A gap is normal, not an error.

    Item prices and the total legitimately disagree: a VAT-exclusive register
    adds tax on top of the printed lines, a discount takes money off, and OCR
    sometimes just misses a line. So the screen asks how to account for the
    difference rather than disabling Confirm until the owner makes the
    arithmetic work — which, on a VAT-exclusive receipt, they never could.

    The one thing that never happens is the total changing on its own. It is
    what the owner confirmed against the photo and what actually left their
    pocket; only the explicit "OCR misread the total" plan touches it.
  */
  const gapNeedsAPlan = itemGapCentavos !== 0;
  // A discount can't become its own expense record — that would be a negative
  // expense, which nothing downstream understands. Server enforces this too.
  const canFileGapInOneCategory = itemGapCentavos > 0;
  const gapPlanIsResolved =
    !gapNeedsAPlan ||
    gapPlan === "proportional" ||
    gapPlan === "shrink" ||
    (gapPlan === "category" && canFileGapInOneCategory && gapCategoryId !== "");

  const itemsAreComplete = everyItemHasCategory && gapPlanIsResolved;

  const readyToConfirm =
    (isItemised ? itemsAreComplete : splitsAreComplete) && editingItem === null && updatingItemId === null;

  /*
   * The amount actually sent is derived in lib/receiptConfirm, not here.
   *
   * A duplicate of that rule used to sit at this spot, left behind when the
   * payload shapes moved into the builder. It was unreferenced — so it was
   * dead weight that still had to be kept in step with the real rule, and it
   * failed the production build under noUnusedLocals. The builder is the one
   * place that decides, and it is tested against the server's schema.
   */

  function addAddedItem() {
    setAddedItems((prev) => [
      ...prev,
      { key: `added-${Date.now()}-${prev.length}`, name: "", amount: "", categoryId: "" },
    ]);
  }

  function updateAddedItem(key: string, patch: Partial<Omit<AddedItem, "key">>) {
    setAddedItems((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  }

  function removeAddedItem(key: string) {
    setAddedItems((prev) => prev.filter((a) => a.key !== key));
  }

  function beginItemEdit(item: ScannedItem) {
    setEditingItem({ id: item.id, name: item.name, amount: item.amount });
    setConfirmError(null);
  }

  async function saveItemEdit() {
    if (!scan || !editingItem || updatingItemId !== null) return;
    const name = editingItem.name.trim();
    const nextAmount = Number(editingItem.amount);
    if (!name || !Number.isFinite(nextAmount) || nextAmount <= 0) {
      setConfirmError("Enter an item name and an amount greater than zero.");
      return;
    }

    setUpdatingItemId(editingItem.id);
    setConfirmError(null);
    const signal = requests.current.signal;
    try {
      const { data } = await api.patch<ReceiptScanResult>(
        `/records/receipts/${scan.id}/items/${editingItem.id}`,
        { name, amount: nextAmount, expectedScanRevision: scan.scanRevision },
        { signal },
      );
      // A late response must not revive a scan the owner has since abandoned.
      setScan((current) => (current?.id === data.id ? data : current));
      setEditingItem(null);
    } catch (err) {
      if (signal.aborted) return;
      if (isAxiosError(err) && err.response?.status === 409) {
        try {
          const { data: latest } = await api.get<ReceiptScanResult>(`/records/receipts/${scan.id}`, { signal });
          setScan((current) => (current?.id === latest.id ? latest : current));
          setConfirmError("This receipt changed in another request. Your edit is still here; review it and save again.");
        } catch (refreshError) {
          if (!signal.aborted) setConfirmError(getErrorMessage(refreshError));
        }
      } else {
        setConfirmError(getErrorMessage(err));
      }
    } finally {
      if (!signal.aborted) setUpdatingItemId(null);
    }
  }

  /**
   * Drops a line OCR read that was never a purchase.
   *
   * Deleted on the server rather than hidden here, because confirmation
   * requires every STORED item to carry a category — a row this screen merely
   * stopped showing would still be on the scan, and would block Confirm with
   * a message about an item the owner can no longer see.
   *
   * The response is the scan as it now stands, so the table re-renders from
   * the server's list rather than a local guess at it. Removing a line widens
   * the gap against the total, which the reconciliation question below picks
   * up on the next render — that is the intended consequence, not a side
   * effect to suppress.
   *
   * Because the delete is server-side and the API has no way to put a read
   * line back — re-adding it locally would file it as `addedByOwner`, i.e.
   * claim a human typed something FinSight read — there is no undo to offer
   * afterwards. The confirm step IS the way back, so it is not optional here
   * the way it would be for a removal the toast could reverse.
   */
  async function removeScannedItem(item: ScannedItem) {
    if (!scan || removingItemId !== null) return;
    const itemId = item.id;
    const index = scan.items.findIndex((candidate) => candidate.id === itemId);
    const neighbour = index === -1
      ? null
      : scan.items[index + 1] ?? scan.items[index - 1] ?? null;

    const approved = await confirm({
      title: `Remove "${item.name}"?`,
      body: "FinSight cannot put this line back once it's gone. What's left will be checked against the receipt total again.",
      confirmLabel: "Remove item",
      tone: "danger",
    });
    if (!approved) return;

    setRemovingItemId(itemId);
    setConfirmError(null);
    const signal = requests.current.signal;
    try {
      const { data } = await api.delete<ReceiptScanResult>(
        `/records/receipts/${scan.id}/items/${itemId}`,
        { params: { expectedScanRevision: scan.scanRevision }, signal },
      );
      setScan((current) => (current?.id === data.id ? data : current));
      setItemCategories((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      setFocusItemAfterRemove({ removedItemId: itemId, nextItemId: neighbour?.id ?? null });
      toast("Item removed from this receipt.");
    } catch (err) {
      if (signal.aborted) return;
      if (isAxiosError(err) && err.response?.status === 409) {
        try {
          const { data: latest } = await api.get<ReceiptScanResult>(`/records/receipts/${scan.id}`, { signal });
          setScan((current) => (current?.id === latest.id ? latest : current));
          setConfirmError("This receipt changed in another request. Check the latest items and try again.");
        } catch (refreshError) {
          if (!signal.aborted) setConfirmError(getErrorMessage(refreshError));
        }
      } else {
        setConfirmError(getErrorMessage(err));
      }
    } finally {
      if (!signal.aborted) setRemovingItemId(null);
    }
  }

  /** Category id -> its name, for the subtotal lines. */
  function categoryName(id: number | ""): string {
    return categories.find((c) => c.id === id)?.name ?? "Category";
  }

  /**
   * The standing "nothing fitted this" category, if this business has one.
   *
   * Created server-side on demand during a scan, so it may not exist at all,
   * and matched case-insensitively because an owner who already had their own
   * "Uncategorized" keeps it — the same rule the server follows.
   */
  const uncategorisedId = categories.find((c) => c.name.toLowerCase() === "uncategorized")?.id ?? null;

  /**
   * The new category FinSight proposed for a row, when it is still worth
   * offering.
   *
   * Withheld once the owner has placed the row themselves: the suggestion
   * answers "nothing here fits this", which stops being true the moment they
   * say what does. Withheld too once the category exists — which happens as
   * soon as it is accepted for a sibling row — because the offer would then
   * be to create a duplicate.
   */
  function suggestedNewCategoryFor(item: ScannedItem): string | null {
    const name = item.suggestedCategoryName;
    if (!name) return null;
    const current = itemCategories[item.id];
    const isUnplaced = current === "" || current === undefined || current === uncategorisedId;
    if (!isUnplaced) return null;
    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return null;
    return name;
  }

  const receiptPreview = scan && (reviewFiles.length > 0 || (scan.pageEvidence?.length ?? 0) > 0) ? (
    <ReceiptPagePreview
      scanId={scan.id}
      files={reviewFiles}
      pageEvidence={scan?.pageEvidence}
      pageProcessing={scan?.pageProcessing}
      pageQualities={scan?.pageQualities}
    />
  ) : null;

  const resumeRowNames = recoveryRowNames(resumeScans);

  // ---- stage 1: choose a photo ------------------------------------------
  if (!scan) {
    return (
      <FormPage eyebrow="Records" title="Scan a receipt">
        {resumeLoading ? <p className="mb-4 text-sm text-ink-500" role="status">Checking unfinished scans…</p> : null}
        {resumeError?.failed === "refresh" ? (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <p className="text-sm text-tone-danger" role="alert">{resumeError.message}</p>
            <Button type="button" variant="secondary" size="sm" disabled={resumeLoading} onClick={() => void refreshActiveReceiptHistory()}>
              Reload unfinished scans
            </Button>
          </div>
        ) : null}
        {resumeScans.length > 0 ? (
          <section aria-labelledby="unfinished-receipts-title" className="mb-4 rounded-xl border border-paper-200 bg-paper-50 p-3">
            <h2 id="unfinished-receipts-title" className="text-sm font-semibold text-ink-800">
              Continue an unfinished scan
            </h2>
            <ul aria-label="Unfinished scans" className="mt-2 space-y-2">
              {resumeScans.map((pending) => {
                const rowName = resumeRowNames.get(pending.id) ?? recoveryRowTitle(pending);
                const actionLabel = pending.allowedActions.retryProcessing
                  ? "Retry processing"
                  : pending.allowedActions.reviewResult
                    ? "Review result"
                    : "Continue waiting";
                const deleteLabel = deletingScanId === pending.id ? "Deleting…" : "Delete scan";
                return (
                  <li key={pending.id} id={recoveryRowId(pending.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-paper px-3 py-2 ring-1 ring-paper-200">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-800">{recoveryRowTitle(pending)}</p>
                      <p className="text-xs text-ink-500">
                        {pending.processingStatus === "Processing"
                          ? "Still reading"
                          : pending.processingStatus === "Failed"
                            ? "Needs another processing attempt"
                            : "Ready to review"}
                        {pending.receiptOrdinal ? ` · Receipt ${pending.receiptOrdinal}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        id={recoveryRowActionId(pending.id)}
                        variant={pending.allowedActions.reviewResult ? "primary" : "secondary"}
                        disabled={scanning || deletingScanId !== null}
                        onClick={() => void openStoredScan(pending)}
                        aria-label={`${actionLabel}, ${rowName}`}
                      >
                        {actionLabel}
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        disabled={scanning || deletingScanId !== null}
                        onClick={() => void deleteUnconfirmedScan(pending)}
                        aria-label={`${deleteLabel}, ${rowName}`}
                      >
                        {deleteLabel}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {resumeError?.failed === "older" ? (
              <p className="mt-2 text-sm text-tone-danger" role="alert">{resumeError.message}</p>
            ) : null}
            {resumeLoadingOlder ? (
              <p className="mt-2 text-sm text-ink-500" role="status">Loading older scans…</p>
            ) : null}
            {resumeHistory.nextCursor !== null ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={resumeLoading || resumeLoadingOlder}
                onClick={() => void loadOlderReceiptHistory()}
              >
                Show older scans
              </Button>
            ) : resumeHistory.pagesLoaded > 1 ? (
              <p className="mt-2 text-xs text-ink-500">No more unfinished scans.</p>
            ) : null}
          </section>
        ) : null}
        <form onSubmit={handleStartScanning} className="space-y-4">
          <Field label="Receipt photo" htmlFor="receipt-files" required>
            <MultiFileInput
              id="receipt-files"
              files={pickedFiles}
              onChange={(next) => {
                setPickedFiles(next);
                setScanError(null);
              }}
              disabled={scanning}
              hintText="JPEG, PNG or WEBP. Up to 8 photos, 10 MiB each and 80 MiB total. Use a flat, well-lit photo."
            />
          </Field>

          <ReceiptProviderConsent businessProfileId={selected.id} disabled={scanning} />

          {/*
            The disambiguation only appears once there is something to
            disambiguate. One photo has nothing to ask about — asking anyway
            would put a question in front of every owner for the sake of the
            minority with a long receipt.
          */}
          {pickedFiles.length > 1 && pickedFilesError === null ? (
            <div className="space-y-2 rounded-xl border border-paper-200 bg-paper-50 p-3">
              <p className="text-xs font-medium text-ink-700">
                You added {pickedFiles.length} photos. What are they?
              </p>
              <GapOption
                name="combine-choice"
                checked={combineChoice === "separate"}
                onChange={() => setCombineChoice("separate")}
                label={`${pickedFiles.length} separate receipts`}
                detail="Each photo becomes its own expense. Scanned and reviewed one after another."
              />
              <GapOption
                name="combine-choice"
                checked={combineChoice === "one"}
                onChange={() => setCombineChoice("one")}
                label={`One long receipt (${pickedFiles.length} pages)`}
                detail="These photos continue from each other — one receipt too long for a single photo."
              />
            </div>
          ) : null}

          {scanError ? <FormError>{scanError}</FormError> : null}

          {/*
            The OCR wait is the app's slowest interaction and it cannot be made
            fast, so the interface says which PART of it is happening instead of
            one flat "Reading your receipt…". Each stage is driven by a real
            event — see ScanProgress — and there is no percentage anywhere,
            because the server reports none.
          */}
          {scanning ? <ScanProgress stage={scanStage} /> : null}

          {scanning ? (
            <Button type="button" variant="secondary" fullWidth onClick={handleStopWaiting}>
              {scanStage === "uploading" ? "Cancel upload" : "Stop waiting"}
            </Button>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            fullWidth
            disabled={scanning || pickedFiles.length === 0 || pickedFilesError !== null}
          >
            {scanning
              ? "Reading receipt…"
              : pausedScan
                ? "Review result"
              : pickedFilesError
                ? "Fix selected photos to continue"
                : pickedFiles.length > 1 && combineChoice === "separate"
                ? `Scan ${pickedFiles.length} receipts`
                : "Scan receipt"}
          </Button>
        </form>
      </FormPage>
    );
  }

  if (scan.processingStatus === "Failed") {
    return (
      <FormPage eyebrow="Records" title="Receipt needs another try">
        <div className="space-y-4">
          <Callout tone="warn">
            <p className="font-semibold">FinSight could not finish reading this receipt.</p>
            <p className="mt-1 text-sm">
              {scan.processingError ?? "The saved images are still available for another processing attempt."}
            </p>
          </Callout>
          {receiptPreview}
          {scanError ? <FormError>{scanError}</FormError> : null}
          {scanning ? <ScanProgress stage={scanStage} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" onClick={retryProcessing} disabled={scanning}>
              {scanning ? "Retrying…" : "Retry processing"}
            </Button>
            {scanning ? (
              <Button type="button" variant="secondary" onClick={handleStopWaiting}>
                Stop waiting
              </Button>
            ) : null}
            <Link to="/records/expenses/new" className="tap-inline inline-flex items-center font-semibold text-tone-brand underline">
              Enter manually
            </Link>
            <Button type="button" variant="secondary" onClick={handleRescan} disabled={scanning}>
              Choose another image
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void deleteUnconfirmedScan(scan)}
              disabled={scanning || deletingScanId !== null}
            >
              {deletingScanId === scan.id ? "Deleting…" : "Delete scan"}
            </Button>
          </div>
        </div>
      </FormPage>
    );
  }

  if (foreignCurrency) {
    return (
      <FormPage title="Review receipt">
        <div className="space-y-4">
          <Callout tone="warn">
            <p className="font-semibold">This receipt uses {foreignCurrency}. FinSight records expenses in PHP.</p>
            <Link to="/records/expenses/new" className="tap-inline font-semibold underline underline-offset-2">
              Enter the PHP amount manually
            </Link>
          </Callout>
          {scan.extractedAmount !== null && scan.receiptDetails?.currency ? (
            <p className="text-sm text-ink-700">Printed total: <strong className="figure">{foreignCurrency} {new Intl.NumberFormat("en-PH", { minimumFractionDigits: 2 }).format(scan.extractedAmount)}</strong></p>
          ) : null}
          <PrintedReceiptDetails details={scan.receiptDetails} />
          {receiptPreview}
          {scanError ? <FormError>{scanError}</FormError> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={handleRescan}>Choose another receipt</Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void deleteUnconfirmedScan(scan)}
              disabled={deletingScanId !== null}
            >
              {deletingScanId === scan.id ? "Deleting…" : "Delete scan"}
            </Button>
          </div>
        </div>
      </FormPage>
    );
  }

  // ---- stage 2: check what it read --------------------------------------
  //
  // Deliberately NOT inside FormPage: the whole job of this screen is letting
  // the owner read the receipt and the extracted values at the same time, and
  // FormPage's single measure column cannot hold both side by side.
  return (
    <div>
      <PageHead
        eyebrow="Records"
        title="Check what FinSight read"
        subtitle="Compare each value against the photo before saving."
      />

      {/*
        The batch progress row — a plain-text "Receipt 2 of 4" in the subtitle
        was easy to miss, and gave no way to actually SEE receipt 1 again once
        it scrolled past. Each earlier receipt is now a real link.

        Opens in a NEW TAB rather than navigating in place: this app is a
        single-page client, and an in-app navigation to a saved record would
        unmount this screen — losing fileQueue, queuePosition and everything
        else this in-progress batch is holding. A new tab leaves the batch
        exactly where it was.
      */}
      {queueTotal > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="list" aria-label="Receipts in this batch">
          {Array.from({ length: queueTotal }, (_, i) => i + 1).map((n) => {
            const history = queueHistory.find((h) => h.position === n);
            if (n === queuePosition) {
              return (
                <span
                  key={n}
                  role="listitem"
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Receipt {n} · Reviewing now
                </span>
              );
            }
            if (history && history.recordIds[0] !== undefined) {
              return (
                <a
                  key={n}
                  role="listitem"
                  href={`/records/expenses/${history.recordIds[0]}/edit`}
                  target="_blank"
                  rel="noreferrer"
                  className="tap-inline inline-flex items-center gap-1.5 rounded-full bg-tint-brand px-3 py-1.5 text-xs font-medium text-tone-brand ring-1 ring-edge-brand transition hover:bg-tint-brand/70"
                >
                  <span aria-hidden>✓</span>
                  Receipt {n} · Saved — view it
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              );
            }
            if (history) {
              return (
                <span
                  key={n}
                  role="listitem"
                  className="inline-flex items-center gap-1.5 rounded-full bg-tint-brand px-3 py-1.5 text-xs font-medium text-tone-brand ring-1 ring-edge-brand"
                >
                  <span aria-hidden>✓</span>
                  Receipt {n} · Saved
                </span>
              );
            }
            return (
              <span
                key={n}
                role="listitem"
                className="inline-flex items-center gap-1.5 rounded-full bg-paper-100 px-3 py-1.5 text-xs text-ink-600"
              >
                Receipt {n} · Not yet
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 sm:p-6">
          <form onSubmit={handleConfirm} className="space-y-4">
            {/*
              THE PRIMARY CUE IS A BAND, NOT A PERCENTAGE.

              This used to read "FinSight's reading confidence for this photo:
              87%". A percentage is a grade, and a grade invites the owner to
              accept it — 87 sounds like a pass. It also disagreed with itself:
              the page number was coloured on 80/60 while the per-item badges
              below used 75, so a green header could sit above amber items.

              lib/confidenceBands.ts now owns the single mapping (ADR-4), and
              what the owner reads is an instruction: Looks clear / Check a few
              fields / Review carefully. The band is TEXT, not a hue, so it
              survives greyscale and colourblindness. The raw figure stays in
              the title attribute, where it is evidence rather than a grade.
            */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Pill tone={BAND_COPY[receiptBand].tone === "ok" ? "ok" : BAND_COPY[receiptBand].tone === "warn" ? "warn" : "danger"}>
                {BAND_COPY[receiptBand].label}
              </Pill>
              <p className="min-w-0 flex-1 text-xs text-ink-500">Receipt scanned. Review before saving.</p>
            </div>

            {/*
              WHICH fields, not just "some fields".

              "Check a few fields" is only useful if the screen says which, so
              the warnings that name a field, the low-confidence item amounts
              and the missing values are resolved into one list — and the first
              of them takes focus when the review screen appears, so the
              keyboard lands on the thing that needs a decision.
            */}
            {receiptBand !== "clear" && attentionFields.length > 0 ? (
              <Callout tone="warn">
                <b className="font-semibold">
                  Check {attentionFields.map((f) => FIELD_LABELS[f]).join(", ").toLowerCase()} before
                  saving.
                </b>
              </Callout>
            ) : null}

            {/*
              THE WARNINGS, IN THE SERVER'S OWN WORDS.

              What stood here before was a prose ladder: one hardcoded
              paragraph per boolean (blurry page, duplicate page, two receipts
              in one photo, vision-assisted, vision-assisted-but-only-the-
              names). Mobile kept its own copy of the same ladder and the two
              had already drifted, so the same receipt could be described
              differently on the two clients.

              The pipeline now emits CODES and the server owns one guidance
              sentence per code (backend/src/lib/receiptWarnings.ts). This
              renders `warning.guidance` verbatim. Writing a sentence here
              instead — however small — puts the drift straight back.
            */}
            <ReceiptResultNotes key={scan.id} warnings={allWarnings} />
            <PrintedReceiptDetails key={`printed-${scan.id}`} details={scan.receiptDetails} />

            <ScannedField
              label="Date"
              htmlFor="date"
              required
              attention={attentionFields.includes("date")}
              evidence={scan.fieldEvidence?.date}
              origin={originOf(date, scan.extractedDate ? scan.extractedDate.slice(0, 10) : null)}
            >
              <TextInput
                type="date"
                required
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setDuplicateAcknowledged(false);
                }}
                className={provisionalClass(
                  originOf(date, scan.extractedDate ? scan.extractedDate.slice(0, 10) : null),
                )}
              />
            </ScannedField>

            <ScannedField
              label="Description"
              htmlFor="description"
              required
              attention={attentionFields.includes("description")}
              origin={descriptionOrigin}
            >
              <TextInput
                required
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDuplicateAcknowledged(false);
                }}
                placeholder="What did you buy?"
                className={provisionalClass(descriptionOrigin)}
              />
            </ScannedField>

            <ScannedField
              label="Vendor"
              htmlFor="vendor"
              optional
              attention={attentionFields.includes("vendor")}
              evidence={scan.fieldEvidence?.vendor}
              origin={originOf(vendor, scan.extractedVendor)}
            >
              <TextInput
                value={vendor}
                onChange={(e) => {
                  setVendor(e.target.value);
                  setDuplicateAcknowledged(false);
                }}
                className={provisionalClass(originOf(vendor, scan.extractedVendor))}
              />
            </ScannedField>

            <ScannedField
              label="Amount"
              htmlFor="amount"
              required
              attention={attentionFields.includes("amount")}
              evidence={scan.fieldEvidence?.amount}
              origin={originOf(String(amount), scan.extractedAmount === null ? null : String(scan.extractedAmount))}
            >
              <MoneyInput
                min={0.01}
                required
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value === "" ? "" : Number(e.target.value));
                  setDuplicateAcknowledged(false);
                }}
                className={provisionalClass(
                  originOf(
                    String(amount),
                    scan.extractedAmount === null ? null : String(scan.extractedAmount),
                  ),
                )}
              />
            </ScannedField>

            {/*
              Two review modes.

              A receipt whose lines FinSight could read is reviewed ITEM BY
              ITEM — that is the whole point of the feature, and it is what
              lets "buns" and "patty" land in Ingredients while "rice cooker"
              lands in Equipment without the owner deciding anything up front.

              A receipt with one line or none keeps exactly the flow it had:
              one Category dropdown, optionally split by hand. Showing a
              grouping UI for a single item would be ceremony around a
              decision the dropdown already makes.
            */}
            {isItemised ? (
              <fieldset>
                <legend className="text-sm font-medium text-ink-700">
                  Items on this receipt
                  <span className="ml-1 text-tone-danger" title="Required">
                    <span aria-hidden>*</span>
                    <span className="sr-only">(required)</span>
                  </span>
                </legend>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  {/*
                    "read" is the wrong verb for a line a model inferred from a
                    photograph, so it is not used for one. Same sentence,
                    honest verb.
                  */}
                  {hasHistoryCategoryMatches ? (
                    <>
                      FinSight {itemsAreFromPhoto ? "found" : "read"} {items.length} items and reused
                      categories from matching receipt records you confirmed before. Check each category.
                    </>
                  ) : (
                    <>
                      FinSight {itemsAreFromPhoto ? "found" : "read"} {items.length} items but could not
                      match them to categories you confirmed before. Choose each category below.
                    </>
                  )}
                </p>

                <div className="mt-2 overflow-x-auto rounded-xl border border-paper-200">
                  <table className="w-full min-w-[38rem] text-left text-sm">
                    <caption className="sr-only">
                      Each item read from the receipt, with the category it will be filed under
                    </caption>
                    <thead>
                      <tr className="border-b border-paper-200 bg-paper-100">
                        <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
                          Item
                        </th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
                          Qty
                        </th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
                          Price
                        </th>
                        <th scope="col" className="w-56 px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
                          Category
                        </th>
                        <th scope="col" className="w-24 px-3 py-2">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} id={scannedItemRowId(item.id)} className="border-t border-paper-200 align-middle">
                          <td className="px-3 py-2 text-ink-800">
                            {editingItem?.id === item.id ? (
                              <>
                                <label htmlFor={`item-name-${item.id}`} className="sr-only">
                                  Item name
                                </label>
                                <TextInput
                                  id={`item-name-${item.id}`}
                                  value={editingItem.name}
                                  onChange={(event) =>
                                    setEditingItem((current) => current
                                      ? { ...current, name: event.target.value }
                                      : current)
                                  }
                                />
                              </>
                            ) : (
                              item.name
                            )}
                            {/*
                              When the items do not add up, the server names
                              the line it is least sure of. Pointing beats
                              asking the owner to re-read all nine — and it
                              never changes the figure, because the right
                              value is not something the engine knows.
                            */}
                            {scan.suspectItemId === item.id ? (
                              <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent ring-1 ring-edge-accent align-middle">
                                <span aria-hidden>⚠</span>
                                Check this one first
                              </span>
                            ) : null}
                            {/*
                              Marked per row, not just once at the top, because
                              the row is where the owner decides. A line a model
                              inferred from a photograph should look different
                              from one read off text at the moment it is checked.
                            */}
                            {item.extractedByVision ? (
                              <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent ring-1 ring-edge-accent align-middle">
                                <span aria-hidden>✦</span>
                                AI read this from the photo
                              </span>
                            ) : null}
                            {item.ownerEditedFields?.length ? (
                              <span className="ml-1.5 inline-flex rounded-full bg-tint-brand px-1.5 py-0.5 text-[10px] font-medium text-tone-brand ring-1 ring-edge-brand align-middle">
                                Corrected by you
                              </span>
                            ) : null}
                            {/*
                              The printed line this row came off, quoted. It is
                              the cheapest possible way to check a row: the
                              owner compares two strings instead of hunting the
                              paper for a number.
                            */}
                            {item.evidence ? (
                              <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-500">
                                <EvidenceNote evidence={item.evidence} />
                              </span>
                            ) : null}
                          </td>
                          <td className="figure px-3 py-2 text-right text-ink-600">
                            {item.quantity ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {editingItem?.id === item.id ? (
                              <>
                                <label htmlFor={`item-amount-${item.id}`} className="sr-only">
                                  Item amount
                                </label>
                                <MoneyInput
                                  id={`item-amount-${item.id}`}
                                  min={0.01}
                                  value={editingItem.amount}
                                  onChange={(event) =>
                                    setEditingItem((current) => current
                                      ? {
                                          ...current,
                                          amount: event.target.value === "" ? "" : Number(event.target.value),
                                        }
                                      : current)
                                  }
                                />
                              </>
                            ) : (
                              <Money value={item.amount} decimals />
                            )}
                            {/*
                              The engine's own doubt about THIS figure. Shown
                              only when it is low enough to act on — a
                              percentage beside every correct price would be
                              noise, and noise is what stops people checking.
                            */}
                            {/*
                              The engine's own doubt about THIS figure, as a
                              band rather than "72% sure". Same mapping as the
                              header cue (lib/confidenceBands.ts) — before
                              this, the page used 80/60 and the item badge used
                              75, so a receipt could read "clear" above a row
                              the same engine was unsure of. The raw figure
                              stays in the title, as evidence.
                            */}
                            {confidenceBand({
                              confidence: item.amountConfidence,
                              visionAssisted: item.extractedByVision,
                            }) !== "clear" && typeof item.amountConfidence === "number" ? (
                              <span
                                className="mt-0.5 block text-[10px] font-medium text-tone-accent"
                                title={`FinSight's own confidence reading this amount: ${item.amountConfidence}%`}
                              >
                                {BAND_COPY[
                                  confidenceBand({
                                    confidence: item.amountConfidence,
                                    visionAssisted: item.extractedByVision,
                                  })
                                ].label}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <label htmlFor={`item-category-${item.id}`} className="sr-only">
                              Category for {item.name}
                            </label>
                            <CategorySelect
                              id={`item-category-${item.id}`}
                              value={itemCategories[item.id] ?? ""}
                              onChange={(categoryId) =>
                                setItemCategories((prev) => ({ ...prev, [item.id]: categoryId }))
                              }
                            />
                            {/*
                              A category FinSight thinks is missing.

                              Shown only where it is still useful — see
                              suggestedNewCategoryFor. Phrased as an offer
                              rather than an assignment, because nothing is
                              created until the owner says so; the whole
                              reason this is a suggestion and not a decision
                              is that inventing categories in someone's books
                              is not FinSight's call to make.
                            */}
                            {suggestedNewCategoryFor(item) ? (
                              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
                                <span aria-hidden className="text-tone-accent">
                                  ✦
                                </span>{" "}
                                Nothing fits this. FinSight suggests a new category,{" "}
                                <b className="font-semibold text-ink-700">{item.suggestedCategoryName}</b>.{" "}
                                <button
                                  type="button"
                                  onClick={() => acceptSuggestedCategory(item.suggestedCategoryName!)}
                                  disabled={creatingCategoryFor !== null}
                                  className="tap-inline font-medium text-tone-brand underline transition hover:decoration-2 disabled:opacity-50"
                                >
                                  {creatingCategoryFor === item.suggestedCategoryName
                                    ? "Creating…"
                                    : "Create it"}
                                  <span className="sr-only"> and file {item.name} under it</span>
                                </button>
                              </p>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
                              {editingItem?.id === item.id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void saveItemEdit()}
                                    disabled={updatingItemId === item.id}
                                    className="tap-inline shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand disabled:opacity-50"
                                  >
                                    {updatingItemId === item.id ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingItem(null)}
                                    disabled={updatingItemId === item.id}
                                    className="tap-inline shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-ink-600 transition hover:bg-paper-100 disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`Edit ${item.name}`}
                                  onClick={() => beginItemEdit(item)}
                                  disabled={editingItem !== null || removingItemId !== null}
                                  className="tap-inline shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand disabled:opacity-50"
                                >
                                  Edit
                                </button>
                              )}
                              {/*
                                Disabled while ANY row is being removed, not
                                just this one. Each × sends the scan revision
                                it was rendered with, so a second click during
                                a delete in flight comes back 409 — "this
                                receipt changed in another request" — for a
                                change the owner made themselves a moment ago.
                              */}
                              <button
                                type="button"
                                id={scannedItemRemoveId(item.id)}
                                onClick={() => void removeScannedItem(item)}
                                disabled={removingItemId !== null || editingItem !== null}
                                className="tap-inline shrink-0 rounded-lg px-1.5 py-1 text-xs font-medium text-ink-500 transition hover:text-tone-danger disabled:opacity-50"
                              >
                                <span aria-hidden>×</span>
                                <span className="sr-only">
                                  Remove {item.name} — this was not a purchase
                                </span>
                              </button>
                            </div>

                          </td>
                        </tr>
                      ))}

                      {/*
                        Lines the owner is adding because OCR missed them.

                        Kept visually distinct from the extracted rows: the
                        panel above claims FinSight READ these items off the
                        receipt, and that claim must not quietly extend to a
                        row a human typed. The same distinction is stored
                        server-side (ReceiptScanItem.addedByOwner) so it
                        survives onto the saved record.
                      */}
                      {addedItems.map((added, i) => (
                        <tr key={added.key} className="border-t border-paper-200 bg-paper-50 align-middle">
                          <td className="px-3 py-2">
                            <label htmlFor={`added-name-${added.key}`} className="sr-only">
                              Name for added item {i + 1}
                            </label>
                            <TextInput
                              id={`added-name-${added.key}`}
                              placeholder="Item name"
                              value={added.name}
                              onChange={(e) => updateAddedItem(added.key, { name: e.target.value })}
                            />
                          </td>
                          <td className="px-3 py-2 text-right text-ink-500">—</td>
                          <td className="px-3 py-2">
                            <label htmlFor={`added-amount-${added.key}`} className="sr-only">
                              Amount for added item {i + 1}
                            </label>
                            <MoneyInput
                              id={`added-amount-${added.key}`}
                              min={0.01}
                              value={added.amount}
                              onChange={(e) =>
                                updateAddedItem(added.key, {
                                  amount: e.target.value === "" ? "" : Number(e.target.value),
                                })
                              }
                            />
                          </td>
                          <td className="px-3 py-2">
                            <label htmlFor={`added-category-${added.key}`} className="sr-only">
                              Category for added item {i + 1}
                            </label>
                            <CategorySelect
                              id={`added-category-${added.key}`}
                              value={added.categoryId}
                              onChange={(categoryId) => updateAddedItem(added.key, { categoryId })}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => removeAddedItem(added.key)}
                                className="tap-inline shrink-0 rounded-lg px-1.5 py-1 text-xs font-medium text-ink-500 transition hover:text-tone-danger"
                              >
                                <span aria-hidden>×</span>
                                <span className="sr-only">Remove added item {i + 1}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/*
                  The live per-category subtotals. Derived from the rows on
                  every render rather than held in their own state, so moving
                  one item between categories cannot leave a stale figure
                  behind — both affected subtotals change in the same paint.
                */}
                <div className="mt-3 rounded-xl bg-paper-100 p-3">
                  <p className="text-xs font-semibold text-ink-600">What gets saved</p>
                  <ul className="mt-1.5 space-y-1">
                    {itemGroups.map((group) => (
                      <li
                        key={String(group.categoryId)}
                        className="flex items-baseline justify-between gap-3 text-sm"
                      >
                        <span className="min-w-0 truncate text-ink-700">
                          {group.categoryId === "" ? (
                            <span className="text-tone-accent">Not categorised yet</span>
                          ) : (
                            categoryName(group.categoryId)
                          )}
                          <span className="ml-1.5 text-xs text-ink-600">
                            ({group.count} item{group.count === 1 ? "" : "s"})
                          </span>
                        </span>
                        <span className="figure shrink-0 font-medium text-ink-900">
                          <Money value={group.subtotal} decimals />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p
                    aria-live="polite"
                    className={`mt-2 flex items-center gap-1.5 border-t border-paper-200 pt-2 text-xs font-medium ${
                      itemsAreComplete ? "text-tone-brand" : "text-tone-accent"
                    }`}
                  >
                    <span aria-hidden>{itemsAreComplete ? "✓" : "⚠"}</span>
                    {!everyItemHasCategory ? (
                      <>Every item needs a category before this can be saved.</>
                    ) : itemGapCentavos === 0 ? (
                      <>
                        {itemGroups.length} record{itemGroups.length === 1 ? "" : "s"} will be saved, adding
                        up to the receipt total.
                      </>
                    ) : gapPlan === "shrink" ? (
                      <>
                        The receipt will be saved as <Money value={itemsTotalCentavos / 100} decimals /> —
                        the items' own total — instead of the amount above.
                      </>
                    ) : gapPlanIsResolved ? (
                      <>
                        {itemGroups.length + (gapPlan === "category" ? 1 : 0)} record
                        {itemGroups.length + (gapPlan === "category" ? 1 : 0) === 1 ? "" : "s"} will be saved,
                        adding up to the receipt total of{" "}
                        <Money value={totalCentavos / 100} decimals />.
                      </>
                    ) : itemGapCentavos > 0 ? (
                      <>
                        The items come to <Money value={itemsTotalCentavos / 100} decimals />, which is{" "}
                        <Money value={itemGapCentavos / 100} decimals /> less than the receipt total above.
                      </>
                    ) : (
                      <>
                        The items come to <Money value={itemsTotalCentavos / 100} decimals />, which is{" "}
                        <Money value={-itemGapCentavos / 100} decimals /> more than the receipt total above.
                      </>
                    )}
                  </p>

                  {gapPlan === "proportional" && gapNeedsAPlan ? (
                    <p className="mt-1 text-xs text-ink-600">
                      Each category above will carry its share of the{" "}
                      <Money value={Math.abs(itemGapCentavos) / 100} decimals bare /> when saved.
                    </p>
                  ) : null}
                </div>

                {/*
                  Accounting for the difference.

                  A gap is normal rather than a mistake: a VAT-exclusive
                  register adds tax on top of the printed lines, a discount
                  takes money off, and OCR sometimes just misses one. The old
                  screen offered a single way out — set the receipt total down
                  to the items — which balances the arithmetic by DELETING
                  money the owner really spent. On a receipt totalling 1,120
                  with 1,000 of items, that filed a 1,000 expense.

                  So the owner is asked what the difference actually is. The
                  total they confirmed against the photo is the anchor and
                  never moves on its own; only the last option, for a total
                  OCR misread, changes it, and then only to figures read off
                  the receipt.
                */}
                {everyItemHasCategory && gapNeedsAPlan ? (
                  <fieldset className="mt-3 rounded-xl border border-tone-accent/30 bg-tone-accent/5 p-3">
                    <legend className="px-1 text-xs font-semibold text-ink-700">
                      {itemGapCentavos > 0 ? (
                        <>
                          What is the missing <Money value={itemGapCentavos / 100} decimals bare />?
                        </>
                      ) : (
                        <>
                          What is the extra <Money value={-itemGapCentavos / 100} decimals bare />?
                        </>
                      )}
                    </legend>

                    <p className="mt-1 text-xs leading-relaxed text-ink-500">
                      {itemGapCentavos > 0
                        ? "Receipts often add tax or a service charge on top of the item prices, and sometimes a line just doesn't scan."
                        : "A discount or a voided line usually explains this."}
                    </p>

                    <div className="mt-2 space-y-1.5">
                      <GapOption
                        name="gap-plan"
                        checked={gapPlan === "proportional"}
                        onChange={() => setGapPlan("proportional")}
                        label={itemGapCentavos > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
                        detail="Split across the categories above, in proportion to what each one came to. Keeps every category's spending accurate."
                      />

                      {canFileGapInOneCategory ? (
                        <GapOption
                          name="gap-plan"
                          checked={gapPlan === "category"}
                          onChange={() => setGapPlan("category")}
                          label="A separate charge to track on its own"
                          detail="Saved as its own expense record under one category."
                        >
                          {gapPlan === "category" ? (
                            <div className="mt-1.5">
                              <label htmlFor="gap-category" className="sr-only">
                                Category for the remaining amount
                              </label>
                              <CategorySelect id="gap-category" value={gapCategoryId} onChange={setGapCategoryId} />
                            </div>
                          ) : null}
                        </GapOption>
                      ) : null}

                      <GapOption
                        name="gap-plan"
                        checked={gapPlan === "shrink"}
                        onChange={() => setGapPlan("shrink")}
                        label="FinSight misread the receipt total"
                        detail={
                          <>
                            Save <Money value={itemsTotalCentavos / 100} decimals bare /> — the items' own
                            total — instead of the amount above.
                          </>
                        }
                      />
                    </div>

                    {/*
                      A missing line is not a category question, so it sits
                      apart from the radios: adding it changes the gap rather
                      than explaining it, and often closes it entirely.
                    */}
                    <button
                      type="button"
                      onClick={addAddedItem}
                      className="tap-inline mt-2.5 border-t border-tone-accent/20 pt-2 text-xs font-medium text-tone-brand transition hover:underline"
                    >
                      + An item is missing — add it to the list
                    </button>
                  </fieldset>
                ) : null}
              </fieldset>
            ) : !isSplit ? (
              <Field
                label="Category"
                htmlFor="category"
                required
                hint="One receipt often covers more than one kind of spending — split it if this one does."
              >
                <CategorySelect
                  id="category"
                  value={splits[0]!.categoryId}
                  onChange={(id) => updateSplit(0, { categoryId: id })}
                />
              </Field>
            ) : (
              <fieldset>
                <legend className="text-sm font-medium text-ink-700">
                  Split across categories
                  <span className="ml-1 text-tone-danger" title="Required">
                    <span aria-hidden>*</span>
                    <span className="sr-only">(required)</span>
                  </span>
                </legend>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  Every peso on the receipt has to land in a category, so the parts add up to the total
                  you confirmed above.
                </p>

                <ul className="mt-2 space-y-2">
                  {splits.map((split, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <label htmlFor={`split-category-${i}`} className="sr-only">
                          Category for part {i + 1}
                        </label>
                        <CategorySelect
                          id={`split-category-${i}`}
                          value={split.categoryId}
                          onChange={(id) => updateSplit(i, { categoryId: id })}
                        />
                      </div>
                      <div className="w-36 shrink-0">
                        <label htmlFor={`split-amount-${i}`} className="sr-only">
                          Amount for part {i + 1}
                        </label>
                        <MoneyInput
                          id={`split-amount-${i}`}
                          min={0.01}
                          required
                          value={split.amount}
                          onChange={(e) =>
                            updateSplit(i, { amount: e.target.value === "" ? "" : Number(e.target.value) })
                          }
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeSplit(i)}
                        aria-label={`Remove part ${i + 1}`}
                        className="tap mt-0.5 h-11 w-9 min-h-0 min-w-0 shrink-0 rounded-lg text-ink-500 transition hover:bg-paper-100 hover:text-tone-danger"
                      >
                        <span aria-hidden>×</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <p
                  aria-live="polite"
                  className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
                    unallocatedCentavos === 0 ? "text-tone-brand" : "text-tone-accent"
                  }`}
                >
                  <span aria-hidden>{unallocatedCentavos === 0 ? "✓" : "⚠"}</span>
                  {unallocatedCentavos === 0 ? (
                    <>The parts add up to the receipt total.</>
                  ) : unallocatedCentavos > 0 ? (
                    <>
                      <Money value={unallocatedCentavos / 100} /> of the total isn't assigned yet.
                    </>
                  ) : (
                    <>
                      The parts are <Money value={-unallocatedCentavos / 100} /> over the receipt total.
                    </>
                  )}
                </p>
              </fieldset>
            )}

            {/* Splitting by hand is for receipts FinSight could NOT itemise. */}
            {!isItemised ? (
              <button
                type="button"
                onClick={addSplit}
                className="tap-inline text-sm font-medium text-tone-brand transition hover:underline"
              >
                + Add another category
              </button>
            ) : null}

            {isItemised && hasHistoryCategoryMatches ? (
              <Callout tone="info">
                <b className="font-semibold">Categories matched from your receipt history.</b>
                <ResultDetails label="Category suggestion details">
                  <p>
                    Matches use item names and vendors from receipt records you already confirmed. Change any
                    category that does not fit; your choices are saved when you confirm.
                  </p>
                </ResultDetails>
              </Callout>
            ) : null}

            {duplicateLoading ? (
              <p className="text-xs text-ink-500" role="status">Checking for possible duplicate receipts…</p>
            ) : null}

            {duplicateReview ? (
              <section
                aria-labelledby="duplicate-review-title"
                className="space-y-3 rounded-xl border border-edge-warning bg-tint-warning p-4"
              >
                <div>
                  <h2 id="duplicate-review-title" className="text-sm font-semibold text-ink-900">
                    Possible duplicate {duplicateReview.candidateCount === 1 ? "receipt" : "receipts"}
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-ink-600">
                    {duplicateReview.changed
                      ? "The matches changed while you were reviewing. Check this current list before choosing again."
                      : "FinSight found an earlier record with matching details. Compare it before saving another copy."}
                  </p>
                </div>
                <ul className="space-y-2">
                  {duplicateReview.candidates.map((candidate) => (
                    <li key={candidate.id} className="rounded-lg border border-paper-200 bg-paper px-3 py-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-sm font-medium text-ink-800">
                          {candidate.vendor?.trim() || "Earlier expense"}
                        </span>
                        <Money value={candidate.total} />
                      </div>
                      <p className="mt-1 text-xs text-ink-600">
                        <time dateTime={candidate.date}>{candidate.date.slice(0, 10)}</time>
                        {candidate.reasons.length > 0
                          ? ` · ${candidate.reasons.map((reason) => DUPLICATE_REASON_COPY[reason]).join(", ")}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
                {!duplicateListComplete ? (
                  <div className="space-y-2">
                    <p className="text-xs text-ink-600" role="status">
                      Showing {duplicateReview.candidates.length} of {duplicateReview.candidateCount} matches.
                      Load the rest before deciding.
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={duplicateLoading}
                      onClick={() => { void loadMoreDuplicateCandidates(); }}
                    >
                      {duplicateLoading ? "Loading matches…" : "Load remaining matches"}
                    </Button>
                  </div>
                ) : (
                  <Checkbox
                    checked={duplicateAcknowledged}
                    onChange={(checked) => {
                      setDuplicateAcknowledged(checked);
                      if (checked) setConfirmError(null);
                    }}
                    label="I reviewed these matches and still want to save this receipt."
                    hint="This choice applies to this full list. If the list changes, FinSight will ask again."
                  />
                )}
              </section>
            ) : null}

            {confirmError ? <FormError>{confirmError}</FormError> : null}

            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="primary"
                disabled={
                  confirming
                  || !readyToConfirm
                  || Boolean(foreignCurrency)
                  || (duplicateReview !== null && (!duplicateListComplete || !duplicateAcknowledged))
                }
                className="flex-1"
              >
                {confirming
                  ? "Saving…"
                  : (() => {
                      // The label promises the number of RECORDS, which on the
                      // itemised path is the number of category groups — not
                      // the number of items. Fourteen groceries in two
                      // categories save as two expenses, and the button has to
                      // say so or the Records table is a surprise.
                      const n = isItemised ? itemGroups.length : isSplit ? splits.length : 1;
                      if (duplicateReview) return n === 1 ? "Save anyway" : `Save anyway as ${n} expenses`;
                      return n === 1 ? "Confirm & save expense" : `Confirm & save ${n} expenses`;
                    })()}
              </Button>
              <Button type="button" variant="secondary" onClick={handleRescan} disabled={confirming}>
                Choose another image
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void deleteUnconfirmedScan(scan)}
                disabled={confirming || deletingScanId !== null}
              >
                {deletingScanId === scan.id ? "Deleting…" : "Delete scan"}
              </Button>
            </div>
          </form>
        </Card>

        <Card className="p-4 lg:sticky lg:top-24 lg:self-start">
          {receiptPreview ?? (
            <p className="py-8 text-center text-sm text-ink-500">
              The photo isn't available to show here, but the values below are the ones FinSight read from
              it.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
