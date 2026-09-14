import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { ResultDetails } from "../../components/ResultDetails";
import { RECEIPT_MIME_TYPES, receiptFileError, receiptMimeType } from "../../lib/importFiles";
import { useImportOperation } from "../../lib/useImportOperation";
import { newIdempotencyKey } from "../../lib/csvImport";
import { Button, Card, ErrorNote, Field, Money, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api } from "../../lib/api";
import { describeActionFailure, saveFailureMessage, toLoadFailure } from "../../lib/connectionState";
import {
  buildItemisedConfirmPayload,
  buildReceiptConfirmPayload,
  gapCentavos,
  type ReconciliationPlan,
} from "../../lib/receiptConfirm";
import { rowsToApplySuggestionTo, suggestedNewCategory } from "../../lib/categorySuggestion";
import { BAND_COPY, confidenceBand, needsAttention, scanConfidenceBand } from "../../lib/confidenceBands";
import {
  evidenceSummary,
  fieldsNeedingAttention,
  warningHeadline,
  warningPageSuffix,
  warningTone,
} from "../../lib/receiptWarnings";
import { ReceiptCamera } from "../../components/receipt-camera";
import type { ReceiptCameraHandle } from "../../components/receipt-camera/ReceiptCamera";
import { canAddSection, CAPTURE_QUALITY } from "../../lib/receiptCapture";
import { analysisImageUri } from "../../lib/analysisImage";
import { setFlash } from "../../lib/flash";
import { SkeletonBox } from "../../components/Skeleton";
import { DateField } from "../../components/DateField";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../../lib/haptics";
import { font, radius, space, typeScale } from "../../theme/tokens";
import { TAP_FLOOR } from "../../components/touchTarget";
import { useTheme } from "../../context/ThemeContext";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { CategoryPicker, todayISO } from "./shared";
import { ScanBand } from "./scanReceipt/ScanBand";
import { ScanningThumbnail } from "./scanReceipt/ScanningThumbnail";
import { ReviewNotices } from "./scanReceipt/ReviewNotices";
import { ReviewSection } from "./scanReceipt/ReviewSection";
import { EvidenceNote } from "./scanReceipt/EvidenceNote";
import { CategoryChips } from "./scanReceipt/CategoryChips";
import { GapOption } from "./scanReceipt/GapOption";
import { pollUntilRead, pagesFromSections, ReceiptReadFailure, sectionsFromPages } from "./scanReceipt/helpers";
import {
  canMoveWithinReceipt,
  groupReceiptMembers,
  makeReceiptGroupsExplicit,
  MAX_RECEIPTS_PER_CAPTURE_BATCH,
  newReceiptGroupId,
  receiptGroupKey,
} from "../../lib/receiptGrouping";
import {
  inspectReceiptUpload,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
  type ReceiptUploadIssue,
} from "../../lib/receiptUploadContract";
import { localFileByteSize } from "../../lib/localFileSize";
import { ReceiptProviderConsent } from "./scanReceipt/ReceiptProviderConsent";
import { ReceiptEvidenceViewer } from "./scanReceipt/ReceiptEvidenceViewer";
import { ActiveReceiptQueue, type ReceiptResumeAction } from "./scanReceipt/ActiveReceiptQueue";
import { seedLocalReceipts, summaryFromScan } from "./scanReceipt/activeReceipts";
import { deleteReceiptScannerFiles } from "../../lib/receiptScannerCache";
import {
  duplicateCandidatePageFromResponse,
  duplicateReasonLabel,
  duplicateReviewFromError,
  duplicateReviewIsComplete,
  type ReceiptDuplicateDecision,
  type ReceiptDuplicateReview,
} from "./scanReceipt/duplicateReview";
import type { CapturedPage, ReceiptHistoryItem, ReceiptHistoryPage, ReceiptPurgeJob, ReceiptScanResult, ReviewNotice } from "./scanReceipt/types";

const MIB = 1024 * 1024;

interface ReceiptCaptureBatch {
  id: number;
  businessProfileId: number;
  expectedReceiptCount: number;
  status: "COLLECTING" | "PROCESSING" | "READY_FOR_REVIEW" | "PARTIAL_FAILURE" | "FAILED" | "COMPLETE" | "CANCELLED";
  uploadedReceiptCount: number;
  createdAt: string;
  finishedAt: string | null;
  receipts: {
    receiptOrdinal: number;
    id: number;
    processingStatus: "Processing" | "Complete" | "Failed";
    confirmationStatus: "Pending" | "Confirmed";
    processingError: string | null;
    processingErrorCode: string | null;
    extractedDate: string | null;
    extractedVendor: string | null;
    extractedAmount: number | null;
    allowedActions: { retryProcessing: boolean; reviewResult: boolean };
  }[];
}

interface ReceiptBatchChild {
  batchId: number;
  ordinal: number;
  /** Present for a newly created batch; history summaries expose only this child's binding. */
  expectedReceiptCount?: number;
}

interface QueuedReceipt {
  pages: CapturedPage[];
  batchChild: ReceiptBatchChild;
  /** Present only after the server has accepted this child and owns its images. */
  accepted: ReceiptScanResult | null;
}

type ScanRecoveryAction = "review" | "retry" | null;
type ScanRunMode = "upload" | "review" | "retry";
type CameraIntent =
  | { kind: "replace-all" }
  | { kind: "replace-group"; groupKey: string; groupId: string }
  | { kind: "append-receipt"; groupId: string };

const RECEIPT_PROCESSING_MODES = new Set([
  "original",
  "manual-crop",
  "native-selected",
  "clear-colour",
  "grayscale",
  "black-white",
]);

function validEvidenceVariant(value: unknown, variant: "source" | "derived") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const dimension = (candidate: unknown) => candidate === null
    || (Number.isInteger(candidate) && Number(candidate) > 0 && Number(candidate) <= 40000);
  return data.variant === variant
    && typeof data.label === "string" && data.label.length > 0 && data.label.length <= 80
    && dimension(data.width) && dimension(data.height);
}

/** Rejects a mismatched scan or evidence map before it can drive review UI. */
function verifiedReceiptScan(
  value: unknown,
  expectedId?: number,
  expectedBusinessProfileId?: number,
  expectedBatchChild?: Pick<ReceiptBatchChild, "batchId" | "ordinal"> | null,
): ReceiptScanResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FinSight returned a receipt result that could not be verified.");
  }
  const result = value as ReceiptScanResult;
  if (!Number.isInteger(result.id) || result.id <= 0
    || (expectedId !== undefined && result.id !== expectedId)
    || !Number.isInteger(result.businessProfileId) || result.businessProfileId <= 0
    || (expectedBusinessProfileId !== undefined && result.businessProfileId !== expectedBusinessProfileId)
    || (result.receiptBatchId !== null && (!Number.isInteger(result.receiptBatchId) || result.receiptBatchId <= 0))
    || (result.receiptOrdinal !== null && (!Number.isInteger(result.receiptOrdinal) || result.receiptOrdinal <= 0))
    || ((result.receiptBatchId === null) !== (result.receiptOrdinal === null))
    || (expectedBatchChild === null && (result.receiptBatchId !== null || result.receiptOrdinal !== null))
    || (expectedBatchChild !== undefined && expectedBatchChild !== null && (
      result.receiptBatchId !== expectedBatchChild.batchId
      || result.receiptOrdinal !== expectedBatchChild.ordinal
    ))
    || !Number.isInteger(result.scanRevision) || result.scanRevision < 0
    || (result.confirmationStatus !== "Pending"
      && result.confirmationStatus !== "Confirmed"
      && result.confirmationStatus !== "Deletion Pending")) {
    throw new Error("FinSight returned a receipt result that could not be verified.");
  }
  if (result.pageEvidence !== undefined) {
    if (!Array.isArray(result.pageEvidence) || result.pageEvidence.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
      throw new Error("FinSight returned receipt image evidence that could not be verified.");
    }
    for (const [index, page] of result.pageEvidence.entries()) {
      if (!page || page.pageNumber !== index + 1
        || (page.captureMode !== null && page.captureMode !== "standard" && page.captureMode !== "long")
        || !RECEIPT_PROCESSING_MODES.has(page.processingMode)
        || (page.ocrInput !== "source" && page.ocrInput !== "derived")
        || !validEvidenceVariant(page.source, "source")
        || (page.derived !== null && !validEvidenceVariant(page.derived, "derived"))
        || (page.ocrInput === "derived" && page.derived === null)) {
        throw new Error("FinSight returned receipt image evidence that could not be verified.");
      }
    }
  }
  return result;
}

function storedReceiptPages(result: ReceiptScanResult, pageCount: number): CapturedPage[] {
  const evidence = [...(result.pageEvidence ?? [])].sort((left, right) => left.pageNumber - right.pageNumber);
  const count = Math.max(1, pageCount, evidence.length);
  return Array.from({ length: count }, (_, index) => {
    const page = evidence.find((candidate) => candidate.pageNumber === index + 1);
    return {
      key: `stored-${result.id}-${index + 1}`,
      uri: "",
      fileName: `stored-receipt-${result.id}-page-${index + 1}.jpg`,
      mimeType: "image/jpeg",
      originalMimeType: "image/jpeg",
      quality: null,
      checkingQuality: false,
      width: page?.derived?.width ?? page?.source.width ?? 0,
      height: page?.derived?.height ?? page?.source.height ?? 0,
      originalWidth: page?.source.width ?? 0,
      originalHeight: page?.source.height ?? 0,
      captureMode: page?.captureMode ?? undefined,
      processingMode: page?.processingMode,
    };
  });
}

function scannerFileUris(list: readonly CapturedPage[]): (string | undefined)[] {
  return list.flatMap((page) => [page.originalUri, page.uri]);
}

/**
 * Capture (custom camera or gallery; optional native scanner rollout flag) →
 * approve/reorder sections → upload to the existing backend receipt endpoint
 * → editable review → confirm.
 *
 * ReceiptCamera owns capture, gallery, ordered sections and image review.
 * Explicit quality/crop actions use the server's non-persistent helpers.
 * This screen sends approved files and paired originals in reading order.
 * OCR remains server-side; none of the camera's visual guidance invents
 * receipt fields or creates an expense. Financial values stay editable until
 * owner confirmation. See docs/custom-receipt-camera-implementation.md.
 *
 * Its own supporting types, poll helper and capture-session conversions live
 * in ./scanReceipt/ — this file is the screen itself.
 */
export function ScanReceiptScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, ink, paper, statusText, statusSurface } = t;
  const { selected, categories, refreshCategories, createCategory } = useBusinessProfiles();
  const [scan, setScan] = useState<ReceiptScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Uploading receipt…");
  const [picking, setPicking] = useState(false);
  const operation = useImportOperation(selected?.id);
  const uploadAttempt = useRef<{ signature: string; key: string; accepted: ReceiptScanResult | null } | null>(null);
  const receiptBatchAttempt = useRef<{ signature: string; key: string; batch: ReceiptCaptureBatch | null } | null>(null);
  const batchChildAttempts = useRef(new Map<string, { signature: string; key: string; accepted: ReceiptScanResult | null }>());
  const batchGroupsForAcceptance = useRef<CapturedPage[][] | null>(null);

  /**
   * Photos captured so far in this session, before the receipt is scanned.
   *
   * A long receipt is photographed a page at a time via `capturePage`, which
   * appends here rather than uploading immediately — the whole session is
   * sent as one scan only once the owner taps "Scan this receipt". A single
   * photo is simply a one-page session; there is no separate code path for
   * the common case.
   */
  const [pages, setPages] = useState<CapturedPage[]>([]);
  const [queuedReceiptGroups, setQueuedReceiptGroups] = useState<QueuedReceipt[]>([]);
  const [activeBatchChild, setActiveBatchChild] = useState<ReceiptBatchChild | null>(null);
  const [scanRecoveryAction, setScanRecoveryAction] = useState<ScanRecoveryAction>(null);
  const [scanStarted, setScanStarted] = useState(false);
  const [uploadIssuePageKeys, setUploadIssuePageKeys] = useState<Record<string, true>>({});
  const [evidencePage, setEvidencePage] = useState<number | null>(null);
  const [activeReceipts, setActiveReceipts] = useState<ReceiptHistoryItem[]>([]);
  const [activeReceiptsCursor, setActiveReceiptsCursor] = useState<string | null>(null);
  const [activeReceiptsLoading, setActiveReceiptsLoading] = useState(true);
  const [activeReceiptsLoadingMore, setActiveReceiptsLoadingMore] = useState(false);
  const [activeReceiptsError, setActiveReceiptsError] = useState<string | null>(null);
  const activeReceiptsRequest = useRef<AbortController | null>(null);
  const [deletingScanId, setDeletingScanId] = useState<number | null>(null);
  const deleteScanKeys = useRef<Record<number, string>>({});

  /**
   * Whether FinSight's own camera is up.
   *
   * Closed on arrival — the capture card is the landing state, with "Scan
   * receipt" and "Choose from gallery" both visible immediately rather than
   * one behind the other. Closing the camera (a successful scan, a cancel, or
   * backing out of an unsupported/failed scanner) reveals that same card
   * instead of leaving this screen — see `onCancel`.
   *
   * A full-screen state rather than a route of its own, so backing out of the
   * camera is this screen's decision to make (see `onCancel`) rather than
   * something the Android back button and the header's back arrow each get
   * their own opinion about. It also means the modal unmounts the moment this
   * flips false — ML Kit owns its own native lifecycle while it is open, but
   * nothing here should still be holding it mounted once the owner is back on
   * this screen.
   */
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraIntent, setCameraIntent] = useState<CameraIntent>({ kind: "replace-all" });
  const receiptCameraRef = useRef<ReceiptCameraHandle>(null);

  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");

  /**
   * The owner's category for each extracted line, keyed by item id.
   *
   * Seeded from what the server assigned automatically, then owned by the
   * owner — every row is editable and nothing is written until Confirm.
   */
  const [itemCategories, setItemCategories] = useState<Record<number, number | null>>({});
  /** How they want to account for any difference between items and total. */
  const [plan, setPlan] = useState<ReconciliationPlan>(null);
  /** The category for the "file it on its own" plan. */
  const [gapCategoryId, setGapCategoryId] = useState<number | null>(null);
  /** The proposed category currently being created, so its row can show progress. */
  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);
  /**
   * Lines the owner is adding because OCR missed them.
   *
   * Held here until Confirm, like every other answer on this screen — nothing
   * is written until they accept the whole receipt.
   */
  const [addedItems, setAddedItems] = useState<
    { key: string; name: string; amount: string; categoryId: number | null }[]
  >([]);
  /** The extracted line currently being removed, so its row can show progress. */
  const [removingItemId, setRemovingItemId] = useState<number | null>(null);
  const [editingItem, setEditingItem] = useState<{ id: number; name: string; amount: string } | null>(null);
  const [editingItemErrors, setEditingItemErrors] = useState<{ name?: string; amount?: string }>({});
  const [savingItemId, setSavingItemId] = useState<number | null>(null);
  const [duplicateReview, setDuplicateReview] = useState<ReceiptDuplicateReview | null>(null);
  const [duplicateCandidatesError, setDuplicateCandidatesError] = useState<string | null>(null);
  const duplicateReviewIdentity = useRef("");

  /** The review form's chain: Description → Vendor → Amount. */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);
  /**
   * The added-item rows chain within themselves — name hands off to the
   * amount on the SAME row, never to the next row's.
   *
   * One ref per row, held in a map keyed by the row's own `key`, because the
   * rows are produced by a `.map()`: a single shared ref would be overwritten
   * by every row rendered after the first, and typing in row one would jump
   * the cursor to the bottom of the receipt. The callback clears its entry on
   * unmount so removing a row does not leave a dead node behind.
   */
  const addedAmountRefs = useRef<Record<string, TextInput | null>>({});

  /*
   * The camera never outlives this screen.
   *
   * Opening the Modal does not blur the screen — it is part of it — so this
   * cleanup only fires when the owner genuinely navigates away: a tab press
   * that pops the stack, a notification, a deep link. Without it an
   * unmounting screen could leave an Android modal window behind with no
   * component left to close it, which shows up as an app that has quietly
   * become unresponsive.
   */
  useFocusEffect(useCallback(() => () => {
    setCameraOpen(false);
    operation.cancel();
    setBusy(false);
    setPicking(false);
    // The per-action flags are cleared in their `finally` blocks only while
    // the operation is still current, which it no longer is after cancel.
    // Left set, they would keep every row and save button disabled for as
    // long as this screen stays mounted.
    setDeletingScanId(null);
    setSavingItemId(null);
    setRemovingItemId(null);
    setCreatingCategoryFor(null);
  }, [operation]));

  const loadActiveReceipts = useCallback(async (cursor?: string) => {
    const businessProfileId = selected?.id;
    if (!businessProfileId) return;
    activeReceiptsRequest.current?.abort();
    const controller = new AbortController();
    activeReceiptsRequest.current = controller;
    if (cursor) setActiveReceiptsLoadingMore(true);
    else {
      setActiveReceiptsLoading(true);
      setActiveReceiptsError(null);
    }
    try {
      const result = await api.get<ReceiptHistoryPage>(
        "/records/receipts",
        { businessProfileId, status: "active", take: 50, cursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!result || !Array.isArray(result.items) || result.items.some((item) => item.businessProfileId !== businessProfileId)) {
        throw new Error("FinSight returned a receipt list that could not be verified for this business.");
      }
      setActiveReceipts((current) => {
        if (!cursor) return result.items;
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const item of result.items) byId.set(item.id, item);
        return [...byId.values()];
      });
      setActiveReceiptsCursor(result.nextCursor ?? null);
      setActiveReceiptsError(null);
    } catch (err) {
      if (!controller.signal.aborted) {
        setActiveReceiptsError(describeActionFailure(toLoadFailure(err), "You can still capture a new receipt."));
      }
    } finally {
      if (!controller.signal.aborted) {
        setActiveReceiptsLoading(false);
        setActiveReceiptsLoadingMore(false);
      }
    }
  }, [selected?.id]);

  useFocusEffect(useCallback(() => {
    void loadActiveReceipts();
    return () => activeReceiptsRequest.current?.abort();
  }, [loadActiveReceipts]));

  useEffect(() => {
    uploadAttempt.current = null;
    receiptBatchAttempt.current = null;
    batchChildAttempts.current.clear();
    batchGroupsForAcceptance.current = null;
    setScan(null);
    setPages([]);
    setQueuedReceiptGroups([]);
    setActiveBatchChild(null);
    setScanRecoveryAction(null);
    setScanStarted(false);
    setUploadIssuePageKeys({});
    setEvidencePage(null);
    setActiveReceipts([]);
    setActiveReceiptsCursor(null);
    setActiveReceiptsLoading(true);
    setActiveReceiptsLoadingMore(false);
    setActiveReceiptsError(null);
    setDeletingScanId(null);
    deleteScanKeys.current = {};
    setBusy(false);
    setPicking(false);
    setCategoryId(null);
    setDate("");
    setDescription("");
    setVendor("");
    setAmount("");
    setItemCategories({});
    setAddedItems([]);
    setEditingItem(null);
    setEditingItemErrors({});
    setSavingItemId(null);
    setDuplicateReview(null);
    setDuplicateCandidatesError(null);
    duplicateReviewIdentity.current = "";
    setError(null);
  }, [selected?.id]);

  const currentDuplicateIdentity = `${date.trim()}\u0000${vendor.trim()}\u0000${description.trim()}\u0000${amount.trim()}`;
  useEffect(() => {
    if (duplicateReview && duplicateReviewIdentity.current !== currentDuplicateIdentity) {
      setDuplicateReview(null);
      setDuplicateCandidatesError(null);
      duplicateReviewIdentity.current = "";
    }
  }, [currentDuplicateIdentity, duplicateReview]);

  if (!selected) return null;

  function showUploadIssues(issues: ReceiptUploadIssue[]) {
    const pageKeys: Record<string, true> = {};
    for (const issue of issues) {
      if (issue.pageKey) pageKeys[issue.pageKey] = true;
    }
    setUploadIssuePageKeys(pageKeys);
    setError(issues[0]?.message ?? "Check the receipt photos and try again.");
  }

  function invalidateUnstartedUpload() {
    uploadAttempt.current = null;
    receiptBatchAttempt.current = null;
    batchChildAttempts.current.clear();
    batchGroupsForAcceptance.current = null;
    setQueuedReceiptGroups([]);
    setActiveBatchChild(null);
    setScanRecoveryAction(null);
    setScanStarted(false);
  }

  // Scans the server already accepted stay pending there, so they enter
  // Receipts to finish at once; the refresh reconciles or, if it fails, leaves them.
  function resetForAnotherReceipt() {
    const abandoned: ReceiptHistoryItem[] = [];
    const now = Date.now();
    const current = scan ?? uploadAttempt.current?.accepted ?? null;
    if (current && current.confirmationStatus === "Pending") abandoned.push(summaryFromScan(current, now, pages.length));
    for (const receipt of queuedReceiptGroups) {
      if (receipt.accepted && receipt.accepted.confirmationStatus === "Pending" && !abandoned.some((row) => row.id === receipt.accepted!.id)) {
        abandoned.push(summaryFromScan(receipt.accepted, now, receipt.pages.length));
      }
    }
    // Starting over clears device-side files without changing the stored scan's deletion lifecycle.
    void deleteReceiptScannerFiles(scannerFileUris([
      ...pages,
      ...queuedReceiptGroups.flatMap((receipt) => receipt.pages),
    ]));
    operation.cancel();
    if (abandoned.length > 0) {
      setActiveReceipts((list) => seedLocalReceipts(list, abandoned));
      void loadActiveReceipts();
    }
    uploadAttempt.current = null;
    receiptBatchAttempt.current = null;
    batchChildAttempts.current.clear();
    batchGroupsForAcceptance.current = null;
    duplicateReviewIdentity.current = "";
    addedAmountRefs.current = {};
    setScan(null);
    setPages([]);
    setQueuedReceiptGroups([]);
    setActiveBatchChild(null);
    setScanRecoveryAction(null);
    setScanStarted(false);
    setUploadIssuePageKeys({});
    setEvidencePage(null);
    setCameraOpen(false);
    setCameraIntent({ kind: "replace-all" });
    setBusy(false);
    setPicking(false);
    setPhase("Uploading receipt…");
    setCategoryId(null);
    setDate("");
    setDescription("");
    setVendor("");
    setAmount("");
    setItemCategories({});
    setPlan(null);
    setGapCategoryId(null);
    setCreatingCategoryFor(null);
    setAddedItems([]);
    setRemovingItemId(null);
    setEditingItem(null);
    setEditingItemErrors({});
    setSavingItemId(null);
    setDuplicateReview(null);
    setDuplicateCandidatesError(null);
    setError(null);
  }

  /**
   * Adds one photograph to the session and checks its own readability
   * immediately — the point of doing this now rather than after the whole
   * set uploads is that catching a blurry PAGE 2 while the camera is still
   * open costs a tap, and catching it after costs an OCR pass, a possible
   * vision call, and a wrong set of figures the owner has to notice and undo.
   *
   * The check runs against a DIFFERENT, lightweight endpoint
   * (/records/receipts/quality-check) that does no OCR and writes nothing —
   * it exists purely so this can be cheap enough to fire on every shutter
   * press. Failing silently here is deliberate: a blur check that could not
   * run is a missed nicety, not a reason to stop the owner from adding the
   * page they just photographed.
   */
  async function addPage(asset: ImagePicker.ImagePickerAsset, task: NonNullable<ReturnType<typeof operation.begin>>) {
    const existingGroup = groupReceiptMembers(pages);
    if (!operation.current(task) || scanStarted || existingGroup.length > 1 || !canAddSection(existingGroup[0]?.length ?? 0)) return;
    const key = `${Date.now()}-${Math.random()}`;
    const uri = asset.uri;
    const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? "image/jpeg";
    const validation = receiptFileError({ name: fileName, mimeType });
    if (validation) { setError(validation); return; }
    const page: CapturedPage = {
      key,
      uri,
      fileName,
      mimeType,
      originalMimeType: mimeType,
      receiptGroupId: existingGroup[0]?.[0]?.receiptGroupId,
      quality: null,
      checkingQuality: true,
      width: asset.width,
      height: asset.height,
    };
    const nextPages = [...pages, page];
    invalidateUnstartedUpload();
    setPages(nextPages);
    setUploadIssuePageKeys({});
    setError(null);

    try {
      const inspection = await inspectReceiptUpload(nextPages, localFileByteSize);
      if (!operation.current(task)) return;
      if (!inspection.ok) {
        showUploadIssues(inspection.issues);
        setPages((prev) => prev.map((candidate) => (
          candidate.key === key ? { ...candidate, checkingQuality: false } : candidate
        )));
        return;
      }

      /*
       * SENT SMALL, KEPT LARGE. /quality-check resizes to width 400 before it
       * measures anything, so the full-resolution page this used to upload was
       * megabytes of mobile data the server decoded and threw away — once per
       * shutter press, up to eight times a receipt. `uri` above is untouched:
       * the page held in state, and the one `scanSingleReceipt` uploads for
       * OCR, is still the original capture.
       */
      const checkUri = await analysisImageUri(uri, asset.width, asset.height);
      // The manipulator always writes JPEG, so a downscaled copy must be
      // declared as one — a HEIC or PNG capture would otherwise arrive under a
      // content type the server would be right to reject.
      const downscaled = checkUri !== uri;
      const form = new FormData();
      // React Native's FormData takes this {uri,name,type} shape rather than
      // a Blob — the browser's File API isn't available here.
      form.append("file", {
        uri: checkUri,
        name: downscaled ? `quality-${Date.now()}.jpg` : fileName,
        type: downscaled ? "image/jpeg" : mimeType,
      } as any);
      const quality = await api.upload<CapturedPage["quality"]>("/records/receipts/quality-check", form, task.controller.signal);
      if (!operation.current(task)) return;
      setPages((prev) => prev.map((p) => (p.key === key ? { ...p, quality, checkingQuality: false } : p)));
    } catch {
      if (!operation.current(task)) return;
      setPages((prev) => prev.map((p) => (p.key === key ? { ...p, checkingQuality: false } : p)));
    }
  }

  function removePage(key: string) {
    if (scanStarted) return;
    invalidateUnstartedUpload();
    const removed = pages.find((page) => page.key === key);
    if (removed) void deleteReceiptScannerFiles(scannerFileUris([removed]));
    setPages((prev) => prev.filter((p) => p.key !== key));
    setUploadIssuePageKeys({});
    setError(null);
  }

  /** Moves a page earlier (delta -1) or later (delta +1) in the sequence. */
  function movePage(key: string, delta: number) {
    if (scanStarted) return;
    setPages((prev) => {
      const index = prev.findIndex((p) => p.key === key);
      const target = index + delta;
      if (!canMoveWithinReceipt(prev, index, delta)) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
    invalidateUnstartedUpload();
    setUploadIssuePageKeys({});
    setError(null);
  }

  function showReceiptResult(result: ReceiptScanResult) {
    setScan(result);
    setScanRecoveryAction(null);
    setDuplicateReview(null);
    setDuplicateCandidatesError(null);
    duplicateReviewIdentity.current = "";
    setDate(result.extractedDate ? String(result.extractedDate).slice(0, 10) : "");
    setVendor(result.extractedVendor ?? "");
    setDescription(result.extractedDescription ?? "");
    setCategoryId(result.items?.length === 1 ? result.items[0]!.categoryId : null);
    setAmount(result.extractedAmount != null ? result.extractedAmount.toFixed(2) : "");
    setItemCategories(Object.fromEntries((result.items ?? []).map((item) => [item.id, item.categoryId ?? null])));
    setAddedItems([]);
    setEditingItem(null);
    setEditingItemErrors({});
    setPlan(null);
    setGapCategoryId(null);
    if (result.visionAssisted) haptics.warned();
    else haptics.succeeded();
  }

  function uploadSignature(list: CapturedPage[], batchChild: ReceiptBatchChild | null): string {
    return `${selected!.id}:${batchChild?.batchId ?? "single"}:${batchChild?.ordinal ?? 1}:${list.map((page) => `${page.key}:${page.uri}:${page.originalUri ?? ""}`).join("|")}`;
  }

  async function acceptReceiptUpload(
    list: CapturedPage[],
    batchChild: ReceiptBatchChild | null,
    task: NonNullable<ReturnType<typeof operation.begin>>,
    phaseLabel = "Uploading receipt…",
  ) {
    const signature = uploadSignature(list, batchChild);
    const attempts = batchChild ? batchChildAttempts.current : null;
    let attempt = attempts?.get(signature) ?? uploadAttempt.current;
    if (!attempt || attempt.signature !== signature) {
      attempt = { signature, key: newIdempotencyKey(), accepted: null };
      if (attempts) attempts.set(signature, attempt);
      if (!batchChild || batchChild.ordinal === 1) uploadAttempt.current = attempt;
    }
    if (attempt.accepted) return attempt.accepted;

    const inspection = await inspectReceiptUpload(list, localFileByteSize);
    if (!operation.current(task)) return null;
    if (!inspection.ok) {
      haptics.warned();
      showUploadIssues(inspection.issues);
      return null;
    }
    setUploadIssuePageKeys({});
    setScanStarted(true);
    setPhase(phaseLabel);
    const form = new FormData();
    form.append("businessProfileId", String(selected!.id));
    form.append("idempotencyKey", attempt.key);
    if (batchChild) {
      form.append("receiptBatchId", String(batchChild.batchId));
      form.append("receiptOrdinal", String(batchChild.ordinal));
    }
    for (const object of inspection.objects) {
      const page = list[object.pageNumber - 1]!;
      const originalExtension = object.mediaType === "image/png" ? "png" : object.mediaType === "image/webp" ? "webp" : "jpg";
      form.append(object.variant === "processed" ? "files" : "originalFiles", {
        uri: object.uri,
        name: object.variant === "processed"
          ? page.fileName
          : `receipt-section-${object.pageNumber}-original.${originalExtension}`,
        type: object.mediaType,
      } as any);
    }
    form.append("captureMetadata", JSON.stringify(list.map((page) => ({
      captureMode: page.captureMode,
      source: page.captureSource,
      processingMode: page.processingMode ?? "original",
      originalWidth: page.originalWidth ?? page.width,
      originalHeight: page.originalHeight ?? page.height,
      processedWidth: page.width,
      processedHeight: page.height,
      corners: page.cropCorners,
      transformVersion: page.transformVersion,
      documentConfidence: page.documentConfidence,
      ownerOverrodeLikelihood: page.ownerOverrodeLikelihood,
    }))));
    const accepted = verifiedReceiptScan(
      await api.upload<ReceiptScanResult>("/records/receipts", form, task.controller.signal),
      undefined,
      selected!.id,
      batchChild,
    );
    if (!operation.current(task)) return null;
    attempt.accepted = accepted;
    return accepted;
  }

  async function scanSingleReceipt(
    list: CapturedPage[],
    options: {
      mode?: ScanRunMode;
      batchChild?: ReceiptBatchChild | null;
      batchGroups?: CapturedPage[][];
    } = {},
  ) {
    if (list.length === 0) return;
    const task = operation.begin();
    if (!task) return;
    const mode = options.mode ?? "upload";
    let batchChild = options.batchChild ?? null;
    let activeList = list;
    setBusy(true);
    setPhase("Checking receipt size…");
    setError(null);
    try {
      const batchGroups = options.batchGroups ?? [];
      if (batchGroups.length > 1) {
        const batchSignature = `${selected!.id}:${batchGroups
          .map((group) => group.map((page) => `${page.key}:${page.uri}:${page.originalUri ?? ""}`).join("|"))
          .join("||")}`;
        // On a resumed batch, children the server already accepted have had
        // their local files released below; inspecting them again would fail
        // on the missing files and block the children that still need sending.
        const resumedBatch = receiptBatchAttempt.current?.signature === batchSignature
          ? receiptBatchAttempt.current.batch
          : null;
        for (const [index, group] of batchGroups.entries()) {
          if (resumedBatch && batchChildAttempts.current.get(uploadSignature(group, {
            batchId: resumedBatch.id,
            ordinal: index + 1,
            expectedReceiptCount: batchGroups.length,
          }))?.accepted) {
            continue;
          }
          const inspection = await inspectReceiptUpload(group, localFileByteSize);
          if (!operation.current(task)) return;
          if (!inspection.ok) {
            haptics.warned();
            showUploadIssues(inspection.issues);
            return;
          }
        }

        if (receiptBatchAttempt.current?.signature !== batchSignature) {
          receiptBatchAttempt.current = { signature: batchSignature, key: newIdempotencyKey(), batch: null };
          batchChildAttempts.current.clear();
        }
        let batchAttempt = receiptBatchAttempt.current;
        setPhase("Creating receipt batch…");
        if (!batchAttempt.batch) {
          batchAttempt.batch = await api.post<ReceiptCaptureBatch>("/records/receipt-batches", {
            businessProfileId: selected!.id,
            clientBatchKey: batchAttempt.key,
            expectedReceiptCount: batchGroups.length,
          });
          if (!operation.current(task)) return;
        }
        if (batchAttempt.batch.status === "CANCELLED") {
          batchAttempt = { signature: batchSignature, key: newIdempotencyKey(), batch: null };
          receiptBatchAttempt.current = batchAttempt;
          setPhase("Replacing cancelled receipt batch…");
          batchAttempt.batch = await api.post<ReceiptCaptureBatch>("/records/receipt-batches", {
            businessProfileId: selected!.id,
            clientBatchKey: batchAttempt.key,
            expectedReceiptCount: batchGroups.length,
          });
          if (!operation.current(task)) return;
        }
        if (!Number.isInteger(batchAttempt.batch.id) || batchAttempt.batch.id <= 0
          || batchAttempt.batch.businessProfileId !== selected!.id
          || batchAttempt.batch.expectedReceiptCount !== batchGroups.length
          || batchAttempt.batch.status !== "COLLECTING"
          || batchAttempt.batch.uploadedReceiptCount !== 0
          || !Array.isArray(batchAttempt.batch.receipts)
          || batchAttempt.batch.receipts.length !== 0) {
          if (batchAttempt.batch.status === "CANCELLED") batchAttempt.key = newIdempotencyKey();
          batchAttempt.batch = null;
          throw new Error("This receipt batch no longer matches the selected images.");
        }
        batchChild = {
          batchId: batchAttempt.batch.id,
          ordinal: 1,
          expectedReceiptCount: batchGroups.length,
        };
        setActiveBatchChild(batchChild);
        setQueuedReceiptGroups(batchGroups.slice(1).map((group, index) => ({
          pages: group,
          batchChild: {
            batchId: batchAttempt.batch!.id,
            ordinal: index + 2,
            expectedReceiptCount: batchGroups.length,
          },
          accepted: null,
        })));
        setPages(batchGroups[0]!);
        setScanStarted(true);
        batchGroupsForAcceptance.current = batchGroups;

        let firstAccepted: ReceiptScanResult | null = null;
        for (const [index, group] of batchGroups.entries()) {
          const child: ReceiptBatchChild = {
            batchId: batchAttempt.batch.id,
            ordinal: index + 1,
            expectedReceiptCount: batchGroups.length,
          };
          const acceptedChild = await acceptReceiptUpload(
            group,
            child,
            task,
            `Uploading receipt ${index + 1} of ${batchGroups.length}…`,
          );
          if (!acceptedChild || !operation.current(task)) return;
          if (index === 0) {
            firstAccepted = acceptedChild;
            continue;
          }
          // The server has acknowledged this child, so its source images are
          // now durable. Release only this accepted child's local files.
          void deleteReceiptScannerFiles(scannerFileUris(group));
          setQueuedReceiptGroups((current) => current.map((receipt) => (
            receipt.batchChild.ordinal === child.ordinal
              ? { ...receipt, pages: [], accepted: acceptedChild }
              : receipt
          )));
        }
        if (!firstAccepted) throw new Error("FinSight did not accept the first receipt in this batch.");
        activeList = batchGroups[0]!;
        batchChild = {
          batchId: batchAttempt.batch.id,
          ordinal: 1,
          expectedReceiptCount: batchGroups.length,
        };
        // Every child is now independently durable and visible in receipt
        // history. OCR may continue while the owner reviews receipt 1.
        void loadActiveReceipts();

        const signature = `${selected!.id}:${batchChild.batchId}:${batchChild.ordinal}:${activeList.map((page) => `${page.key}:${page.uri}:${page.originalUri ?? ""}`).join("|")}`;
        const firstAttempt = batchChildAttempts.current.get(signature);
        if (!firstAttempt) throw new Error("FinSight lost the first receipt upload binding.");
        uploadAttempt.current = firstAttempt;
        batchChildAttempts.current.clear();
        batchGroupsForAcceptance.current = null;
      }

      const signature = `${selected!.id}:${batchChild?.batchId ?? "single"}:${batchChild?.ordinal ?? 1}:${activeList.map((page) => `${page.key}:${page.uri}:${page.originalUri ?? ""}`).join("|")}`;
      if (uploadAttempt.current?.signature !== signature) {
        uploadAttempt.current = { signature, key: newIdempotencyKey(), accepted: null };
      }
      const attempt = uploadAttempt.current;
      let accepted = attempt.accepted;
      if (mode === "review") {
        if (!accepted) throw new Error("This receipt has not finished uploading yet.");
        setPhase("Checking receipt result…");
        accepted = verifiedReceiptScan(
          await api.get<ReceiptScanResult>(`/records/receipts/${accepted.id}`, undefined, task.controller.signal),
          accepted.id,
          selected!.id,
          batchChild,
        );
        if (!operation.current(task)) return;
        attempt.accepted = accepted;
      } else if (mode === "retry") {
        if (!accepted) throw new Error("This receipt has not finished uploading yet.");
        setPhase("Retrying stored receipt…");
        accepted = verifiedReceiptScan(
          await api.post<ReceiptScanResult>(`/records/receipts/${accepted.id}/retry`),
          accepted.id,
          selected!.id,
          batchChild,
        );
        if (!operation.current(task)) return;
        attempt.accepted = accepted;
      } else if (!accepted) {
        accepted = await acceptReceiptUpload(activeList, batchChild, task);
        if (!accepted || !operation.current(task)) return;
        attempt.accepted = accepted;
      }
      setScanRecoveryAction("review");
      setPhase("Reading receipt…");
      // The upload returns as soon as the photos are stored; the read itself
      // finishes behind it. See pollUntilRead.
      const result = verifiedReceiptScan(
        await pollUntilRead(accepted, task.controller.signal),
        accepted.id,
        selected!.id,
        batchChild,
      );
      if (!operation.current(task)) return;
      showReceiptResult(result);
    } catch (err) {
      if (!operation.current(task)) return;
      haptics.failed();
      const hasStoredScan = Boolean(uploadAttempt.current?.accepted);
      const errorStatus = typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: unknown }).status)
        : null;
      const retryWasAmbiguous = mode === "retry" && (errorStatus === 0 || errorStatus === 409);
      if (hasStoredScan) {
        setScanRecoveryAction(err instanceof ReceiptReadFailure && err.kind === "failed" && !retryWasAmbiguous ? "retry" : "review");
      }
      setError(describeActionFailure(
        toLoadFailure(err),
        hasStoredScan
          ? "Your uploaded images and review changes are still here."
          : "Your selected images are still here.",
      ));
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  async function scanPages(list: CapturedPage[] = pages) {
    const groups = groupReceiptMembers(list);
    if (groups.length === 0) return;
    setUploadIssuePageKeys({});
    await scanSingleReceipt(groups[0]!, { batchGroups: groups });
  }

  function continueReceiptScan() {
    if (batchGroupsForAcceptance.current && queuedReceiptGroups.some((receipt) => receipt.accepted === null)) {
      return void scanSingleReceipt(pages, { batchGroups: batchGroupsForAcceptance.current });
    }
    if (scanRecoveryAction) {
      void scanSingleReceipt(pages, { mode: scanRecoveryAction, batchChild: activeBatchChild });
      return;
    }
    if (scanStarted) {
      void scanSingleReceipt(pages, { batchChild: activeBatchChild });
      return;
    }
    void scanPages();
  }

  async function resumeStoredReceipt(item: ReceiptHistoryItem, action: ReceiptResumeAction) {
    const task = operation.begin();
    if (!task) return;
    setBusy(true);
    setPhase(action === "retry" ? "Retrying stored receipt…" : action === "review" ? "Opening receipt result…" : "Reading stored receipt…");
    setError(null);
    try {
      const expectedStoredBatch = item.receiptBatchId !== null && item.receiptOrdinal !== null
        ? { batchId: item.receiptBatchId, ordinal: item.receiptOrdinal }
        : null;
      let accepted = verifiedReceiptScan(
        await api.get<ReceiptScanResult>(`/records/receipts/${item.id}`, undefined, task.controller.signal),
        item.id,
        selected!.id,
        expectedStoredBatch,
      );
      if (!operation.current(task)) return;

      const storedPages = storedReceiptPages(accepted, item.pageCount);
      const signature = `${selected!.id}:${expectedStoredBatch?.batchId ?? "single"}:${expectedStoredBatch?.ordinal ?? 1}:${storedPages.map((page) => `${page.key}:${page.uri}:${page.originalUri ?? ""}`).join("|")}`;
      uploadAttempt.current = { signature, key: newIdempotencyKey(), accepted };
      receiptBatchAttempt.current = null;
      setQueuedReceiptGroups([]);
      // Keep a discovered child's durable batch binding. If polling fails and
      // the owner taps Review result, the follow-up GET must still be checked
      // against the same batch/ordinal instead of being rejected as a single.
      setActiveBatchChild(expectedStoredBatch);
      setPages(storedPages);
      setScanStarted(true);
      setScanRecoveryAction("review");

      if (action === "retry") {
        if (!item.allowedActions.retryProcessing) throw new Error("This receipt is no longer available for processing retry.");
        accepted = verifiedReceiptScan(
          await api.post<ReceiptScanResult>(`/records/receipts/${item.id}/retry`),
          item.id,
          selected!.id,
          expectedStoredBatch,
        );
        if (!operation.current(task)) return;
        uploadAttempt.current.accepted = accepted;
      }

      setPhase("Reading receipt…");
      const result = verifiedReceiptScan(
        await pollUntilRead(accepted, task.controller.signal),
        accepted.id,
        selected!.id,
        expectedStoredBatch,
      );
      if (!operation.current(task)) return;
      showReceiptResult(result);
    } catch (err) {
      if (!operation.current(task)) return;
      haptics.failed();
      const hasStoredScan = Boolean(uploadAttempt.current?.accepted);
      const errorStatus = typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: unknown }).status)
        : null;
      const retryWasAmbiguous = action === "retry" && (errorStatus === 0 || errorStatus === 409);
      if (hasStoredScan) {
        setScanRecoveryAction(err instanceof ReceiptReadFailure && err.kind === "failed" && !retryWasAmbiguous ? "retry" : "review");
      }
      setError(describeActionFailure(toLoadFailure(err), "This receipt and its stored images are still available."));
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  function confirmDeleteStoredScan(scanId: number) {
    Alert.alert(
      "Delete this receipt scan?",
      "This permanently removes its stored source and processed images. A confirmed expense record is not deleted.",
      [
        { text: "Keep scan", style: "cancel" },
        { text: "Delete scan", style: "destructive", onPress: () => { void deleteStoredScan(scanId); } },
      ],
    );
  }

  async function deleteStoredScan(scanId: number) {
    const task = operation.begin();
    if (!task) return;
    const isCurrent = scan?.id === scanId || uploadAttempt.current?.accepted?.id === scanId;
    setDeletingScanId(scanId);
    if (isCurrent) setError(null);
    else setActiveReceiptsError(null);
    try {
      const idempotencyKey = deleteScanKeys.current[scanId] ?? newIdempotencyKey();
      deleteScanKeys.current[scanId] = idempotencyKey;
      const job = await api.delete<ReceiptPurgeJob>(
        `/records/receipts/${scanId}`,
        undefined,
        { "Idempotency-Key": idempotencyKey },
      );
      if (!operation.current(task)) return;
      if (job.receiptScanId !== scanId || !Number.isInteger(job.id)) {
        throw new Error("FinSight returned a deletion result that did not match this receipt scan.");
      }

      if (isCurrent) void deleteReceiptScannerFiles(scannerFileUris(pages));

      delete deleteScanKeys.current[scanId];
      setActiveReceipts((current) => current.filter((item) => item.id !== scanId));
      if (isCurrent) {
        uploadAttempt.current = null;
        batchChildAttempts.current.clear();
        batchGroupsForAcceptance.current = null;
        setScan(null);
        setCategoryId(null);
        setDate("");
        setDescription("");
        setVendor("");
        setAmount("");
        setItemCategories({});
        setAddedItems([]);
        setEditingItem(null);
        setEditingItemErrors({});
        setPlan(null);
        setGapCategoryId(null);
        setEvidencePage(null);
        setScanRecoveryAction(null);
        setUploadIssuePageKeys({});
        receiptBatchAttempt.current = null;
        // Children the server never accepted exist only as local files, so
        // they become a fresh capture session instead of being dropped.
        const storedSiblings = queuedReceiptGroups.some((receipt) => receipt.accepted !== null);
        const unsentPages = queuedReceiptGroups
          .filter((receipt) => receipt.accepted === null)
          .flatMap((receipt) => receipt.pages);
        setQueuedReceiptGroups([]);
        setPages(unsentPages);
        setActiveBatchChild(null);
        setScanStarted(false);
        setFlash(
          unsentPages.length > 0 && storedSiblings
            ? "Receipt scan deletion started. The receipts you haven't sent yet are still here, ready to scan. The other stored receipts from this batch are still in Receipts to finish."
            : unsentPages.length > 0
              ? "Receipt scan deletion started. The receipts you haven't sent yet are still here, ready to scan."
              : storedSiblings
                ? "Receipt scan deletion started. The other stored receipts from this batch are still in Receipts to finish."
                : "Receipt scan deletion started.",
        );
        void loadActiveReceipts();
      } else {
        setFlash("Receipt scan deletion started.");
      }
    } catch (err) {
      if (!operation.current(task)) return;
      const failure = toLoadFailure(err);
      const message = failure.reach === "unreachable"
        ? "FinSight couldn't confirm whether deletion started. This scan stays shown here; try Delete scan again when your connection is back."
        : `${failure.message} The receipt scan and its stored images have not been deleted.`;
      if (isCurrent) setError(message);
      else setActiveReceiptsError(message);
    } finally {
      if (operation.current(task)) setDeletingScanId(null);
      operation.finish(task);
    }
  }

  function chooseAnotherImage() {
    Alert.alert(
      "Choose another image?",
      "This removes the images in this capture session. Any uploaded scan stays private until FinSight's abandoned-scan cleanup removes it.",
      [
        { text: "Keep these images", style: "cancel" },
        {
          text: "Choose another image",
          style: "destructive",
          onPress: resetForAnotherReceipt,
        },
      ],
    );
  }

  /**
   * Opens FinSight's own camera.
   *
   * Permission is NOT requested here any more. The camera screen owns that
   * conversation, because it is the thing that can explain what the camera is
   * for, offer the gallery instead, and point at Settings once the system has
   * stopped asking — none of which a one-line error on this card could do.
   */
  function openCamera(intent: CameraIntent) {
    if (busy || picking || scanStarted) return;
    haptics.committed();
    setError(null);
    setCameraIntent(intent);
    setCameraOpen(true);
  }

  function capturePage() {
    const groups = groupReceiptMembers(pages);
    if (groups.length <= 1) {
      openCamera({ kind: "replace-all" });
      return;
    }
    reviewReceipt(0);
  }

  function reviewReceipt(index: number) {
    if (busy || picking || scanStarted) return;
    const explicit = makeReceiptGroupsExplicit(pages);
    const group = groupReceiptMembers(explicit)[index];
    if (!group?.[0]?.receiptGroupId) return;
    setPages(explicit);
    openCamera({
      kind: "replace-group",
      groupKey: receiptGroupKey(group[0]),
      groupId: group[0].receiptGroupId,
    });
  }

  function captureSeparateReceipt() {
    if (groupReceiptMembers(pages).length >= MAX_RECEIPTS_PER_CAPTURE_BATCH) return;
    const explicit = makeReceiptGroupsExplicit(pages);
    setPages(explicit);
    openCamera({ kind: "append-receipt", groupId: newReceiptGroupId() });
  }

  /**
   * The gallery fallback, unchanged in behaviour and deliberately kept.
   *
   * A receipt someone already photographed, a screenshot of an e-receipt, and
   * a phone whose owner will not grant camera access are all real, and none
   * of them is served by a scanner. This is also the path that keeps working
   * if anything about the new camera turns out to be wrong on a device — the
   * reason it was preserved before the camera was touched at all.
   *
   * Quality is raised to match the camera's: it is the same OCR reading the
   * same faint thermal print, and there is no reason a gallery image should
   * arrive more compressed than a captured one.
   */
  async function pickPage() {
    const task = operation.begin();
    if (!task) return;
    setPicking(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ quality: CAPTURE_QUALITY, mediaTypes: ["images"] });
      if (!res.canceled && res.assets[0]) await addPage(res.assets[0], task);
    } catch (err) {
      if (operation.current(task)) setError(describeActionFailure(toLoadFailure(err), "Choose another photo or use the camera."));
    } finally {
      if (operation.current(task)) setPicking(false);
      operation.finish(task);
    }
  }

  async function pickFile() {
    const task = operation.begin();
    if (!task) return;
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: RECEIPT_MIME_TYPES, copyToCacheDirectory: true });
      if (!operation.current(task) || result.canceled || !result.assets[0]) return;
      const file = result.assets[0];
      const validation = receiptFileError({ name: file.name, mimeType: file.mimeType });
      if (validation) { setError(validation); return; }
      const dimensions = await Image.getSize(file.uri);
      await addPage({ uri: file.uri, width: dimensions.width, height: dimensions.height, fileName: file.name, mimeType: file.mimeType === "application/octet-stream" ? receiptMimeType(file.name) : file.mimeType ?? receiptMimeType(file.name), fileSize: file.size }, task);
    } catch (err) {
      if (operation.current(task)) setError(describeActionFailure(toLoadFailure(err), "Choose another receipt image."));
    } finally {
      if (operation.current(task)) setPicking(false);
      operation.finish(task);
    }
  }

  /*
   * Two review modes, exactly as web has.
   *
   * A receipt whose lines FinSight could read is reviewed ITEM BY ITEM — that
   * is the point of the feature, and it is what lets "buns" land in
   * Ingredients while "rice cooker" lands in Equipment without the owner
   * deciding anything up front. A receipt with one line or none keeps the
   * single-category flow: a grouping UI for one item would be ceremony around
   * a decision the category picker already makes.
   */
  const items = scan?.items ?? [];
  const foreignCurrency = scan?.receiptDetails?.currency && scan.receiptDetails.currency !== "PHP" ? scan.receiptDetails.currency : null;
  const requiresManualCurrencyConversion = Boolean(scan?.requiresManualCurrencyConversion || foreignCurrency);
  const isItemised = items.length > 1;
  /** An added line only counts once it is actually usable. */
  const usableAddedItems = addedItems.filter(
    (a) => a.name.trim() !== "" && Number(a.amount) > 0 && a.categoryId != null,
  );
  // Added lines count toward the items' total the moment they are complete, so
  // adding a missed line closes the gap immediately rather than after saving.
  const itemsTotal =
    items.reduce((sum, i) => sum + i.amount, 0) +
    usableAddedItems.reduce((sum, a) => sum + Number(a.amount), 0);
  const totalValue = Number(amount);
  const gap = Number.isFinite(totalValue) ? gapCentavos(totalValue, itemsTotal) : 0;
  const everyItemHasCategory =
    items.every((i) => itemCategories[i.id] != null) &&
    // A half-typed added row must not enable Confirm.
    addedItems.length === usableAddedItems.length;
  // A discount can't become its own expense record — that would be a negative
  // expense, which nothing downstream understands. The server refuses it too.
  const canFileGapOnItsOwn = gap > 0;
  const planResolved =
    gap === 0 ||
    plan === "proportional" ||
    plan === "shrink" ||
    (plan === "category" && canFileGapOnItsOwn && gapCategoryId != null);

  async function finishReceiptConfirmation(task: NonNullable<ReturnType<typeof operation.begin>>) {
    // Cache cleanup must not delay or overturn a confirmed financial write.
    void deleteReceiptScannerFiles(scannerFileUris(pages));
    haptics.succeeded();
    setDuplicateReview(null);
    setDuplicateCandidatesError(null);
    duplicateReviewIdentity.current = "";
    if (queuedReceiptGroups.length > 0) {
      const [next, ...remaining] = queuedReceiptGroups;
      if (!next?.accepted) {
        throw new Error("FinSight has not accepted every receipt in this batch yet.");
      }
      const storedPages = storedReceiptPages(next.accepted, next.pages.length);
      const signature = `${selected!.id}:${next.batchChild.batchId}:${next.batchChild.ordinal}:${storedPages.map((page) => `${page.key}:${page.uri}:${page.originalUri ?? ""}`).join("|")}`;
      uploadAttempt.current = { signature, key: newIdempotencyKey(), accepted: next.accepted };
      setQueuedReceiptGroups(remaining);
      setPages(storedPages);
      setActiveBatchChild(next.batchChild);
      setUploadIssuePageKeys({});
      setScan(null);
      setCategoryId(null);
      setDate("");
      setDescription("");
      setVendor("");
      setAmount("");
      setItemCategories({});
      setAddedItems([]);
      setEditingItem(null);
      setEditingItemErrors({});
      setPlan(null);
      setGapCategoryId(null);
      setFlash(`Receipt saved. ${remaining.length + 1} stored receipt${remaining.length === 0 ? "" : "s"} remain to review.`);
      operation.finish(task);
      await scanSingleReceipt(storedPages, { batchChild: next.batchChild });
      return;
    }
    setFlash("Receipt saved to your records.");
    navigation.goBack();
  }

  async function confirm(duplicateDecision?: ReceiptDuplicateDecision) {
    if (requiresManualCurrencyConversion) return setError("Enter this receipt manually in PHP.");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (isItemised) {
      if (!everyItemHasCategory) return setError("Every item needs a category before this can be saved.");
      if (!planResolved) return setError("Choose how to account for the difference first.");
    } else if (!categoryId) {
      return setError("Choose a category first.");
    }
    if (!date) return setError("Enter the date printed on the receipt.");
    const task = operation.begin();
    if (!task) return;

    setBusy(true);
    setError(null);
    try {
      // Both shapes and their rules live in lib/receiptConfirm, where they can
      // be tested against the server's schema — this call is what silently
      // broke against it before.
      const details = isItemised
        ? buildItemisedConfirmPayload({
            date,
            description,
            vendor,
            totalAmount: value,
            itemsTotal,
            itemAssignments: items.map((i) => ({ itemId: i.id, categoryId: itemCategories[i.id]! })),
            additionalItems: usableAddedItems.map((a) => ({
              name: a.name.trim(),
              amount: Number(a.amount),
              categoryId: a.categoryId!,
            })),
            plan,
            gapCategoryId,
          })
        : buildReceiptConfirmPayload({ date, description, vendor, amount: value, categoryId: categoryId! });
      const payload = {
        ...details,
        expectedScanRevision: scan!.scanRevision,
        ...(duplicateDecision ? { duplicateDecision } : {}),
      };

      await api.post(`/records/receipts/${scan!.id}/confirm`, payload);
      if (!operation.current(task)) return;
      await finishReceiptConfirmation(task);
    } catch (err) {
      if (!operation.current(task)) return;
      const duplicate = duplicateReviewFromError(err);
      if (duplicate) {
        duplicateReviewIdentity.current = currentDuplicateIdentity;
        setDuplicateReview(duplicate);
        setDuplicateCandidatesError(null);
        setError(null);
        haptics.warned();
        return;
      }

      const status = typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: unknown }).status)
        : null;
      const responseWasAmbiguous = status === 0
        || status === 409
        || (status !== null && status >= 500)
        || err instanceof SyntaxError;
      if (responseWasAmbiguous) {
        try {
          const latest = verifiedReceiptScan(
            await api.get<ReceiptScanResult>(`/records/receipts/${scan!.id}`, undefined, task.controller.signal),
            scan!.id,
            selected!.id,
          );
          if (!operation.current(task)) return;
          if (latest.confirmationStatus === "Confirmed") {
            await finishReceiptConfirmation(task);
            return;
          }
          setScan(latest);
          setItemCategories((current) => Object.fromEntries((latest.items ?? []).map((item) => [
            item.id,
            current[item.id] ?? item.categoryId ?? null,
          ])));
          setError(status === 409
            ? "This receipt changed before it was saved. The latest scan result is shown, and your review changes are kept. Check it before saving again."
            : "FinSight did not confirm whether the save request arrived. The receipt is still pending, and your review changes are kept. Try saving again.");
          return;
        } catch {
          if (!operation.current(task)) return;
          setError("FinSight couldn't confirm whether the receipt was saved. Your review changes and images are still here. Check your connection, then try again.");
          return;
        }
      }

      // Every correction and photograph remains in place until confirmation.
      setError(saveFailureMessage(err, "Save this expense"));
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  async function loadRemainingDuplicateCandidates() {
    const review = duplicateReview;
    if (!review?.nextCursor || duplicateReviewIsComplete(review)) return;
    const task = operation.begin();
    if (!task) return;
    const reviewIdentity = duplicateReviewIdentity.current;
    setBusy(true);
    setDuplicateCandidatesError(null);
    try {
      const response = await api.get<unknown>(
        `/records/receipts/${scan!.id}/duplicate-candidates`,
        { cursor: review.nextCursor, take: 20 },
        task.controller.signal,
      );
      if (!operation.current(task) || duplicateReviewIdentity.current !== reviewIdentity) return;
      const page = duplicateCandidatePageFromResponse(response, review);
      const existingIds = new Set(review.candidates.map((candidate) => candidate.id));
      const duplicatesExisting = page?.candidates.some((candidate) => existingIds.has(candidate.id));
      const merged = page ? [...review.candidates, ...page.candidates] : [];
      const inconsistentCount = !page
        || duplicatesExisting
        || merged.length > review.candidateCount
        || (page.nextCursor === null && merged.length !== review.candidateCount)
        || (page.nextCursor !== null && merged.length >= review.candidateCount);
      if (inconsistentCount) {
        setDuplicateReview(null);
        duplicateReviewIdentity.current = "";
        setError("The possible matches changed while they were loading. Select Save again to review the latest complete list.");
        return;
      }
      setDuplicateReview({
        ...review,
        candidates: merged,
        candidatesTruncated: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      if (operation.current(task)) {
        setDuplicateCandidatesError(describeActionFailure(
          toLoadFailure(err),
          "The matches already shown are still here. Try loading the rest again.",
        ));
      }
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  /**
   * The standing "nothing fitted this" category, if this business has one.
   *
   * Created server-side on demand during a scan, so it may not exist at all,
   * and matched case-insensitively because an owner who already had their own
   * keeps it — the same rule the server follows.
   */
  const uncategorisedId = categories.find((c) => c.name.toLowerCase() === "uncategorized")?.id ?? null;

  /** See lib/categorySuggestion — the rule has edge cases worth testing. */
  function suggestedNewCategoryFor(item: { id: number; suggestedCategoryName?: string | null }): string | null {
    return suggestedNewCategory(
      item,
      itemCategories[item.id] ?? null,
      uncategorisedId,
      categories.map((c) => c.name),
    );
  }

  /**
   * Accepts a category FinSight proposed for items nothing existing fitted.
   *
   * Creates it, then files every UNPLACED row it was proposed for — not only
   * the row that was tapped. A grocery run proposes "Packaging" on all four
   * packaging lines, and making the owner create it once then assign it three
   * more times by hand would be busywork on a decision already made. Rows they
   * placed themselves are left alone, and everything stays editable.
   */
  async function acceptSuggestedCategory(name: string) {
    const task = operation.begin();
    if (!task) return;
    setCreatingCategoryFor(name);
    setError(null);
    try {
      // createCategory puts the new row into the shared list itself, so the
      // refreshCategories() that used to follow this is gone — it was a second
      // round trip to learn what the response already said.
      const created = await createCategory({ name });
      if (!operation.current(task)) return;
      setItemCategories((prev) => {
        const next = { ...prev };
        for (const id of rowsToApplySuggestionTo(items, name, prev, uncategorisedId)) {
          next[id] = created.id;
        }
        return next;
      });
    } catch (err) {
      if (!operation.current(task)) return;
      setError(describeActionFailure(toLoadFailure(err), "The category wasn't created; your rows are unchanged."));
    } finally {
      if (operation.current(task)) setCreatingCategoryFor(null);
      operation.finish(task);
    }
  }

  async function saveScannedItem() {
    if (!scan || !editingItem) return;
    const name = editingItem.name.trim();
    const value = Number(editingItem.amount);
    const fieldErrors = {
      ...(!name ? { name: "Enter the item name printed on the receipt." } : name.length > 255 ? { name: "Use 255 characters or fewer." } : {}),
      ...(!Number.isFinite(value) || value <= 0 ? { amount: "Enter an amount greater than zero." } : {}),
    };
    setEditingItemErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;
    if (!Number.isInteger(scan.scanRevision) || scan.scanRevision < 0) {
      setError("This receipt result is missing its edit version. Review the result again before changing an item.");
      return;
    }

    const task = operation.begin();
    if (!task) return;
    setSavingItemId(editingItem.id);
    setError(null);
    try {
      const updated = verifiedReceiptScan(
        await api.patch<ReceiptScanResult>(
          `/records/receipts/${scan.id}/items/${editingItem.id}`,
          { name, amount: value, expectedScanRevision: scan.scanRevision },
        ),
        scan.id,
        selected!.id,
        scan.receiptBatchId !== null && scan.receiptOrdinal !== null
          ? { batchId: scan.receiptBatchId, ordinal: scan.receiptOrdinal }
          : null,
      );
      if (!operation.current(task)) return;
      setScan(updated);
      setEditingItem(null);
      setEditingItemErrors({});
      setPlan(null);
      setGapCategoryId(null);
      haptics.succeeded();
    } catch (err) {
      if (!operation.current(task)) return;
      const status = typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: unknown }).status)
        : null;
      if (status === 409) {
        try {
          const latest = verifiedReceiptScan(
            await api.get<ReceiptScanResult>(`/records/receipts/${scan.id}`, undefined, task.controller.signal),
            scan.id,
            selected!.id,
          );
          if (!operation.current(task)) return;
          setScan(latest);
          setError("This receipt changed before your edit was saved. Your typed correction is still here; compare it with the latest result and save again.");
        } catch (refreshError) {
          if (!operation.current(task)) return;
          setError(describeActionFailure(toLoadFailure(refreshError), "Your typed correction is still here."));
        }
      } else {
        setError(describeActionFailure(toLoadFailure(err), "Your typed correction is still here."));
      }
    } finally {
      if (operation.current(task)) setSavingItemId(null);
      operation.finish(task);
    }
  }

  /**
   * Drops a line OCR read that was never a purchase.
   *
   * Deleted on the SERVER rather than hidden here, because confirmation
   * requires every stored item to carry a category — a row this screen merely
   * stopped showing would still be on the scan and would block Confirm with a
   * message about an item the owner can no longer see.
   *
   * Widening the gap against the total is the intended consequence, not a
   * side effect: the reconciliation question below already exists to answer
   * exactly that.
   */
  async function removeScannedItem(itemId: number) {
    if (!scan) return;
    if (!Number.isInteger(scan.scanRevision) || scan.scanRevision < 0) {
      setError("This receipt result is missing its edit version. Review the result again before removing an item.");
      return;
    }
    const task = operation.begin();
    if (!task) return;
    setRemovingItemId(itemId);
    setError(null);
    try {
      const updated = verifiedReceiptScan(
        await api.delete<ReceiptScanResult>(
          `/records/receipts/${scan.id}/items/${itemId}?expectedScanRevision=${scan.scanRevision}`,
        ),
        scan.id,
        selected!.id,
      );
      if (!operation.current(task)) return;
      setScan(updated);
      setItemCategories((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    } catch (err) {
      if (!operation.current(task)) return;
      setError(describeActionFailure(toLoadFailure(err), "The item is still on the receipt."));
    } finally {
      if (operation.current(task)) setRemovingItemId(null);
      operation.finish(task);
    }
  }

  /**
   * Everything worth checking about this reading, in the order it matters.
   *
   * TWO SOURCES, AND ONLY ONE OF THEM AT A TIME.
   *
   * The server now emits machine-readable warning CODES, each carrying its
   * own actionable sentence (`guidance`). When a scan has them, they ARE this
   * list and their wording is the server's — which is the whole point of the
   * contract: the app and the website used to write their own prose for the
   * same signals, and the two had already drifted apart. A client that
   * rewrites a sentence here re-creates that bug.
   *
   * The hand-derived notices below it are the fallback for scans read before
   * warnings were recorded. They are NOT merged with the codes: a blurry page
   * reported once by the server and once by this screen reads as two separate
   * problems with the same photograph.
   *
   * The ORDER, in both cases, is the argument: the photograph comes first
   * because it has the cheapest answer on the screen and the camera is one tap
   * away, then the things that make figures wrong, then the things that only
   * make them uncertain.
   */
  /**
   * The one cue at the top: how much of this reading to doubt.
   *
   * Derived from the page reading, every item amount and whether a model was
   * involved — a receipt is only as clear as its worst part, and a scan whose
   * page read cleanly but whose amounts did not is not "clear".
   */
  const scanBand = scanConfidenceBand({
    ocrConfidence: scan?.ocrConfidence,
    visionAssisted: scan?.visionAssisted,
    items: scan?.items,
  });

  /**
   * The fields the server's warnings actually point at, in form order.
   *
   * This is what turns "Check a few fields" into something the owner can act
   * on — naming the two that need looking at beats asking them to re-read all
   * four.
   */
  const attentionFields = fieldsNeedingAttention(scan?.warnings ?? []);

  const reviewNotices: ReviewNotice[] = (() => {
    if (!scan) return [];

    const warnings = scan.warnings ?? [];
    const notices: ReviewNotice[] = [];

    if (scan.receiptLikelihood?.outcome === "obvious-non-receipt") {
      notices.push({
        tone: "warn",
        text: "This may not be a receipt. Check every field before saving.",
      });
    } else if (scan.receiptLikelihood?.outcome === "uncertain") {
      notices.push({
        tone: "info",
        text: "This receipt was hard to identify. Check every field.",
      });
    }

    if (warnings.length > 0) {
      notices.push(...warnings.map((w) => ({
        tone: warningTone(w.code),
        text: [
          w.guidance ?? `${warningHeadline(w.code)}.`,
          warningPageSuffix(w),
        ]
          .filter(Boolean)
          .join(" "),
        detail: w.detail,
      })));
      return notices;
    }

    if (scan.captureQuality?.tooBlurredToTrust) {
      notices.push({
        tone: "warn",
        text: "Blurry receipt. Retake the photo or check the figures carefully.",
      });
    }

    // Page 1's own reading is already covered by captureQuality above.
    const blurryPages = (scan.pageQualities ?? [])
      .map((q, i) => (q?.tooBlurredToTrust ? i + 1 : null))
      .filter((n): n is number => n !== null && n !== 1);
    if ((scan.pageQualities?.length ?? 0) > 1 && blurryPages.length > 0) {
      notices.push({
        tone: "warn",
        text:
          `Page${blurryPages.length === 1 ? "" : "s"} ${blurryPages.join(", ")} came out blurry. Check the ` +
          `figures from ${blurryPages.length === 1 ? "that page" : "those pages"} carefully below.`,
      });
    }

    const duplicates = scan.duplicatePages ?? [];
    if (duplicates.length > 0) {
      notices.push({
        tone: "warn",
        text:
          `Pages ${duplicates.map((p) => `${p - 1} and ${p}`).join(", ")} look the same. Check for double-counted items.`,
      });
    }

    /*
     * Suppressed when duplicatePages already fired: a page flagged as a
     * repeat of its neighbour will also, necessarily, overlap it, and two
     * remarks about one pair of photographs read as two separate problems.
     */
    const overlaps = scan.overlappingPages ?? [];
    if (overlaps.length > 0 && duplicates.length === 0) {
      notices.push({
        tone: "info",
        text:
          `Sections ${overlaps.map((p) => `${p - 1} and ${p}`).join(", ")} overlap. Remove any repeated items.`,
      });
    }

    if (scan.looksLikeMultipleReceipts) {
      notices.push({
        tone: "warn",
        text: "There may be two receipts here. Scan each separately if so.",
      });
    }

    /*
     * Three-way split, same as the web confirm screen. The amounts on a
     * merely vision-ASSISTED read were still read off the paper and add up to
     * the printed total; only the wording came from a model. Showing the
     * stronger warning there would be false, and false in the direction that
     * teaches owners to skip warnings.
     */
    if (scan.items?.some((i) => i.extractedByVision)) {
      notices.push({
        tone: "warn",
        text: "AI interpreted these values. Check every field and the total against the receipt.",
      });
    } else if (scan.visionAssisted) {
      notices.push({
        tone: "warn",
        text: "AI helped read item names. Check them against the receipt.",
      });
    }

    return notices;
  })();

  /** Items and completed added lines, grouped by category with a subtotal each. */
  const itemGroups = (() => {
    const groups = new Map<number | null, { total: number; count: number }>();
    const add = (key: number | null, amount: number) => {
      const g = groups.get(key) ?? { total: 0, count: 0 };
      g.total += amount;
      g.count += 1;
      groups.set(key, g);
    };
    for (const item of items) add(itemCategories[item.id] ?? null, item.amount);
    for (const a of usableAddedItems) add(a.categoryId, Number(a.amount));
    return [...groups.entries()];
  })();

  const capturedReceiptGroups = groupReceiptMembers(pages);
  const receiptPositionByPage = new Map<string, { receipt: number; page: number; pages: number }>();
  capturedReceiptGroups.forEach((group, receiptIndex) => {
    group.forEach((page, pageIndex) => {
      receiptPositionByPage.set(page.key, {
        receipt: receiptIndex + 1,
        page: pageIndex + 1,
        pages: group.length,
      });
    });
  });
  const cameraSeedPages = cameraIntent.kind === "replace-all"
    ? pages
    : cameraIntent.kind === "replace-group"
      ? pages.filter((page) => receiptGroupKey(page) === cameraIntent.groupKey)
      : [];

  /*
   * The camera takes the WHOLE screen — a Modal, not an early return.
   *
   * An early return was the first attempt and it was wrong on a device. This
   * screen sits inside a navigation stack with a "Scan receipt" header and
   * under a tab bar, and returning a view from here renders it BETWEEN them:
   * the viewfinder lost roughly a fifth of its height to chrome, and the
   * receipt guide inside it came out as a small box floating in the middle.
   * The frame then implied the receipt had to fit in a quarter of the screen,
   * which is the opposite of what it is for — a receipt should fill the
   * picture, because resolution is the one thing OCR cannot get back.
   *
   * A Modal escapes both the header and the tab bar without touching
   * navigation options, so nothing has to be restored afterwards — a
   * `setOptions` approach has to put the tab bar back on every exit path, and
   * the one that gets missed leaves the app with no navigation at all.
   *
   * `statusBarTranslucent` lets the preview run under the status bar; the
   * camera's own SafeAreaView keeps the controls clear of it.
   *
   * `onRequestClose` is the Android back button, and it must be handled here.
   * Without it, back dismisses the modal without telling this screen, and
   * `cameraOpen` stays true — so the camera can never be reopened.
   */
  const camera = (
    <Modal
      visible={cameraOpen}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => receiptCameraRef.current ? receiptCameraRef.current.requestClose() : setCameraOpen(false)}
    >
      {/*
        Mounted only while visible. The default `ReceiptCamera` owns a live
        preview and, on a native Android build, the local scanner engine; the
        optional ML Kit rollout launches its own activity instead. Neither is
        held mounted behind the review form once the owner is back on it, so the
        camera and any torch it enabled are released with this modal.
      */}
      {cameraOpen ? (
        <ReceiptCamera
          ref={receiptCameraRef}
          initialSections={sectionsFromPages(cameraSeedPages)}
          /*
           * Closing the camera — for any reason, including zero pages —
           * reveals the capture card behind it rather than leaving this
           * screen. That card is where "Choose from gallery" lives (see the
           * card below), which matters most exactly when the camera
           * couldn't run at all: the in-camera states deliberately offer no
           * alternative capture implementation themselves (see
           * ReceiptCamera.tsx and ScannerStatusStates.tsx), so this is the
           * only place that alternative is reachable from.
           */
          onCancel={() => {
            setCameraOpen(false);
            setCameraIntent({ kind: "replace-all" });
          }}
          onDone={(sections) => {
            const captured = pagesFromSections(sections);
            if (captured.length > 0) {
              const capturedGroups = groupReceiptMembers(captured);
              const normalized = capturedGroups.flatMap((group, index) => {
                const groupId = index === 0 && cameraIntent.kind !== "replace-all"
                  ? cameraIntent.groupId
                  : newReceiptGroupId();
                return group.map((page) => ({ ...page, receiptGroupId: groupId }));
              });
              setPages((current) => {
                if (cameraIntent.kind === "replace-all") return captured;
                if (cameraIntent.kind === "append-receipt") return [...current, ...normalized];
                const next: CapturedPage[] = [];
                let inserted = false;
                for (const page of current) {
                  if (receiptGroupKey(page) === cameraIntent.groupKey) {
                    if (!inserted) next.push(...normalized);
                    inserted = true;
                  } else {
                    next.push(page);
                  }
                }
                return inserted ? next : current;
              });
              const retainedUris = new Set(scannerFileUris(normalized));
              const replaced = cameraIntent.kind === "replace-all"
                ? pages
                : cameraIntent.kind === "replace-group"
                  ? pages.filter((page) => receiptGroupKey(page) === cameraIntent.groupKey)
                  : [];
              void deleteReceiptScannerFiles(scannerFileUris(replaced).filter((uri) => !uri || !retainedUris.has(uri)));
              invalidateUnstartedUpload();
            }
            setUploadIssuePageKeys({});
            setError(null);
            setCameraOpen(false);
            setCameraIntent({ kind: "replace-all" });
          }}
        />
      ) : null}
    </Modal>
  );

  const evidenceViewer = (
    <ReceiptEvidenceViewer
      pages={pages}
      scanId={scan?.id}
      pageEvidence={scan?.pageEvidence}
      initialPage={evidencePage ?? 0}
      visible={evidencePage !== null}
      onClose={() => setEvidencePage(null)}
    />
  );

  return (
    <Screen>
      {camera}
      {evidenceViewer}
      {/*
        Nothing is rendered behind the camera.

        The screen opens straight into it, so anything here would be a card
        flashing up for the length of the modal's fade and then being covered
        — and on the way back out it would appear for an instant before this
        screen pops. Rendering nothing is also rendering nothing to lay out,
        which keeps the preview's first frame from competing with a form for
        the same window insets.
      */}
      {cameraOpen ? null : (
      /*
        The longest form in the app: a review card, then a row per item, then
        the reconciliation question. Typing into a field near the bottom used
        to put it behind the keyboard with no way to scroll it back into view.
        The ScrollView keeps its own contentContainerStyle and paddingBottom —
        this only wraps it, so scrolling behaves exactly as before when no
        keyboard is up.
      */
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
          {!scan ? (
            <Card>
              <T variant="title" style={{ marginBottom: 4 }}>Scan a receipt</T>
              <T variant="caption" style={{ marginBottom: space.lg }}>
                {pages.length === 0
                  ? "Capture or upload a receipt. Review the details before saving."
                  : capturedReceiptGroups.length > 1
                    ? `${capturedReceiptGroups.length} separate receipts are ready. FinSight will upload and review them one at a time.`
                    : "These sections belong to one receipt. Add another section for a long receipt, or start a separate receipt."}
              </T>

              {pages.length === 0 && !busy ? (
                <ActiveReceiptQueue
                  items={activeReceipts}
                  loading={activeReceiptsLoading}
                  loadingMore={activeReceiptsLoadingMore}
                  hasMore={Boolean(activeReceiptsCursor)}
                  error={activeReceiptsError}
                  deletingId={deletingScanId}
                  onRefresh={() => { void loadActiveReceipts(); }}
                  onLoadMore={() => { if (activeReceiptsCursor) void loadActiveReceipts(activeReceiptsCursor); }}
                  onOpen={(item, action) => { void resumeStoredReceipt(item, action); }}
                  onDelete={(item) => confirmDeleteStoredScan(item.id)}
                />
              ) : null}

              {busy ? (
                // The OCR wait is the app's slowest interaction — commit to
                // the shape of the answer instead of a bare spinner, same
                // reasoning as web's ScanReceipt read skeleton. The scanning
                // thumbnail shows the actual photo being read; the bars
                // underneath still say which fields are about to fill in.
                <View style={{ gap: space.sm, paddingVertical: space.md }}>
                  <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.xs }}>{phase}</T>
                  {pages[0] ? <ScanningThumbnail uri={pages[0].uri} /> : null}
                  <SkeletonBox width="40%" height={14} />
                  <SkeletonBox height={14} />
                  <SkeletonBox width="70%" height={14} />
                  <SkeletonBox width="55%" height={14} />
                  <Button title={phase === "Reading receipt…" ? "Stop waiting" : "Cancel upload"} variant="ghost" onPress={() => {
                    operation.cancel();
                    setBusy(false);
                    if (uploadAttempt.current?.accepted) setScanRecoveryAction("review");
                    setError(uploadAttempt.current?.accepted
                      ? "Your uploaded images are kept. Review the result when you're ready."
                      : "Your selected images are kept. Start the upload again when you're ready.");
                  }} />
                </View>
              ) : (
                <>
                  {/*
                    The filmstrip, shown once there is something to show. A
                    single photo never reaches this — pressing "Scan this
                    receipt" fires the instant one page exists, same as the
                    old single-tap flow, so the common case gains no step.
                  */}
                  {pages.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        {pages.map((p, i) => (
                          <View key={p.key} style={{ width: 84 }}>
                            <View
                              style={{
                                width: 84,
                                height: 112,
                                borderRadius: radius.sm,
                                overflow: "hidden",
                                backgroundColor: paper[100],
                                borderWidth: 1,
                                borderColor: ink[200],
                              }}
                            >
                              <Image source={{ uri: p.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                              <View
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  left: 4,
                                  backgroundColor: "rgba(255,255,255,0.9)",
                                  borderRadius: radius.full,
                                  paddingHorizontal: 6,
                                  paddingVertical: 1,
                                }}
                              >
                                <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink[700] }}>
                                  {capturedReceiptGroups.length > 1
                                    ? `R${receiptPositionByPage.get(p.key)?.receipt} · P${receiptPositionByPage.get(p.key)?.page}`
                                    : i + 1}
                                </T>
                              </View>
                              <Pressable
                                onPress={() => removePage(p.key)}
                                disabled={scanStarted}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove page ${i + 1}`}
                                // The visible chip stays 22px so it doesn't
                                // swallow the thumbnail, but hitSlop brings
                                // the actual tap target up to TAP (44px) —
                                // 8px was 6px short even with hitSlop.
                                hitSlop={11}
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  width: 22,
                                  height: 22,
                                  borderRadius: radius.full,
                                  backgroundColor: "rgba(255,255,255,0.9)",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  opacity: scanStarted ? 0.35 : 1,
                                }}
                              >
                                <Ionicons name="close" size={14} color={ink[700]} />
                              </Pressable>
                              {p.checkingQuality ? (
                                <View style={{ position: "absolute", bottom: 4, right: 4 }}>
                                  <ActivityIndicator size="small" color={brand[600]} />
                                </View>
                              ) : null}
                            </View>
                            {/*
                              Caught at capture, not after the whole session
                              uploads — see addPage's own comment for why that
                              order matters.
                            */}
                            {p.quality?.tooBlurredToTrust ? (
                              <T style={{ fontSize: typeScale.axis, color: statusText.warning, marginTop: 2, textAlign: "center" }}>
                                ⚠ blurry
                              </T>
                            ) : null}
                            {uploadIssuePageKeys[p.key] ? (
                              <T style={{ fontSize: typeScale.axis, color: statusText.critical, marginTop: 2, textAlign: "center" }}>
                                ⚠ Can't upload yet
                              </T>
                            ) : null}
                            <View style={{ flexDirection: "row", justifyContent: "center", gap: 2, marginTop: 2 }}>
                              <Pressable
                                onPress={() => movePage(p.key, -1)}
                                disabled={scanStarted || !canMoveWithinReceipt(pages, i, -1)}
                                accessibilityRole="button"
                                accessibilityLabel={`Move page ${i + 1} earlier`}
                                hitSlop={8}
                                style={{ padding: 4, opacity: scanStarted || !canMoveWithinReceipt(pages, i, -1) ? 0.3 : 1 }}
                              >
                                <Ionicons name="chevron-up" size={16} color={ink[600]} />
                              </Pressable>
                              <Pressable
                                onPress={() => movePage(p.key, 1)}
                                disabled={scanStarted || !canMoveWithinReceipt(pages, i, 1)}
                                accessibilityRole="button"
                                accessibilityLabel={`Move page ${i + 1} later`}
                                hitSlop={8}
                                style={{ padding: 4, opacity: scanStarted || !canMoveWithinReceipt(pages, i, 1) ? 0.3 : 1 }}
                              >
                                <Ionicons name="chevron-down" size={16} color={ink[600]} />
                              </Pressable>
                            </View>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  ) : null}

                  <View style={{ gap: space.sm }}>
                    {pages.length === 0 ? (
                      /*
                       * Camera is the dominant action, gallery is a deliberate
                       * secondary tap right beside it — not a second full-width
                       * button stacked below, which read as two equally-weighted
                       * choices when one of them (the camera) is what almost
                       * every owner actually wants.
                       */
                      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "stretch" }}>
                        <View style={{ flex: 1 }}>
                          <Button title="Scan receipt" variant="primary" onPress={capturePage} disabled={picking} />
                        </View>
                        <Pressable
                          onPress={pickPage}
                          accessibilityRole="button"
                          accessibilityLabel="Choose a photo from your gallery"
                          disabled={picking}
                          accessibilityState={{ disabled: picking }}
                          style={{
                            width: TAP_FLOOR,
                            height: TAP_FLOOR,
                            borderRadius: radius.md,
                            backgroundColor: t.surface,
                            borderWidth: 1,
                            borderColor: t.border,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Ionicons name="image-outline" size={22} color={t.brandText} />
                        </Pressable>
                        <Pressable
                          onPress={pickFile}
                          accessibilityRole="button"
                          accessibilityLabel="Choose a receipt from Files"
                          disabled={picking}
                          accessibilityState={{ disabled: picking }}
                          style={{ width: TAP_FLOOR, height: TAP_FLOOR, borderRadius: radius.md, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: "center", justifyContent: "center" }}
                        >
                          <Ionicons name="document-outline" size={22} color={t.brandText} />
                        </Pressable>
                      </View>
                    ) : (
                      <>
                        <Button
                          title={
                            batchGroupsForAcceptance.current && queuedReceiptGroups.some((receipt) => receipt.accepted === null)
                              ? "Continue batch upload"
                              : scanRecoveryAction === "retry"
                              ? "Retry processing"
                              : scanRecoveryAction === "review"
                                ? "Review result"
                                : capturedReceiptGroups.length > 1
                                  ? `Scan ${capturedReceiptGroups.length} separate receipts`
                                  : pages.length === 1 ? "Scan this receipt" : `Scan these ${pages.length} sections`
                          }
                          variant="primary"
                          onPress={continueReceiptScan}
                          disabled={deletingScanId !== null || picking || pages.some((page) => page.checkingQuality)}
                        />
                        {/*
                          Reopens the camera on the session already captured,
                          rather than starting an empty one — see
                          sectionsFromPages. Hidden at the ceiling because the
                          server refuses a ninth page, and a button that can
                          only produce a 400 is worse than no button.
                        */}
                        {capturedReceiptGroups.length === 1 ? (
                          <Button title="Review photos" variant="secondary" onPress={capturePage} disabled={picking || scanStarted} />
                        ) : capturedReceiptGroups.map((group, index) => (
                          <Button
                            key={receiptGroupKey(group[0]!)}
                            title={`Review receipt ${index + 1} photos`}
                            variant="secondary"
                            onPress={() => reviewReceipt(index)}
                            disabled={picking || scanStarted}
                          />
                        ))}
                        {!scanStarted && capturedReceiptGroups.length < MAX_RECEIPTS_PER_CAPTURE_BATCH ? (
                          <Button title="Capture a separate receipt" variant="ghost" onPress={captureSeparateReceipt} disabled={picking} />
                        ) : null}
                        {!scanStarted && capturedReceiptGroups.length === 1 && canAddSection(capturedReceiptGroups[0]!.length) ? (
                          <Button title="Add another section from Files" variant="ghost" onPress={pickFile} disabled={picking} />
                        ) : null}
                      </>
                    )}
                  </View>
                  <T variant="caption" style={{ marginTop: space.sm }}>
                    JPG, PNG, or WebP · {RECEIPT_UPLOAD_MAX_OBJECT_BYTES / MIB} MiB each · up to {RECEIPT_UPLOAD_MAX_LOGICAL_PAGES} sections · {RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES / MIB} MiB total. PDFs aren’t supported.
                  </T>
                  {picking ? <T variant="caption" accessibilityLiveRegion="polite">Preparing photo…</T> : null}
                </>
              )}
              {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
              {error && !busy && uploadAttempt.current?.accepted ? (
                <Button title="Choose another image" variant="ghost" disabled={deletingScanId !== null} onPress={chooseAnotherImage} />
              ) : null}
              {error && !busy && uploadAttempt.current?.accepted ? (
                <Button
                  title="Delete stored scan"
                  variant="danger"
                  loading={deletingScanId === uploadAttempt.current.accepted.id}
                  onPress={() => confirmDeleteStoredScan(uploadAttempt.current!.accepted!.id)}
                />
              ) : null}
              {error && !busy ? <Button title="Enter expense manually" variant="ghost" disabled={deletingScanId !== null} onPress={() => navigation.navigate("AddExpense")} /> : null}
              {!busy ? <ReceiptProviderConsent businessProfileId={selected.id} /> : null}
            </Card>
          ) : (
            <>
              {/*
                THE PHOTOGRAPH FIRST.

                Nearly every sentence on this screen ends in "against the
                photo" — check the amounts against it, check the item names
                against it, check whether it holds two receipts. The photo was
                the one thing the screen never showed. These are the local
                files the capture session produced, so they cost nothing to
                display and are already the exact images that were read.
              */}
              {pages.length > 0 ? (
                <Card>
                  <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
                  <T variant="caption" style={{ marginBottom: space.md }}>
                    Receipt scanned. Open each page to check the source image and any edited version before saving.
                  </T>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: "row", gap: space.sm }}>
                      {pages.map((p, i) => (
                        <Pressable
                          key={p.key}
                          accessibilityRole="button"
                          accessibilityLabel={pages.length === 1 ? "Inspect receipt image" : `Inspect receipt page ${i + 1} of ${pages.length}`}
                          onPress={() => setEvidencePage(i)}
                          style={{
                            width: 96,
                            height: 128,
                            borderRadius: radius.sm,
                            overflow: "hidden",
                            backgroundColor: paper[100],
                            borderWidth: 1,
                            borderColor: ink[200],
                          }}
                        >
                          {p.uri ? (
                            <Image
                              source={{ uri: p.uri }}
                              style={{ width: "100%", height: "100%" }}
                              resizeMode="cover"
                              accessible={false}
                              accessibilityIgnoresInvertColors
                            />
                          ) : (
                            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.xs }}>
                              <Ionicons name="receipt-outline" size={24} color={ink[500]} />
                              <T variant="caption" style={{ color: ink[600], textAlign: "center" }}>Open stored image</T>
                            </View>
                          )}
                          {pages.length > 1 ? (
                            <View
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                backgroundColor: "rgba(255,255,255,0.9)",
                                borderRadius: radius.full,
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                              }}
                            >
                              <T style={{ fontSize: typeScale.micro, fontFamily: font.monoMedium, color: ink[700] }}>{i + 1}</T>
                            </View>
                          ) : null}
                        </Pressable>
                      ))}
                    </View>
                  </ScrollView>
                </Card>
              ) : (
                <Card>
                  <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
                  <T variant="caption">
                    Receipt scanned. Review the details before saving.
                  </T>
                </Card>
              )}

              {/*
                The band goes ABOVE the warnings: it is the one-line answer to
                "how much of this should I doubt", and the warnings are the
                detail behind it. The other way round buries the summary under
                its own footnotes.
              */}
              <ScanBand band={scanBand} fields={attentionFields} />

              <ReviewNotices notices={reviewNotices} />

              {scan.receiptDetails && Object.values(scan.receiptDetails).some((value) => value !== null) ? (
                <View>
                <T variant="heading">As printed on the receipt</T>
                <ResultDetails label="as printed on the receipt">
                  {([
                    ["Currency", scan.receiptDetails.currency],
                    ["Time", scan.receiptDetails.transactionTime],
                    ["Subtotal", scan.receiptDetails.subtotal],
                    ["Tax", scan.receiptDetails.tax],
                    ["Tip", scan.receiptDetails.tip],
                    ["Discount", scan.receiptDetails.discount],
                    ["Payment", scan.receiptDetails.paymentMethod],
                    ["Receipt number", scan.receiptDetails.receiptNumber],
                  ] as const).filter(([, value]) => value !== null).map(([label, value]) => (
                    <T key={label} variant="caption">{label}: {typeof value === "number" ? value.toFixed(2) : value}</T>
                  ))}
                </ResultDetails>
                </View>
              ) : null}

              {requiresManualCurrencyConversion ? (
                <View style={{ gap: space.sm }}>
                  <ErrorNote>{foreignCurrency ? `This receipt is in ${foreignCurrency}. Enter the converted PHP amount manually before saving.` : "Enter this receipt manually with the amount paid in PHP."}</ErrorNote>
                  <Button title="Enter expense manually" variant="primary" onPress={() => navigation.navigate("AddExpense")} />
                  <Button title="Choose another receipt" variant="ghost" onPress={resetForAnotherReceipt} />
                </View>
              ) : <>

              <ReviewSection
                title={isItemised ? "Receipt totals" : "This expense"}
                caption={
                  isItemised
                    ? "The date, store and total for the whole receipt. Each line gets its own category below."
                    : undefined
                }
              >
              {!isItemised ? (
                <CategoryPicker
                  categories={categories}
                  value={categoryId}
                  onChange={setCategoryId}
                  onCreated={refreshCategories}
                />
              ) : null}
              <DateField label="Date" value={date} onChange={setDate} />
              {/*
                Where the value above came from. Shown under the field it
                describes rather than in a panel of its own — the question
                "where did this date come from" is only ever asked while
                looking at the date.
              */}
              <EvidenceNote evidence={scan.fieldEvidence?.date} />
              <Field
                label="Description"
                value={description}
                maxLength={FIELD_LIMITS.recordDescription}
                onChangeText={setDescription}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => vendorRef.current?.focus()}
              />
              <Field
                ref={vendorRef}
                label="Vendor"
                value={vendor}
                maxLength={FIELD_LIMITS.vendor}
                onChangeText={setVendor}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => amountRef.current?.focus()}
              />
              <EvidenceNote evidence={scan.fieldEvidence?.vendor} />
              {/*
                "done" closes the keyboard rather than confirming. Amount is the
                last thing to TYPE but not the last thing to decide — an itemised
                receipt still has a category per line and possibly a difference to
                account for below. A return key that saved here would skip past
                the review this screen exists for.
              */}
              <Field
                ref={amountRef}
                label="Amount (PHP)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />
              <EvidenceNote evidence={scan.fieldEvidence?.amount} />
              </ReviewSection>

              {isItemised ? (
                <ReviewSection
                  title={`Items (${items.length})`}
                  caption={`FinSight ${items.some((i) => i.extractedByVision) ? "found" : "read"} ${items.length} items. Put each one in a category — check them against the photo and change any that are wrong.`}
                >

                  {items.map((item) => (
                    <View
                      key={item.id}
                      /*
                        A rule ABOVE each row and generous padding, rather than
                        a box per item. A receipt can carry a dozen lines and
                        boxing each one turns the list into a stack of cards
                        inside a card; a rule separates them at a fraction of
                        the visual weight.
                      */
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: paper[200],
                        paddingTop: space.md,
                        paddingBottom: space.md,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                        <T style={{ flex: 1, fontSize: typeScale.bodySm, color: ink[900], lineHeight: 20 }}>
                          {item.name}
                          {item.quantity != null ? (
                            <T variant="caption"> × {item.quantity}</T>
                          ) : null}
                        </T>
                        {/*
                          `decimals` is not cosmetic here. Without it
                          toLocaleString ROUNDS to whole pesos, so a 123.50
                          line printed as "PHP 124" — a figure that appears
                          nowhere on the receipt — and a column of them stopped
                          adding up to the total shown above. Whole pesos are
                          right for a summary; they are wrong for a line the
                          owner is checking against paper. Web's own scan
                          review passes it on every amount for this reason.
                        */}
                        <Money value={item.amount} size={14} weight="semibold" decimals />
                        <Pressable
                          onPress={() => {
                            setEditingItem({ id: item.id, name: item.name, amount: item.amount.toFixed(2) });
                            setEditingItemErrors({});
                            setError(null);
                          }}
                          disabled={editingItem !== null || savingItemId !== null || removingItemId !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Edit ${item.name}`}
                          style={{
                            width: TAP_FLOOR,
                            height: TAP_FLOOR,
                            borderRadius: radius.full,
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: editingItem !== null || savingItemId !== null || removingItemId !== null ? 0.4 : 1,
                          }}
                        >
                          <Ionicons name="pencil-outline" size={18} color={ink[600]} />
                        </Pressable>
                        {/* Removing a line OCR should never have read. */}
                        <Pressable
                          onPress={() => removeScannedItem(item.id)}
                          disabled={editingItem !== null || savingItemId !== null || removingItemId !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${item.name} — this was not a purchase`}
                          style={{
                            width: TAP_FLOOR,
                            height: TAP_FLOOR,
                            borderRadius: radius.full,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: paper[100],
                            opacity: editingItem !== null || savingItemId !== null || removingItemId !== null ? 0.4 : 1,
                          }}
                        >
                          {/*
                            An icon rather than a "×" glyph: the glyph rendered
                            at whatever weight the system font gave it, which
                            beside a bold amount read as punctuation rather
                            than as a control.
                          */}
                          <Ionicons name="close" size={13} color={ink[500]} />
                        </Pressable>
                      </View>

                      {editingItem?.id === item.id ? (
                        <View style={{ marginTop: space.sm }}>
                          <Field
                            label="Item name"
                            accessibilityLabel={`Edit item name for ${item.name}`}
                            value={editingItem.name}
                            maxLength={255}
                            error={editingItemErrors.name}
                            onChangeText={(name) => {
                              setEditingItem((current) => current ? { ...current, name } : current);
                              setEditingItemErrors((current) => ({ ...current, name: undefined }));
                            }}
                            returnKeyType="next"
                          />
                          <Field
                            label="Item amount (PHP)"
                            accessibilityLabel={`Edit item amount for ${item.name}`}
                            value={editingItem.amount}
                            error={editingItemErrors.amount}
                            onChangeText={(itemAmount) => {
                              setEditingItem((current) => current ? { ...current, amount: itemAmount } : current);
                              setEditingItemErrors((current) => ({ ...current, amount: undefined }));
                            }}
                            keyboardType="decimal-pad"
                            returnKeyType="done"
                            onSubmitEditing={() => void saveScannedItem()}
                          />
                          <Button
                            title="Save item changes"
                            variant="secondary"
                            loading={savingItemId === item.id}
                            onPress={() => void saveScannedItem()}
                          />
                          <Button
                            title="Cancel item edit"
                            variant="ghost"
                            disabled={savingItemId === item.id}
                            onPress={() => {
                              setEditingItem(null);
                              setEditingItemErrors({});
                            }}
                          />
                        </View>
                      ) : null}

                      {/*
                        A line a model inferred from a photograph must not look
                        like one read off text. Marked per row, because the row
                        is where the owner actually decides.
                      */}
                      {item.extractedByVision ? (
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          ✦ AI read this from the photo
                        </T>
                      ) : null}

                      {/*
                        The server names the line it is least sure of when the
                        items do not add up. Pointing at one row beats asking the
                        owner to re-read all nine.
                      */}
                      {scan.suspectItemId === item.id ? (
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          ⚠ Check this one first — the items don't add up to the total
                        </T>
                      ) : needsAttention({
                          confidence: item.amountConfidence,
                          visionAssisted: item.extractedByVision,
                        }) && typeof item.amountConfidence === "number" ? (
                        /*
                          The BAND, not "FinSight was 62% sure of this amount".
                          A percentage against one line invited the owner to
                          grade it, and it used its own 75 cutoff — a third
                          opinion about the same number. Same mapping as the
                          heading now (lib/confidenceBands.ts).
                        */
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          {BAND_COPY[confidenceBand({
                            confidence: item.amountConfidence,
                            visionAssisted: item.extractedByVision,
                          })].label} — check this amount against the receipt
                        </T>
                      ) : null}
                      {/* Which printed line this came from, where the server
                          could locate it. Never invented. */}
                      {evidenceSummary(item.evidence) ? <ResultDetails label={`source for ${item.name}`}><T variant="caption">{evidenceSummary(item.evidence)}</T></ResultDetails> : null}

                      <View style={{ marginTop: space.sm }}>
                        <CategoryChips
                          categories={categories}
                          value={itemCategories[item.id] ?? null}
                          // No haptic here: the chip fires its own, and firing a
                          // second would buzz twice for one tap.
                          onChange={(id) => setItemCategories((prev) => ({ ...prev, [item.id]: id }))}
                          label={item.name}
                        />
                      </View>

                      {/*
                        A category FinSight thinks is missing.

                        Phrased as an offer rather than an assignment, because
                        nothing is created until the owner says so — inventing
                        categories in someone's books is not FinSight's call.
                      */}
                      {suggestedNewCategoryFor(item) ? (
                        <Pressable
                          onPress={() => acceptSuggestedCategory(item.suggestedCategoryName!)}
                          disabled={creatingCategoryFor !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Create the category ${item.suggestedCategoryName} and file ${item.name} under it`}
                          style={{ marginTop: space.sm, opacity: creatingCategoryFor !== null ? 0.5 : 1 }}
                        >
                          <T variant="caption" style={{ color: brand[700] }}>
                            {creatingCategoryFor === item.suggestedCategoryName
                              ? "Creating…"
                              : `✦ Nothing fits this. Create "${item.suggestedCategoryName}"?`}
                          </T>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}

                  {/*
                    Lines the owner is adding because OCR missed them.

                    Kept visually distinct from the extracted rows: the text
                    above claims FinSight READ these items, and that claim must
                    not quietly extend to a row a human typed. The same
                    distinction is stored server-side (addedByOwner) so it
                    survives onto the saved record.
                  */}
                  {addedItems.map((added, i) => (
                    <View
                      key={added.key}
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: paper[100],
                        backgroundColor: paper[50],
                        paddingVertical: space.sm,
                        paddingHorizontal: space.sm,
                      }}
                    >
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <T variant="caption">You're adding this line</T>
                        <Pressable
                          onPress={() => setAddedItems((prev) => prev.filter((x) => x.key !== added.key))}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove added item ${i + 1}`}
                          /*
                           * Was 32 x 28 with no hitSlop at all — the smallest
                           * target left in the app, on a destructive control.
                           * Laid out to the floor rather than slopped: it is
                           * the right-hand end of a two-item `space-between`
                           * row whose other item is a caption, so nothing
                           * tappable is anywhere near it, and the block below
                           * it is a form field rather than more chrome.
                           */
                          style={{
                            minWidth: TAP_FLOOR,
                            minHeight: TAP_FLOOR,
                            alignItems: "flex-end",
                            justifyContent: "center",
                          }}
                        >
                          <T style={{ fontSize: typeScale.bodyLg, color: ink[400] }}>×</T>
                        </Pressable>
                      </View>
                      <Field
                        label="Item name"
                        value={added.name}
                        onChangeText={(v: string) =>
                          setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, name: v } : x)))
                        }
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => addedAmountRefs.current[added.key]?.focus()}
                      />
                      <Field
                        ref={(el) => {
                          if (el) addedAmountRefs.current[added.key] = el;
                          else delete addedAmountRefs.current[added.key];
                        }}
                        label="Amount (PHP)"
                        value={added.amount}
                        keyboardType="decimal-pad"
                        // The row ends at its category chips, which are pressables
                        // and cannot be focused from a keyboard — so this closes
                        // the keyboard and leaves the chips visible underneath.
                        returnKeyType="done"
                        onChangeText={(v: string) =>
                          setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, amount: v } : x)))
                        }
                      />
                      <CategoryChips
                        categories={categories}
                        value={added.categoryId}
                        onChange={(id) =>
                          setAddedItems((prev) =>
                            prev.map((x) => (x.key === added.key ? { ...x, categoryId: id } : x)),
                          )
                        }
                        label={added.name || `added item ${i + 1}`}
                      />
                    </View>
                  ))}

                  <Pressable
                    onPress={() =>
                      setAddedItems((prev) => [
                        ...prev,
                        { key: `added-${Date.now()}-${prev.length}`, name: "", amount: "", categoryId: null },
                      ])
                    }
                    accessibilityRole="button"
                    style={{ paddingVertical: space.sm }}
                  >
                    <T variant="caption" style={{ color: brand[700] }}>
                      + An item is missing — add it to the list
                    </T>
                  </Pressable>
                </ReviewSection>
              ) : null}

              {/*
                WHAT ACTUALLY GETS SAVED — one record per category group.

                Its own section, and the last one before the button. It used to
                be a tinted panel at the bottom of the item list, which put the
                answer to "what am I about to agree to" inside the list of
                things being agreed to. It is the only part of this screen that
                describes the OUTCOME rather than the reading.
              */}
              {isItemised ? (
                <Card emphasis>
                  <View>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: space.sm,
                        marginBottom: space.sm,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <T variant="heading" accessibilityRole="header" style={{ color: brand[900] }}>
                          What gets saved
                        </T>
                        {/* The band, not the percentage — the number is at the
                            top of the screen in words already, and repeating
                            it here as "87%" would put the two cues back into
                            competition. */}
                        <T variant="caption">{BAND_COPY[scanBand].label}</T>
                      </View>
                      {/*
                        Whether the receipt balances, stated as a badge rather
                        than left for the owner to work out by comparing two
                        numbers in different places. Colour is never the only
                        signal — the badge carries a glyph and words.
                      */}
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          paddingHorizontal: space.sm,
                          paddingVertical: 3,
                          borderRadius: radius.full,
                          // The wash under the balance badge, paired with the
                          // `statusText` step written on it. Both halves have
                          // to come from the same family or the pair stops
                          // clearing contrast the moment the page goes dark —
                          // these were Light's literal surfaces, which left a
                          // near-white pill behind light green text in Dark.
                          backgroundColor: gap === 0 ? statusSurface.good : statusSurface.warning,
                        }}
                      >
                        <T
                          style={{
                            fontSize: typeScale.micro,
                            color: gap === 0 ? statusText.good : statusText.warning,
                          }}
                        >
                          {gap === 0
                            ? "✓ Balances"
                            : `⚠ ${gap > 0 ? "Short" : "Over"} PHP ${(Math.abs(gap) / 100).toFixed(2)}`}
                        </T>
                      </View>
                    </View>
                    {itemGroups.map(([catId, g]) => (
                      <View
                        key={String(catId)}
                        style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm, marginTop: 2 }}
                      >
                        <T style={{ flex: 1, fontSize: typeScale.label, color: catId == null ? statusText.warning : ink[700] }}>
                          {catId == null
                            ? "Not categorised yet"
                            : (categories.find((c) => c.id === catId)?.name ?? "Category")}
                          <T variant="caption"> ({g.count} item{g.count === 1 ? "" : "s"})</T>
                        </T>
                        <Money value={g.total} size={13} decimals />
                      </View>
                    ))}
                    <T
                      variant="caption"
                      style={{ marginTop: space.sm, color: everyItemHasCategory && planResolved ? statusText.good : statusText.warning }}
                    >
                      {!everyItemHasCategory
                        ? "⚠ Every item needs a category before this can be saved."
                        : gap === 0
                          ? `✓ ${itemGroups.length} record${itemGroups.length === 1 ? "" : "s"} will be saved, adding up to the receipt total.`
                          : plan === "shrink"
                            ? `✓ The receipt will be saved as PHP ${itemsTotal.toFixed(2)} — the items' own total.`
                            : planResolved
                              ? "✓ Ready to save."
                              : gap > 0
                                ? `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(gap / 100).toFixed(2)} less than the total above.`
                                : `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(-gap / 100).toFixed(2)} more than the total above.`}
                    </T>
                  </View>

                  {/*
                    Accounting for the difference.

                    A gap is normal rather than a mistake: a VAT-exclusive
                    register adds tax on top of the printed lines, a discount
                    takes money off, and OCR sometimes just misses a line. So the
                    screen asks what the difference IS instead of blocking until
                    the arithmetic works — which, on a VAT-exclusive receipt, it
                    never would. The total never changes on its own; only the
                    last option touches it, and only to figures read off the
                    receipt.
                  */}
                  {everyItemHasCategory && gap !== 0 ? (
                    <View style={{ marginTop: space.md }}>
                      <T variant="label" style={{ color: ink[700], marginBottom: 4 }}>
                        {gap > 0
                          ? `What is the missing PHP ${(gap / 100).toFixed(2)}?`
                          : `What is the extra PHP ${(-gap / 100).toFixed(2)}?`}
                      </T>
                      <T variant="caption" style={{ marginBottom: space.sm }}>
                        {gap > 0
                          ? "Receipts often add tax or a service charge on top of the item prices, and sometimes a line just doesn't scan."
                          : "A discount or a voided line usually explains this."}
                      </T>

                      <GapOption
                        selected={plan === "proportional"}
                        onPress={() => {
                          haptics.tapped();
                          setPlan("proportional");
                        }}
                        title={gap > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
                        detail="Split across the categories above, in proportion to what each came to. Keeps every category's spending accurate."
                      />
                      {canFileGapOnItsOwn ? (
                        <GapOption
                          selected={plan === "category"}
                          onPress={() => {
                            haptics.tapped();
                            setPlan("category");
                          }}
                          title="A separate charge to track on its own"
                          detail="Saved as its own expense record under one category."
                        >
                          {plan === "category" ? (
                            <View style={{ marginTop: space.sm }}>
                              <CategoryChips
                                categories={categories}
                                value={gapCategoryId}
                                onChange={setGapCategoryId}
                                label="the remaining amount"
                              />
                            </View>
                          ) : null}
                        </GapOption>
                      ) : null}
                      <GapOption
                        selected={plan === "shrink"}
                        onPress={() => {
                          haptics.tapped();
                          setPlan("shrink");
                        }}
                        title="FinSight misread the receipt total"
                        detail={`Save PHP ${itemsTotal.toFixed(2)} — the items' own total — instead of the amount above.`}
                      />
                    </View>
                  ) : null}
                </Card>
              ) : null}

              {duplicateReview ? (
                <Card emphasis>
                  <T variant="title" accessibilityRole="header">Possible duplicate</T>
                  <T variant="caption" style={{ marginTop: 2, marginBottom: space.md }}>
                    {duplicateReview.code === "DUPLICATE_REVIEW_CHANGED"
                      ? "The possible matches changed while you were reviewing them. Compare this latest list before deciding."
                      : "This receipt may already be in your records. Compare the vendor, date and total before saving another copy."}
                  </T>
                  <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.sm }}>
                    Showing {duplicateReview.candidates.length} of {duplicateReview.candidateCount} possible {duplicateReview.candidateCount === 1 ? "match" : "matches"}.
                  </T>
                  <View style={{ gap: space.sm }}>
                    {duplicateReview.candidates.map((candidate) => (
                      <View
                        key={candidate.id}
                        style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.sm, gap: 2 }}
                      >
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.sm }}>
                          <T variant="heading" style={{ flex: 1 }}>{candidate.vendor?.trim() || "Vendor not recorded"}</T>
                          <Money value={candidate.total} decimals />
                        </View>
                        <T variant="caption">{candidate.date.slice(0, 10)} · {candidate.scoreBand === "EXACT" ? "Exact match" : "Likely match"}</T>
                        <T variant="caption">
                          {candidate.reasons.length > 0
                            ? [...new Set(candidate.reasons.map(duplicateReasonLabel))].join(" · ")
                            : "Similar receipt details"}
                        </T>
                      </View>
                    ))}
                  </View>
                  <View style={{ gap: space.sm, marginTop: space.md }}>
                    {duplicateCandidatesError ? <ErrorNote>{duplicateCandidatesError}</ErrorNote> : null}
                    {!duplicateReviewIsComplete(duplicateReview) ? (
                      <>
                        <T variant="caption">Load and review every possible match before saving another copy.</T>
                        <Button
                          title={duplicateCandidatesError ? "Try loading remaining matches again" : "Load remaining matches"}
                          variant="secondary"
                          loading={busy}
                          disabled={deletingScanId !== null || removingItemId !== null || creatingCategoryFor !== null || editingItem !== null || savingItemId !== null}
                          onPress={() => { void loadRemainingDuplicateCandidates(); }}
                        />
                      </>
                    ) : null}
                    <Button
                      title="Save anyway"
                      variant="danger"
                      loading={busy}
                      disabled={!duplicateReviewIsComplete(duplicateReview) || deletingScanId !== null || removingItemId !== null || creatingCategoryFor !== null || editingItem !== null || savingItemId !== null}
                      onPress={() => { void confirm({ action: "SAVE_ANYWAY", candidateSetHash: duplicateReview.candidateSetHash }); }}
                    />
                    <Button
                      title="Go back and edit"
                      variant="ghost"
                      disabled={busy}
                      onPress={() => {
                        setDuplicateReview(null);
                        setDuplicateCandidatesError(null);
                        duplicateReviewIdentity.current = "";
                        setError(null);
                      }}
                    />
                  </View>
                </Card>
              ) : null}

              {/*
                The actions sit outside the sections rather than at the end of
                the last one. They apply to the whole review, and putting them
                inside "Items" made them look like part of the item list — on
                a long receipt they arrived after nine category pickers with
                nothing to say they had left that subject.
              */}
              <View>
                {error ? <View style={{ marginBottom: space.sm }}><ErrorNote>{error}</ErrorNote></View> : null}
                {!duplicateReview ? (
                  <Button
                    title={
                      isItemised && itemGroups.length > 1
                        ? `Save ${itemGroups.length} expenses`
                        : "Save this expense"
                    }
                    variant="primary"
                    onPress={() => { void confirm(); }}
                    loading={busy}
                    disabled={deletingScanId !== null || removingItemId !== null || creatingCategoryFor !== null || editingItem !== null || savingItemId !== null}
                  />
                ) : null}
                <Button
                  title="Retake photo"
                  variant="ghost"
                  disabled={deletingScanId !== null || busy || removingItemId !== null || creatingCategoryFor !== null || savingItemId !== null}
                  onPress={resetForAnotherReceipt}
                />
                <Button
                  title="Delete scan"
                  variant="danger"
                  loading={deletingScanId === scan.id}
                  disabled={busy || removingItemId !== null || creatingCategoryFor !== null || savingItemId !== null}
                  onPress={() => confirmDeleteStoredScan(scan.id)}
                />
              </View>
              </>}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
