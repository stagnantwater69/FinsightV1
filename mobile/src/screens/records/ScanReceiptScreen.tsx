import { ContentScrollView } from "../../components/ContentScrollView";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { receiptFileError } from "../../lib/importFiles";
import { useImportOperation } from "../../lib/useImportOperation";
import { newIdempotencyKey } from "../../lib/csvImport";
import { Button, Card, ErrorNote, Field, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../lib/api";
import { describeActionFailure, saveFailureMessage, toLoadFailure } from "../../lib/connectionState";
import {
  buildItemisedConfirmPayload,
  buildReceiptConfirmPayload,
  gapCentavos,
} from "../../lib/receiptConfirm";
import { rowsToApplySuggestionTo, suggestedNewCategory } from "../../lib/categorySuggestion";
import { scanConfidenceBand } from "../../lib/confidenceBands";
import { fieldsNeedingAttention } from "../../lib/receiptWarnings";
import { ReceiptCamera } from "../../components/receipt-camera";
import type { ReceiptCameraHandle } from "../../components/receipt-camera/ReceiptCamera";
import { CAPTURE_QUALITY } from "../../lib/receiptCapture";
import { analysisImageUri } from "../../lib/analysisImage";
import { setFlash } from "../../lib/flash";
import { DateField } from "../../components/DateField";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../../components/AvailableFundsBaselineChoice";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as haptics from "../../lib/haptics";
import { radius, space } from "../../theme/tokens";
import { TAP_FLOOR } from "../../components/touchTarget";
import { useTheme } from "../../context/ThemeContext";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { CategoryPicker } from "./shared";
import { businessToday } from "../../lib/businessDate";
import { ScanBand } from "./scanReceipt/ScanBand";
import { ReviewNotices } from "./scanReceipt/ReviewNotices";
import { ReviewSection } from "./scanReceipt/ReviewSection";
import { EvidenceNote } from "./scanReceipt/EvidenceNote";
import { ScannedItemRow } from "./scanReceipt/ScannedItemRow";
import { AddedItemRow } from "./scanReceipt/AddedItemRow";
import { SaveSummaryCard } from "./scanReceipt/SaveSummaryCard";
import { DuplicateReviewCard } from "./scanReceipt/DuplicateReviewCard";
import { CaptureFilmstrip } from "./scanReceipt/CaptureFilmstrip";
import { ReviewPhotos } from "./scanReceipt/ReviewPhotos";
import { PrintedDetails } from "./scanReceipt/PrintedDetails";
import { ScanProgress } from "./scanReceipt/ScanProgress";
import { reviewNoticesFor } from "./scanReceipt/noticeList";
import {
  purgeAlreadyUnderway,
  stoppedWaitingMessage,
  storedReceiptPages,
  type QueuedReceipt,
  type ReceiptBatchChild,
  type ScanRecoveryAction,
  type ScanRunMode,
} from "./scanReceipt/scanSession";
import {
  pollUntilRead,
  pagesFromSections,
  ReceiptReadFailure,
  scannerFileUris,
  sectionsFromPages,
} from "./scanReceipt/helpers";
import { verifiedReceiptScan, type ExpectedBatchChild } from "./scanReceipt/verifiedScan";
import { retryAlreadyUnderway, retryLandingUnknown } from "./scanReceipt/retryConflict";
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
import { useActiveReceiptHistory } from "./scanReceipt/useActiveReceiptHistory";
import {
  applyReceiptCameraHandoff,
  assertReceiptBatchLimit,
  maxReceiptsForCamera,
  type ReceiptCameraIntent,
} from "./scanReceipt/cameraHandoff";
import { deleteReceiptScannerFiles } from "../../lib/receiptScannerCache";
import { clearReceiptReviewDraft } from "../../lib/receiptReviewDraft";
import { reviewEditsFromScan } from "./scanReceipt/reviewDraft";
import { useReceiptReviewDraft } from "./scanReceipt/useReceiptReviewDraft";
import { useReceiptReviewForm } from "./scanReceipt/useReceiptReviewForm";
import { RestoredReviewNotice } from "./scanReceipt/RestoredReviewNotice";
import {
  duplicateCandidatePageFromResponse,
  duplicateReviewFromError,
  duplicateReviewIsComplete,
  type ReceiptDuplicateDecision,
  type ReceiptDuplicateReview,
} from "./scanReceipt/duplicateReview";
import type {
  CapturedPage,
  ReceiptCaptureBatch,
  ReceiptHistoryItem,
  ReceiptLocalPreview,
  ReceiptPurgeJob,
  ReceiptScanResult,
  ReviewNotice,
} from "./scanReceipt/types";
import type { RecordsScreenProps } from "../../navigation/types";

const MIB = 1024 * 1024;

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
export function ScanReceiptScreen({ navigation }: RecordsScreenProps<"ScanReceipt">) {
  const { width, fontScale } = useWindowDimensions();
  const stackedFigures = width < 390 || fontScale > 1.2;
  const t = useTheme();
  const { brand, statusText } = t;
  const { selected, categories, refreshCategories, createCategory } = useBusinessProfiles();
  const [scan, setScan] = useState<ReceiptScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Uploading receipt…");
  /** What the photo already gave up while the second check runs; display only. */
  const [earlyReading, setEarlyReading] = useState<ReceiptLocalPreview | null>(null);
  /** Shows a still-processing response's preview, but only for this scan in this business. */
  const showEarlyReading = (scanId: number) => (next: ReceiptScanResult) => {
    if (next.id === scanId && next.businessProfileId === selected?.id) setEarlyReading(next.localPreview ?? null);
  };
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
  /** Possible overlap repeats the owner has said are separate purchases. */
  const [keptRepeatItemIds, setKeptRepeatItemIds] = useState<ReadonlySet<number>>(() => new Set());
  const { items: activeReceipts, setItems: setActiveReceipts, nextCursor: activeReceiptsCursor, loading: activeReceiptsLoading, loadingMore: activeReceiptsLoadingMore, error: activeReceiptsError, setError: setActiveReceiptsError, load: loadActiveReceipts } = useActiveReceiptHistory(selected?.id);
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
  const [cameraIntent, setCameraIntent] = useState<ReceiptCameraIntent>({ kind: "replace-all" });
  const receiptCameraRef = useRef<ReceiptCameraHandle>(null);
  const cameraCompletionHandled = useRef(false);

  const review = useReceiptReviewForm(() => businessToday(selected?.timezone));
  const {
    categoryId, setCategoryId,
    date, setDate,
    description, setDescription,
    vendor, setVendor,
    amount, setAmount,
    itemCategories, setItemCategories,
    plan, setPlan,
    gapCategoryId, setGapCategoryId,
    addedItems, setAddedItems,
    editingItem, setEditingItem,
    editingItemErrors, setEditingItemErrors,
    clear: clearReview,
  } = review;
  const baselineChoice = useAvailableFundsBaselineChoice(date);
  const clearBaselineDecision = baselineChoice.setDecision;

  useEffect(() => {
    clearBaselineDecision(null);
  }, [scan?.id, clearBaselineDecision]);

  /** The proposed category currently being created, so its row can show progress. */
  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);
  /** The extracted line currently being removed, so its row can show progress. */
  const [removingItemId, setRemovingItemId] = useState<number | null>(null);
  const [savingItemId, setSavingItemId] = useState<number | null>(null);
  const [duplicateReview, setDuplicateReview] = useState<ReceiptDuplicateReview | null>(null);
  const [duplicateCandidatesError, setDuplicateCandidatesError] = useState<string | null>(null);
  const duplicateReviewIdentity = useRef("");

  const { profile } = useAuth();
  const reviewDraft = useReceiptReviewDraft({
    ownerId: profile?.id,
    businessProfileId: selected?.id,
    scan,
    edits: review.edits,
    apply: review.apply,
    navigation,
  });
  const resetReviewDraft = reviewDraft.reset;

  /** The review form's chain: Description → Vendor → Amount. */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);

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
    setDeletingScanId(null);
    deleteScanKeys.current = {};
    setBusy(false);
    setPicking(false);
    clearReview();
    setSavingItemId(null);
    setDuplicateReview(null);
    setDuplicateCandidatesError(null);
    duplicateReviewIdentity.current = "";
    setError(null);
    resetReviewDraft();
  }, [selected?.id, clearReview, resetReviewDraft]);

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
    reviewDraft.reset();
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
    clearReview();
    setCreatingCategoryFor(null);
    setRemovingItemId(null);
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
    // Only reachable from the gallery button, which renders only while the
    // session is empty, so there is no existing group to extend or cap here.
    if (!operation.current(task) || scanStarted) return;
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

    // The downscale below is written to the app's own cache and is read once,
    // by the upload on the next line; nothing else can reach it afterwards.
    let analysisCopy: string | null = null;
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
      if (downscaled) analysisCopy = checkUri;
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
    } finally {
      if (analysisCopy) void deleteReceiptScannerFiles([analysisCopy]);
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
    const seeded = reviewEditsFromScan(result);
    review.apply(seeded);
    // The scan may have created categories this screen has never loaded (the
    // standard ones FinSight adds, or Uncategorized). Without them the rows
    // filed there would show no category at all.
    if (result.items.some((item) => item.categoryId != null && !categories.some((category) => category.id === item.categoryId))) {
      refreshCategories().catch(() => undefined);
    }
    reviewDraft.begin(result, seeded);
    if (result.visionAssisted) haptics.warned();
    else haptics.succeeded();
  }

  /**
   * Retries a stored scan, treating "already being read" as the retry landing.
   *
   * The server answers 409 RECEIPT_RETRY_IN_PROGRESS when the scan is already
   * Processing: a retry whose response never arrived, or one that raced a
   * concurrent retry. Either way the work is underway, so this resumes with
   * the stored scan marked Processing and the caller polls it, rather than
   * reporting a failure for work the server is doing.
   */
  async function retriedScan(
    stored: ReceiptScanResult,
    batchChild: ExpectedBatchChild | null,
    signal: AbortSignal,
  ): Promise<ReceiptScanResult> {
    try {
      return verifiedReceiptScan(
        await api.post<ReceiptScanResult>(`/records/receipts/${stored.id}/retry`, undefined, { signal }),
        stored.id,
        selected!.id,
        batchChild,
      );
    } catch (err) {
      const underway = retryAlreadyUnderway(err, stored.id);
      if (!underway) throw err;
      return {
        ...stored,
        processingStatus: "Processing",
        processingError: null,
        processingErrorCode: null,
        scanRevision: underway.scanRevision,
      };
    }
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
          }, { signal: task.controller.signal });
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
          }, { signal: task.controller.signal });
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
        accepted = await retriedScan(accepted, batchChild, task.controller.signal);
        if (!operation.current(task)) return;
        attempt.accepted = accepted;
      } else if (!accepted) {
        accepted = await acceptReceiptUpload(activeList, batchChild, task);
        if (!accepted || !operation.current(task)) return;
        attempt.accepted = accepted;
      }
      setScanRecoveryAction("review");
      setPhase("Reading receipt…");
      setEarlyReading(null);
      // The upload returns as soon as the photos are stored; the read itself
      // finishes behind it. See pollUntilRead.
      const read = await pollUntilRead(accepted, task.controller.signal, showEarlyReading(accepted.id));
      setEarlyReading(null);
      const result = verifiedReceiptScan(
        read,
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
      const retryOutcomeUnknown = mode === "retry" && retryLandingUnknown(errorStatus);
      if (hasStoredScan) {
        setScanRecoveryAction(err instanceof ReceiptReadFailure && err.kind === "failed" && !retryOutcomeUnknown ? "retry" : "review");
      }
      setError(describeActionFailure(
        toLoadFailure(err),
        hasStoredScan
          ? "Your uploaded images and review changes are still here."
          : "Your selected images are still here.",
        "local",
      ));
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  async function scanPages(list: CapturedPage[] = pages) {
    let groups: CapturedPage[][];
    try {
      groups = assertReceiptBatchLimit(list);
    } catch (err) {
      haptics.failed();
      setError(err instanceof Error ? err.message : "Remove a receipt from this batch before scanning.");
      return;
    }
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
        accepted = await retriedScan(accepted, expectedStoredBatch, task.controller.signal);
        if (!operation.current(task)) return;
        uploadAttempt.current.accepted = accepted;
      }

      setPhase("Reading receipt…");
      setEarlyReading(null);
      const read = await pollUntilRead(accepted, task.controller.signal, showEarlyReading(accepted.id));
      setEarlyReading(null);
      const result = verifiedReceiptScan(
        read,
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
      const retryOutcomeUnknown = action === "retry" && retryLandingUnknown(errorStatus);
      if (hasStoredScan) {
        setScanRecoveryAction(err instanceof ReceiptReadFailure && err.kind === "failed" && !retryOutcomeUnknown ? "retry" : "review");
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
      let job: ReceiptPurgeJob | null = null;
      try {
        job = await api.delete<ReceiptPurgeJob>(
          `/records/receipts/${scanId}`,
          undefined,
          { "Idempotency-Key": idempotencyKey },
        );
      } catch (err) {
        // A purge that is already running is the outcome the owner asked for,
        // so the row leaves the list the same way a fresh purge does.
        if (!purgeAlreadyUnderway(err)) throw err;
      }
      if (!operation.current(task)) return;
      if (job && (job.receiptScanId !== scanId || !Number.isInteger(job.id))) {
        throw new Error("FinSight returned a deletion result that did not match this receipt scan.");
      }
      const deletionLead = job ? "Receipt scan deletion started." : "This receipt scan was already being deleted.";

      if (isCurrent) void deleteReceiptScannerFiles(scannerFileUris(pages));

      delete deleteScanKeys.current[scanId];
      setActiveReceipts((current) => current.filter((item) => item.id !== scanId));
      if (isCurrent && scan?.id === scanId) reviewDraft.close(scanId);
      else if (profile?.id) void clearReceiptReviewDraft({ ownerId: profile.id, businessProfileId: selected!.id, scanId }).catch(() => undefined);
      if (isCurrent) {
        uploadAttempt.current = null;
        batchChildAttempts.current.clear();
        batchGroupsForAcceptance.current = null;
        setScan(null);
        clearReview();
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
            ? `${deletionLead} The receipts you haven't sent yet are still here, ready to scan. The other stored receipts from this batch are still in Receipts to finish.`
            : unsentPages.length > 0
              ? `${deletionLead} The receipts you haven't sent yet are still here, ready to scan.`
              : storedSiblings
                ? `${deletionLead} The other stored receipts from this batch are still in Receipts to finish.`
                : deletionLead,
        );
        void loadActiveReceipts();
      } else {
        setFlash(deletionLead);
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
  function openCamera(intent: ReceiptCameraIntent) {
    if (busy || picking || scanStarted) return;
    haptics.committed();
    setError(null);
    cameraCompletionHandled.current = false;
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
      if (operation.current(task)) setError(describeActionFailure(toLoadFailure(err), "Choose another photo or use the camera.", "local"));
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
    if (scan) reviewDraft.close(scan.id);
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
      clearReview();
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
    if (!baselineChoice.check()) return;
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
        ...baselineChoice.requestFields(),
      };

      await api.post(
        `/records/receipts/${scan!.id}/confirm`,
        payload,
        { signal: task.controller.signal, cacheScope: { businessProfileId: scan!.businessProfileId } },
      );
      if (!operation.current(task)) return;
      await finishReceiptConfirmation(task);
    } catch (err) {
      if (!operation.current(task)) return;
      if (await baselineChoice.absorb(err)) return;
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
          setItemCategories((current) => Object.fromEntries(latest.items.map((item) => [
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
          "read",
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
          setError(describeActionFailure(toLoadFailure(refreshError), "Your typed correction is still here.", "read"));
        }
      } else {
        setError(describeActionFailure(toLoadFailure(err), "Your typed correction is still here.", "local"));
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
      const status = typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: unknown }).status)
        : null;
      // Same recovery as saveItemEdit: without adopting the latest revision,
      // a second tap would resend the stale one and hit the same 409.
      if (status === 409) {
        try {
          const latest = verifiedReceiptScan(
            await api.get<ReceiptScanResult>(`/records/receipts/${scan.id}`, undefined, task.controller.signal),
            scan.id,
            selected!.id,
          );
          if (!operation.current(task)) return;
          setScan(latest);
          setError("This receipt changed before the item was removed. Check the latest items and try again.");
        } catch (refreshError) {
          if (!operation.current(task)) return;
          setError(describeActionFailure(toLoadFailure(refreshError), "The item is still on the receipt."));
        }
      } else {
        setError(describeActionFailure(toLoadFailure(err), "The item is still on the receipt."));
      }
    } finally {
      if (operation.current(task)) setRemovingItemId(null);
      operation.finish(task);
    }
  }

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

  const reviewNotices: ReviewNotice[] = scan ? reviewNoticesFor(scan, categories) : [];

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
  const cameraMaxReceipts = maxReceiptsForCamera(pages, cameraIntent);

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
          maxReceipts={cameraMaxReceipts}
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
            if (cameraCompletionHandled.current) return;
            cameraCompletionHandled.current = true;
            const captured = pagesFromSections(sections);
            let handoff;
            try {
              handoff = applyReceiptCameraHandoff(pages, captured, cameraIntent);
            } catch (err) {
              cameraCompletionHandled.current = false;
              throw err;
            }
            if (handoff.acceptedPages.length > 0) {
              setPages(handoff.pages);
              const retainedUris = new Set(scannerFileUris(handoff.acceptedPages));
              void deleteReceiptScannerFiles(
                scannerFileUris(handoff.replacedPages).filter((uri) => !uri || !retainedUris.has(uri)),
              );
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
        <ContentScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
          {!scan ? (
            <Card>
              <T variant="title" style={{ marginBottom: 4 }}>Scan a receipt</T>
              <T variant="caption" style={{ marginBottom: space.lg }}>
                {pages.length === 0
                  ? "Capture or upload a receipt. Review the details before saving."
                  : capturedReceiptGroups.length > 1
                    ? `${capturedReceiptGroups.length} separate receipts are ready. FinSight will upload and review them one at a time.`
                    : pages.length > 1
                      ? `One long receipt in ${pages.length} parts, top to bottom. FinSight reads the parts together as one receipt.`
                      : "Your receipt is ready. For a long receipt, open Review photos and use Batch to add the next part."}
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
                <ScanProgress
                  phase={phase}
                  thumbnailUri={pages[0]?.uri}
                  earlyReading={earlyReading}
                  onStop={() => {
                    operation.cancel();
                    setBusy(false);
                    const accepted = Boolean(uploadAttempt.current?.accepted);
                    if (accepted) setScanRecoveryAction("review");
                    setError(stoppedWaitingMessage(accepted, pages.some((page) => Boolean(page.uri))));
                  }}
                />
              ) : (
                <>
                  {/*
                    The filmstrip, shown once there is something to show. A
                    single photo never reaches this — pressing "Scan this
                    receipt" fires the instant one page exists, same as the
                    old single-tap flow, so the common case gains no step.
                  */}
                  {pages.length > 0 ? (
                    <CaptureFilmstrip
                      pages={pages}
                      receiptCount={capturedReceiptGroups.length}
                      positions={receiptPositionByPage}
                      scanStarted={scanStarted}
                      uploadIssuePageKeys={uploadIssuePageKeys}
                      onRemove={removePage}
                      onMove={movePage}
                    />
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
                          <Ionicons name="image-outline" size={20} color={t.brandText} />
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
                                  : pages.length === 1 ? "Scan this receipt" : `Scan long receipt (${pages.length} parts)`
                          }
                          variant="primary"
                          onPress={continueReceiptScan}
                          disabled={deletingScanId !== null || picking || pages.some((page) => page.checkingQuality)}
                        />
                        {/*
                          Reopens the camera on the session already captured,
                          rather than starting an empty one — see
                          sectionsFromPages. Hidden at the batch ceiling because
                          the receipt-batch contract refuses a ninth receipt.
                        */}
                        {capturedReceiptGroups.length === 1 ? (
                          <Button title={pages.length > 1 ? "Review or add parts" : "Review photos"} variant="secondary" onPress={capturePage} disabled={picking || scanStarted} />
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
              <ReviewPhotos pages={pages} onInspect={setEvidencePage} />

              {/*
                The band goes ABOVE the warnings: it is the one-line answer to
                "how much of this should I doubt", and the warnings are the
                detail behind it. The other way round buries the summary under
                its own footnotes.
              */}
              {reviewDraft.restored ? (
                <RestoredReviewNotice onDiscard={reviewDraft.discardRestored} disabled={busy || savingItemId !== null || removingItemId !== null} />
              ) : null}

              <ScanBand band={scanBand} fields={attentionFields} />

              <ReviewNotices notices={reviewNotices} />

              <PrintedDetails details={scan.receiptDetails} />

              {requiresManualCurrencyConversion ? (
                <View style={{ gap: space.sm }}>
                  <ErrorNote>{foreignCurrency ? `This receipt is in ${foreignCurrency}. Enter the converted PHP amount manually before saving.` : "Enter this receipt manually with the amount paid in PHP."}</ErrorNote>
                  <Button title="Enter expense manually" variant="primary" onPress={() => navigation.navigate("AddExpense")} />
                  <Button title="Choose another receipt" variant="ghost" onPress={() => reviewDraft.confirmDiscard(resetForAnotherReceipt)} />
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
              <DateField label="Date" value={date} today={businessToday(selected?.timezone)} onChange={setDate} />
              <AvailableFundsBaselineChoice choice={baselineChoice} disabled={busy} />
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
                    <ScannedItemRow
                      key={item.id}
                      item={item}
                      categories={categories}
                      categoryId={itemCategories[item.id] ?? null}
                      editing={editingItem?.id === item.id ? editingItem : null}
                      editingErrors={editingItemErrors}
                      locked={editingItem !== null || savingItemId !== null || removingItemId !== null}
                      saving={savingItemId === item.id}
                      removing={removingItemId === item.id}
                      repeatKept={keptRepeatItemIds.has(item.id)}
                      suspect={scan.suspectItemId === item.id}
                      suggestedCategory={suggestedNewCategoryFor(item)}
                      creatingCategory={creatingCategoryFor}
                      onStartEdit={() => {
                        setEditingItem({ id: item.id, name: item.name, amount: item.amount.toFixed(2) });
                        setEditingItemErrors({});
                        setError(null);
                      }}
                      onEditName={(name) => {
                        setEditingItem((current) => current ? { ...current, name } : current);
                        setEditingItemErrors((current) => ({ ...current, name: undefined }));
                      }}
                      onEditAmount={(itemAmount) => {
                        setEditingItem((current) => current ? { ...current, amount: itemAmount } : current);
                        setEditingItemErrors((current) => ({ ...current, amount: undefined }));
                      }}
                      onSaveEdit={() => void saveScannedItem()}
                      onCancelEdit={() => {
                        setEditingItem(null);
                        setEditingItemErrors({});
                      }}
                      onRemove={() => void removeScannedItem(item.id)}
                      onKeepRepeat={() => setKeptRepeatItemIds((current) => new Set(current).add(item.id))}
                      onCategory={(id) => setItemCategories((prev) => ({ ...prev, [item.id]: id }))}
                      onAcceptSuggestion={() => void acceptSuggestedCategory(item.suggestedCategoryName!)}
                    />
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
                    <AddedItemRow
                      key={added.key}
                      added={added}
                      index={i}
                      categories={categories}
                      onChange={(patch) => setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, ...patch } : x)))}
                      onRemove={() => setAddedItems((prev) => prev.filter((x) => x.key !== added.key))}
                    />
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
                <SaveSummaryCard
                  band={scanBand}
                  gap={gap}
                  itemGroups={itemGroups}
                  itemsTotal={itemsTotal}
                  categories={categories}
                  everyItemHasCategory={everyItemHasCategory}
                  planResolved={planResolved}
                  canFileGapOnItsOwn={canFileGapOnItsOwn}
                  plan={plan}
                  onPlan={setPlan}
                  gapCategoryId={gapCategoryId}
                  onGapCategory={setGapCategoryId}
                  stackedFigures={stackedFigures}
                />
              ) : null}

              {duplicateReview ? (
                <DuplicateReviewCard
                  review={duplicateReview}
                  loadError={duplicateCandidatesError}
                  busy={busy}
                  locked={deletingScanId !== null || removingItemId !== null || creatingCategoryFor !== null || editingItem !== null || savingItemId !== null}
                  onLoadMore={() => { void loadRemainingDuplicateCandidates(); }}
                  onSaveAnyway={() => { void confirm({ action: "SAVE_ANYWAY", candidateSetHash: duplicateReview.candidateSetHash }); }}
                  onGoBack={() => {
                    setDuplicateReview(null);
                    setDuplicateCandidatesError(null);
                    duplicateReviewIdentity.current = "";
                    setError(null);
                  }}
                />
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
                {reviewDraft.saveFailed ? (
                  <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.sm, color: statusText.warning }}>
                    This device couldn't keep a copy of your changes. They are still on screen; save before closing the app.
                  </T>
                ) : null}
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
                  onPress={() => reviewDraft.confirmDiscard(resetForAnotherReceipt)}
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
        </ContentScrollView>
      </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
