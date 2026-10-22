import { CONTENT_WIDTH, ContentScrollView } from "../../components/ContentScrollView";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccessibilityInfo, BackHandler, FlatList, Keyboard, Pressable, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Alert as AlertBanner, Button, Callout, Card, ConfirmSheet, ErrorNote, Field, OptionSheet, Screen, SelectChip, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, getFieldErrors } from "../../lib/api";
import { describeActionFailure, toLoadFailure } from "../../lib/connectionState";
import {
  EMPTY_MAPPING,
  CORRECTABLE_FIELDS,
  analyseRows,
  checkMapping,
  columnMappingPayload,
  correctionsPayload,
  csvReviewBodyError,
  defaultImportTitle,
  importProgress,
  newCategoryNames,
  newIdempotencyKey,
  problemsFirst,
  requiredFields,
  reviewCounts,
  rowProblem,
  type AnalysedRow,
  type ColumnMapping,
  type CorrectableField,
  type Corrections,
  type ImportRecordType,
  type ImportRowCategory,
  type MappedField,
  type MixedStrategy,
  type RowRules,
  type RowCorrection,
  type RowProblem,
} from "../../lib/csvImport";
import { DATE_FORMAT_LABELS, parseCsvDate, type ChosenDateFormat, type CsvDateFormat } from "../../lib/csvDates";
import { SkeletonList } from "../../components/Skeleton";
import { font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { ImportSteps } from "./importCsv/ImportSteps";
import { ChooseFileStage } from "./importCsv/ChooseFileStage";
import { ConfirmImportStage } from "./importCsv/ConfirmImportStage";
import { DetectedColumns, type UnmappedColumn } from "./importCsv/DetectedColumns";
import { ReviewRowCard } from "./importCsv/ReviewRowCard";
import { FIELD_LABELS, IMPORT_POLL_INTERVAL_MS, IMPORT_POLL_TIMEOUT_MS } from "./importCsv/constants";
import { ResultDetails } from "../../components/ResultDetails";
import { csvFileError } from "../../lib/importFiles";
import { csvUploadForm, releaseCsvObjectUrl } from "../../lib/csvUploadForm";
import { useImportOperation } from "../../lib/useImportOperation";
import { invalidateRecordDerivedServerState } from "../../lib/serverStateCache";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../../components/AvailableFundsBaselineChoice";
import { TAP_FLOOR } from "../../components/touchTarget";
import { HeaderBackButton } from "../../components/HeaderBackButton";
import { CsvKeyboardFrame } from "./importCsv/CsvKeyboardFrame";
import type { RecordsScreenProps } from "../../navigation/types";
import type { CsvImportStatus, CsvProcessingStatus } from "../../lib/types";
import type { ImportResult } from "./importCsv/types";

/** What the progress view needs from a large import still running on the worker. */
interface ImportProgressState {
  processingStatus: CsvProcessingStatus;
  totalRows?: number | null;
  processedRows?: number | null;
  importedRows?: number;
  skippedRows?: number;
}

/** The import summary as shown: counts the server may leave out are filled in with 0. */
type ShownImportResult = ImportResult &
  Required<Pick<ImportResult, "importedExpenses" | "importedSales" | "uncategorised" | "skippedCount">>;

const EMPTY_CORRECTION: RowCorrection = {};
type ReviewFilter = "preview" | "problems" | "duplicates" | "excluded" | "edited";
interface ImportPreview {
  headers: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
  stagedUploadId: string;
  stageExpiresAt: string;
  detectedTypeColumn?: string | null;
  columnsWithNegatives?: string[];
  detectedDateFormat?: CsvDateFormat;
  dateFormatAmbiguous?: boolean;
  suggestedMapping?: Partial<ColumnMapping>;
  columnDetection?: {
    unmapped: UnmappedColumn[];
    suggestedRecordType: "expense" | "sales" | null;
  };
  rowCategories?: ImportRowCategory[];
  validation?: ImportValidation;
  categorySuggestions?: ImportCategorySuggestion[];
  categorySuggestionsTruncated?: boolean;
  availableFundsBaseline?: AvailableFundsBaselineSummary | null;
  reviewRows?: { row: number; values: Record<string, string> }[];
  reviewRowsTruncated?: boolean;
  categorySummary?: {
    fromFile: number;
    suggested: number;
    uncategorised: number;
    newCategories: { name: string; rows: number }[];
  };
}

interface ImportValidation {
  validRows: number;
  invalidRows: number;
  skipped: { row: number; reason: string }[];
  skippedTruncated: boolean;
  possibleDuplicateRows?: number;
  duplicateRows?: number[];
  duplicateRowsTruncated?: boolean;
}
interface ImportCategorySuggestion { row: number; categoryId: number; categoryName: string; source: "history" }
interface AvailableFundsBaselineSummary {
  baselineAt: string;
  baselineDate: string;
  matchingRowCount: number;
}

function withCheckedDateProblems(rows: AnalysedRow[], validation: ImportValidation | null): AnalysedRow[] {
  const futureDates = new Map((validation?.skipped ?? []).filter((entry) => entry.reason.startsWith("Future date:")).map((entry) => [entry.row, entry.reason]));
  return rows.map((row) => {
    const reason = futureDates.get(row.rowNumber);
    return reason && !row.excluded ? { ...row, problem: { field: "date" as const, reason } } : row;
  });
}

function withoutBaselineOverrides(corrections: Corrections): Corrections {
  let changed = false;
  const next: Corrections = {};
  for (const [rawRow, fields] of Object.entries(corrections)) {
    const nextFields = { ...fields };
    if (nextFields.includedInAvailableFundsBaseline !== undefined) {
      delete nextFields.includedInAvailableFundsBaseline;
      changed = true;
    }
    if (Object.keys(nextFields).length > 0) next[Number(rawRow)] = nextFields;
  }
  return changed ? next : corrections;
}

export function ImportCsvScreen({ navigation }: RecordsScreenProps<"ImportCsv">) {
  const t = useTheme();
  const { brand, ink, paper, statusText } = t;
  const { selected, categories } = useBusinessProfiles();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<AnalysedRow>>(null);
  const alignedEditor = useRef<number | null>(null);
  const alignmentFrame = useRef<number | null>(null);
  const reviewHeaderHeight = useRef(0);
  const reviewScrollOffset = useRef(0);
  const reviewScrollRestore = useRef<number | null>(null);
  const reviewListLaidOut = useRef(false);
  const reviewContentMeasured = useRef(false);
  const restoreReviewScroll = useCallback(() => {
    const offset = reviewScrollRestore.current;
    if (offset === null || !reviewListLaidOut.current || !reviewContentMeasured.current || !listRef.current) return;
    reviewScrollRestore.current = null;
    listRef.current.scrollToOffset({ offset, animated: false });
  }, []);
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  /**
   * The replay token for THIS file, generated once when it is chosen and
   * reused on every retry — which is the entire point of it. Regenerating per
   * attempt would let a retry import the file a second time, and doubling a
   * month of books is the worst thing this screen can do.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [stagedUploadId, setStagedUploadId] = useState<string | null>(null);
  const [stageExpired, setStageExpired] = useState(false);
  const [extraRows, setExtraRows] = useState<Map<number, Record<string, string>>>(new Map());
  const [reviewRowsTruncated, setReviewRowsTruncated] = useState(false);
  const [duplicateRows, setDuplicateRows] = useState<Set<number>>(new Set());
  const [categorySummary, setCategorySummary] = useState<ImportPreview["categorySummary"]>();
  const [unmappedColumns, setUnmappedColumns] = useState<UnmappedColumn[]>([]);
  const [rowCategories, setRowCategories] = useState<Map<number, ImportRowCategory>>(new Map());
  const [columnSheetField, setColumnSheetField] = useState<MappedField | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("preview");
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const editorRef = useRef(editingRow);
  editorRef.current = editingRow;
  const [draft, setDraft] = useState<RowCorrection>({});
  const [draftError, setDraftError] = useState<RowProblem | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [lastExcluded, setLastExcluded] = useState<number[]>([]);
  const [pendingEditor, setPendingEditor] = useState<number | "select" | "back" | "file" | null>(null);
  const checkedSignature = useRef<string | null>(null);
  const confirmAttempt = useRef<{ body: Record<string, unknown>; businessId: number } | null>(null);
  const stageLifecycle = useRef<{ id: string | null; businessId?: number; confirmationAttempted: boolean }>({ id: null, confirmationAttempted: false });
  const uploadIntent = useRef<{ key: string; businessId?: number; stageIds: Set<string> } | null>(null);
  const attemptedStages = useRef(new Set<string>());
  const discardedStages = useRef(new Set<string>());
  const screenMounted = useRef(true);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const recoveringRef = useRef(confirmRecovery);
  recoveringRef.current = confirmRecovery;
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  /**
   * What the file is read as. Mobile could once only import expenses, so a
   * phone could not bring in sales history at all and a combined sheet had to
   * be split on a computer first.
   */
  const [recordType, setRecordType] = useState<ImportRecordType>("expense");
  const [mixedStrategy, setMixedStrategy] = useState<MixedStrategy>("column");
  const [title, setTitle] = useState("");
  /** What the server read off the file, and whether it could be read two ways. */
  const [detectedFormat, setDetectedFormat] = useState<CsvDateFormat>("iso");
  const [dateAmbiguous, setDateAmbiguous] = useState(false);
  /** The owner's answer. Only sent when the file is genuinely ambiguous. */
  const [dateFormat, setDateFormat] = useState<Exclude<ChosenDateFormat, "iso"> | null>(null);
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  const [corrections, setCorrections] = useState<Corrections>({});
  const [result, setResult] = useState<ShownImportResult | null>(null);
  /** The polled status of a large import the server took off the request. */
  const [batchStatus, setBatchStatus] = useState<ImportProgressState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [categorySuggestions, setCategorySuggestions] = useState<ImportCategorySuggestion[]>([]);
  const [categorySuggestionsTruncated, setCategorySuggestionsTruncated] = useState(false);
  const [availableFundsBaseline, setAvailableFundsBaseline] = useState<AvailableFundsBaselineSummary | null>(null);
  const baselineChoice = useAvailableFundsBaselineChoice(
    availableFundsBaseline?.baselineDate ?? "",
    availableFundsBaseline
      ? {
          availableFundsBaselineAt: availableFundsBaseline.baselineAt,
          availableFundsBaselineDate: availableFundsBaseline.baselineDate,
        }
      : undefined,
  );
  const setBaselineDecision = baselineChoice.setDecision;
  const dateSemanticsKey = `${mapping.date}\u0000${dateFormat ?? detectedFormat}`;
  const previousDateSemantics = useRef(dateSemanticsKey);
  const automaticCheckKey = useRef<string | null>(null);
  const operation = useImportOperation(selected?.id);
  const confirming = useRef<NonNullable<ReturnType<typeof operation.begin>> | null>(null);
  const polling = useRef<NonNullable<ReturnType<typeof operation.begin>> | null>(null);
  const profileRef = useRef(selected?.id);
  profileRef.current = selected?.id;
  useEffect(() => {
    screenMounted.current = true;
    return () => { screenMounted.current = false; };
  }, []);
  const discardStage = useCallback((id: string, businessId: number | undefined) => {
    if (attemptedStages.current.has(id) || discardedStages.current.has(id)) return;
    discardedStages.current.add(id);
    void api.delete(`/records/csv-imports/stages/${encodeURIComponent(id)}`, undefined,
      businessId === undefined ? undefined : { cacheScope: { businessProfileId: businessId } },
    ).catch(() => undefined);
  }, []);
  const discardAbandonedStage = useCallback(() => {
    const stage = stageLifecycle.current;
    if (stage.id && !stage.confirmationAttempted) {
      stageLifecycle.current = { id: null, confirmationAttempted: false };
      discardStage(stage.id, stage.businessId);
    }
    const intent = uploadIntent.current;
    uploadIntent.current = null;
    for (const id of intent?.stageIds ?? []) discardStage(id, intent?.businessId);
  }, [discardStage]);
  const reviewSignature = JSON.stringify({
    file: file?.uri,
    stagedUploadId,
    mapping,
    recordType,
    mixedStrategy,
    dateFormat,
    detectedFormat,
    dateAmbiguous,
    corrections,
    title,
    includedInAvailableFundsBaseline: baselineChoice.decision,
    availableFundsBaselineAt: availableFundsBaseline?.baselineAt,
  });
  const latestReviewSignature = useRef(reviewSignature);
  latestReviewSignature.current = reviewSignature;
  useEffect(() => {
    if (checkedSignature.current && checkedSignature.current !== reviewSignature) {
      checkedSignature.current = null;
      setConfirmOpen(false);
    }
  }, [reviewSignature]);
  const reset = useCallback(() => {
    discardAbandonedStage();
    stageLifecycle.current = { id: null, confirmationAttempted: false };
    setFile(null);
    setIdempotencyKey(null);
    setHeaders([]);
    setPreviewRows([]);
    setTotalRows(0);
    setStagedUploadId(null);
    setStageExpired(false);
    setExtraRows(new Map());
    setReviewRowsTruncated(false);
    setDuplicateRows(new Set());
    setCategorySummary(undefined);
    setUnmappedColumns([]);
    setRowCategories(new Map());
    setColumnSheetField(null);
    setReviewFilter("preview");
    setEditingRow(null);
    setDraft({});
    setDraftError(null);
    setSelecting(false);
    setSelectedRows(new Set());
    setLastExcluded([]);
    reviewScrollOffset.current = 0;
    reviewScrollRestore.current = null;
    reviewListLaidOut.current = false;
    reviewContentMeasured.current = false;
    setPendingEditor(null);
    checkedSignature.current = null;
    confirmAttempt.current = null;
    setConfirmRecovery(false);
    setMapping(EMPTY_MAPPING);
    setRecordType("expense");
    setMixedStrategy("column");
    setTitle("");
    setDetectedFormat("iso");
    setDateAmbiguous(false);
    setDateFormat(null);
    setDateSheetOpen(false);
    setCorrections({});
    setReviewOrder([]);
    automaticCheckKey.current = null;
    setResult(null);
    setBatchStatus(null);
    setError(null);
    setValidation(null);
    setCategorySuggestions([]);
    setCategorySuggestionsTruncated(false);
    setAvailableFundsBaseline(null);
    setBaselineDecision(null);
    setConfirmOpen(false);
  }, [setBaselineDecision, discardAbandonedStage]);
  useEffect(() => { reset(); setBusy(false); }, [selected?.id, reset]);
  useEffect(() => () => discardAbandonedStage(), [selected?.id, discardAbandonedStage]);
  useEffect(() => {
    const uri = file?.uri;
    return () => releaseCsvObjectUrl(uri);
  }, [file?.uri]);
  useEffect(() => {
    if (previousDateSemantics.current === dateSemanticsKey) return;
    previousDateSemantics.current = dateSemanticsKey;
    setBaselineDecision(null);
    setCorrections((current) => withoutBaselineOverrides(current));
    setAvailableFundsBaseline(null);
    setValidation(null);
    setConfirmOpen(false);
  }, [dateSemanticsKey, setBaselineDecision]);
  const interruptConfirmation = useCallback(() => {
    if (!confirming.current || confirming.current.businessId !== profileRef.current) return false;
    recoveringRef.current = true;
    setConfirmRecovery(true);
    setError("Confirmation interrupted. Check the same import before making more changes.");
    return true;
  }, []);
  useFocusEffect(useCallback(() => () => {
    if (!interruptConfirmation() && polling.current && polling.current.businessId === profileRef.current) {
      setError("Checking paused. The import is still running. Check progress when you return.");
    }
    operation.cancel();
    setBusy(false);
  }, [operation, interruptConfirmation]));
  const backWithinReview = useCallback(() => {
    if (interruptConfirmation()) {
      operation.cancel();
      setBusy(false);
      return true;
    }
    if (result || batchStatus || !stagedUploadId) return false;
    if (confirmRecovery) { setError("Check the same import before changing its details."); return true; }
    if (confirmOpen) { setConfirmOpen(false); return true; }
    operation.cancel();
    setBusy(false);
    if (editorRef.current !== null) setPendingEditor("back");
    else if (selecting) { setSelecting(false); setSelectedRows(new Set()); }
    else return false;
    return true;
  }, [result, batchStatus, stagedUploadId, selecting, confirmRecovery, confirmOpen, operation, interruptConfirmation]);
  const goBack = useCallback(() => {
    if (backWithinReview()) return;
    if (navigation.canGoBack?.()) navigation.goBack();
    else if (navigation.replace) navigation.replace("RecordsList");
    else navigation.navigate("RecordsList");
  }, [navigation, backWithinReview]);
  useEffect(() => navigation.setOptions?.({
    headerBackVisible: false,
    headerLeft: ({ tintColor }: { tintColor?: string }) => <HeaderBackButton tintColor={tintColor} onPress={goBack} />,
  }), [navigation, goBack]);
  useEffect(() => navigation.addListener?.("beforeRemove", (event: { preventDefault: () => void }) => {
    if (backWithinReview()) event.preventDefault();
  }), [navigation, backWithinReview]);
  useFocusEffect(useCallback(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { goBack(); return true; });
    return () => listener.remove();
  }, [goBack]));

  const dateRules: RowRules = useMemo(
    () => ({
      recordType,
      mixedStrategy,
      // The owner's answer wins; otherwise the file speaks for itself.
      dateFormat: dateFormat ?? detectedFormat,
    }),
    [recordType, mixedStrategy, dateFormat, detectedFormat],
  );

  const sourceRows = useMemo(() => {
    const rows = new Map(previewRows.map((values, i) => [i + 2, values]));
    for (const [number, values] of extraRows) rows.set(number, values);
    return rows;
  }, [previewRows, extraRows]);
  const analysed = useMemo(
    () => withCheckedDateProblems(analyseRows([...sourceRows.values()], mapping, corrections, dateRules, [...sourceRows.keys()]), validation),
    [sourceRows, mapping, corrections, dateRules, validation],
  );
  // Freeze row order while owners work; saving a correction must not move their place.
  const [reviewOrder, setReviewOrder] = useState<number[]>([]);
  const reviewRows = useMemo(() => {
    const byRow = new Map(analysed.map((r) => [r.rowNumber, r]));
    const ordered = reviewOrder.map((n) => byRow.get(n)).filter((r): r is AnalysedRow => r !== undefined);
    const known = new Set(ordered.map((row) => row.rowNumber));
    return [...ordered, ...analysed.filter((row) => !known.has(row.rowNumber))];
  }, [analysed, reviewOrder]);
  const counts = reviewCounts(analysed, corrections);
  const excludedCount = Object.values(corrections).filter((fix) => fix.exclude).length;
  const shownRows = useMemo(() => reviewRows.filter((row) => {
    if (reviewFilter === "excluded") return row.excluded;
    if (row.excluded) return false;
    if (reviewFilter === "problems") return row.problem !== null;
    if (reviewFilter === "duplicates") return duplicateRows.has(row.rowNumber);
    if (reviewFilter === "edited") return Object.keys(corrections[row.rowNumber] ?? {}).some((field) => field !== "exclude");
    return row.rowNumber < previewRows.length + 2;
  }), [reviewRows, reviewFilter, duplicateRows, previewRows.length, corrections]);
  const shownRowsRef = useRef(shownRows);
  shownRowsRef.current = shownRows;
  const cancelEditorAlignment = useCallback(() => {
    if (alignmentFrame.current !== null) cancelAnimationFrame(alignmentFrame.current);
    alignmentFrame.current = null;
  }, []);
  useEffect(() => cancelEditorAlignment, [cancelEditorAlignment]);
  const alignEditor = useCallback((number: number) => {
    if (editorRef.current !== number || alignedEditor.current === number) return;
    cancelEditorAlignment();
    alignmentFrame.current = requestAnimationFrame(() => {
      alignmentFrame.current = requestAnimationFrame(() => {
        alignmentFrame.current = null;
        if (editorRef.current !== number) return;
        const index = shownRowsRef.current.findIndex((row) => row.rowNumber === number);
        if (index < 0) return;
        if (index === 0) {
          listRef.current?.scrollToOffset({ offset: reviewHeaderHeight.current + space.lg + space.sm, animated: false });
        } else listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
        alignedEditor.current = number;
      });
    });
  }, [cancelEditorAlignment]);
  const mappingCheck = checkMapping(mapping, recordType, mixedStrategy);
  const newCategories = newCategoryNames(analysed, categories.map((c) => c.name));
  const typeSplit =
    recordType === "mixed"
      ? {
          sales: analysed.filter((r) => r.rowType === "sales").length,
          expenses: analysed.filter((r) => r.rowType === "expense").length,
          unknown: analysed.filter((r) => r.rowType === null).length,
        }
      : null;
  /** True until the owner has answered a question only they can answer. */
  const needsDateAnswer = dateAmbiguous && dateFormat === null;


  async function pick(retry = false, preserveReview = false) {
    const task = operation.begin();
    if (!task) return;
    setBusy(true);
    try {
      const res = retry ? null : await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "*/*"], copyToCacheDirectory: true });
      if (!operation.current(task)) {
        res?.assets?.forEach((asset) => releaseCsvObjectUrl(asset.uri));
        return;
      }
      const f = retry ? file : res && !res.canceled ? res.assets?.[0] : null;
      if (!f) return;
      const invalid = csvFileError(f);
      if (invalid) {
        if (!retry) releaseCsvObjectUrl(f.uri);
        setError(invalid);
        return;
      }
      if (!retry) {
        reset();
        setFile(f);
        setTitle(defaultImportTitle(f.name));
      }
      setError(null);
      const replayKey = retry ? idempotencyKey : newIdempotencyKey();
      if (!replayKey) throw new Error("Choose the CSV again to start its upload.");
      if (!retry) setIdempotencyKey(replayKey);
      if (uploadIntent.current?.key !== replayKey || uploadIntent.current.businessId !== task.businessId) {
        uploadIntent.current = { key: replayKey, businessId: task.businessId, stageIds: new Set() };
      }
      const form = csvUploadForm(f);
      form.append("businessProfileId", String(task.businessId));
      form.append("idempotencyKey", replayKey);
      const preview = await api.upload<ImportPreview>("/records/csv-imports/preview", form, task.controller.signal);
      if (!operation.current(task)) {
        if (preview.stagedUploadId) {
          const intent = uploadIntent.current;
          if (screenMounted.current && profileRef.current === task.businessId && intent?.key === replayKey && intent.businessId === task.businessId) {
            intent.stageIds.add(preview.stagedUploadId);
          } else discardStage(preview.stagedUploadId, task.businessId);
        }
        return;
      }
      if (!preview.stagedUploadId) throw new Error("The upload could not be prepared. Try again.");

      uploadIntent.current?.stageIds.add(preview.stagedUploadId);
      if (stageLifecycle.current.id !== preview.stagedUploadId) {
        const previousStage = stageLifecycle.current;
        if (previousStage.id && !previousStage.confirmationAttempted) discardStage(previousStage.id, previousStage.businessId);
        stageLifecycle.current = { id: preview.stagedUploadId, businessId: task.businessId, confirmationAttempted: false };
      }
      setStagedUploadId(preview.stagedUploadId);
      setStageExpired(false);
      setHeaders(preview.headers);
      setPreviewRows(preview.previewRows ?? []);
      setTotalRows(preview.totalRows ?? 0);
      setUnmappedColumns(preview.columnDetection?.unmapped ?? []);
      setDetectedFormat(preview.detectedDateFormat ?? "iso");
      setDateAmbiguous(preview.dateFormatAmbiguous === true);
      if (!preserveReview) setExtraRows(new Map());
      setValidation(null);
      setRowCategories(new Map());
      if (preserveReview) return;

      const nextMapping = { ...EMPTY_MAPPING, ...preview.suggestedMapping };
      const typeColumn = preview.detectedTypeColumn ?? "";
      nextMapping.recordType = typeColumn;
      if (typeColumn) {
        setRecordType("mixed");
        setMixedStrategy("column");
        if (nextMapping.category === typeColumn) nextMapping.category = "";
      } else if (nextMapping.amount && (preview.columnsWithNegatives ?? []).includes(nextMapping.amount)) {
        setRecordType("mixed");
        setMixedStrategy("sign");
      } else {
        setRecordType(preview.columnDetection?.suggestedRecordType ?? "expense");
        setMixedStrategy("column");
      }
      setMapping(nextMapping);
    } catch (err) {
      if (!operation.current(task)) return;
      // The file is still chosen and the idempotency key still minted, so
      // "Try again" re-previews the same spreadsheet rather than sending the
      // owner back to the file picker.
      const failure = toLoadFailure(err);
      const fileError = getFieldErrors(err).file;
      setError(describeActionFailure(fileError ? { ...failure, message: fileError } : failure, "The file you chose is still selected.", "local"));
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  /**
   * Follows a large import the server took off the request.
   *
   * The counts are the SERVER's — processedRows out of totalRows — so the bar
   * moves because rows were committed, not because time passed. ADR-4's rule:
   * never fake determinate progress.
   */
  async function pollBatch(batchId: number, task: NonNullable<ReturnType<typeof operation.begin>>) {
    const deadline = Date.now() + IMPORT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_INTERVAL_MS));
      if (!operation.current(task)) return;
      const status = await api.get<CsvImportStatus>(`/records/csv-imports/batches/${batchId}/status`, undefined, task.controller.signal);
      if (!operation.current(task)) return;
      setBatchStatus(status);
      if (status.processingStatus === "COMPLETE") {
        invalidateRecordDerivedServerState(task.businessId);
        const summary = status.resultSummary ?? {};
        setResult({
          batchId,
          title,
          status: status.status,
          totalRows: status.totalRows,
          imported: status.importedRows,
          skipped: summary.skipped ?? [],
          skippedCount: status.skippedRows,
          skippedTruncated: status.skippedRows > (summary.skipped?.length ?? 0),
          flagged: status.flaggedRows,
          largeExpenseFlagged: summary.largeExpenseFlagged ?? 0,
          importedExpenses: summary.importedExpenses ?? 0,
          importedSales: summary.importedSales ?? 0,
          uncategorised: summary.uncategorised ?? 0,
        });
        return;
      }
      if (status.processingStatus === "FAILED") {
        // A batch can fail after committing one or more chunks. Refresh every
        // read those committed rows affect before reporting the partial result.
        invalidateRecordDerivedServerState(task.businessId);
        setError("Review saved records before importing the remaining rows.");
        return;
      }
    }
    throw new Error(
      "This import is taking longer than expected. It is still running on FinSight's side — check your records in a few minutes before trying again.",
    );
  }

  async function confirm() {
    if (!file || !idempotencyKey || !stagedUploadId || editingRow !== null) return;
    if (!confirmRecovery && checkedSignature.current !== latestReviewSignature.current) {
      setConfirmOpen(false);
      setError("Details changed. Check the rows again before importing.");
      return;
    }
    if (availableFundsBaseline && !baselineChoice.check()) return;
    const task = operation.begin();
    if (!task) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    let sentConfirm = false;
    try {
      const savedAttempt = confirmAttempt.current;
      const body = confirmRecovery && savedAttempt && savedAttempt.businessId === task.businessId ? savedAttempt.body : {
        stagedUploadId,
        businessProfileId: task.businessId,
        recordType,
        ...(recordType === "mixed" ? { mixedStrategy } : {}),
        title: title.trim(),
        columnMapping: columnMappingPayload(mapping, recordType, mixedStrategy),
        corrections: correctionsPayload(corrections),
        idempotencyKey,
        ...(dateAmbiguous && dateFormat ? { dateFormat } : {}),
        ...(baselineChoice.required && baselineChoice.decision !== null ? baselineChoice.requestFields() : {}),
      };
      const bodyError = csvReviewBodyError(body);
      if (bodyError) throw new Error(bodyError);
      confirmAttempt.current = { body, businessId: task.businessId! };
      sentConfirm = true;
      stageLifecycle.current.confirmationAttempted = true;
      attemptedStages.current.add(stagedUploadId);
      confirming.current = task;
      const confirmed = await api.post<ImportResult>("/records/csv-imports/confirm", body, {
        signal: task.controller.signal,
        cacheScope: { businessProfileId: selected!.id },
      });
      if (!operation.current(task)) return;
      confirming.current = null;
      recoveringRef.current = false;
      setConfirmRecovery(false);
      if (confirmed.processingStatus === "PENDING" || confirmed.processingStatus === "PROCESSING") {
        // Confirmation replays may already have saved rows; wait for the status counter.
        setBatchStatus({ ...confirmed, processingStatus: confirmed.processingStatus });
        polling.current = task;
        await pollBatch(confirmed.batchId, task);
      } else if (confirmed.processingStatus === "FAILED") {
        setBatchStatus({ ...confirmed, processingStatus: confirmed.processingStatus, importedRows: confirmed.imported, skippedRows: confirmed.skippedCount ?? confirmed.skipped?.length ?? 0 });
        setError("Review saved records before importing the remaining rows.");
      } else {
        setResult({
          ...confirmed,
          importedExpenses: confirmed.importedExpenses ?? 0,
          importedSales: confirmed.importedSales ?? 0,
          uncategorised: confirmed.uncategorised ?? 0,
          skippedCount: confirmed.skippedCount ?? confirmed.skipped?.length ?? 0,
        });
      }
    } catch (err) {
      if (!operation.current(task)) return;
      if (await baselineChoice.absorb(err)) {
        setConfirmRecovery(false);
        setValidation(null);
        setAvailableFundsBaseline(null);
        setError("The recorded balance changed. Review this import again using the latest balance.");
        return;
      }
      /*
        THE MAPPING AND THE CORRECTIONS SURVIVE, and the message says so.

        This is the failure with the most work behind it in the whole app — a
        column mapping, a date-format answer, and possibly dozens of per-row
        corrections typed on a phone. None of it is cleared here: `reset()` is
        only ever called by the file picker and by "Choose a different file".
        The idempotency key is the same on the retry too, so a confirm that
        actually landed before the connection dropped comes back as the SAME
        import rather than a second copy of the records.
      */
      const stageCode = (err as { code?: string }).code;
      if (["CSV_STAGE_EXPIRED", "CSV_STAGE_STALE", "CSV_STAGE_NOT_FOUND"].includes(stageCode ?? "")) { setStageExpired(true); setConfirmRecovery(false); }
      const status = (err as { status?: number }).status;
      if (sentConfirm && (!status || status >= 500 || stageCode === "CSV_STAGE_ALREADY_CONFIRMED")) setConfirmRecovery(true);
      const failure = toLoadFailure(err);
      setError(failure.reach === "unreachable"
        ? "Connection lost. Your import may still be running. Retry here to check the same import."
        : `${failure.message} Your column choices and row changes are kept.`);
    } finally {
      if (confirming.current === task) confirming.current = null;
      if (polling.current === task) polling.current = null;
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  async function checkAllRows(openConfirmation = false) {
    if (!file || !stagedUploadId || !mappingCheck.ready || needsDateAnswer || editingRow !== null || selecting || totalRows === 0 || stageExpired) return;
    const task = operation.begin();
    if (!task) return;
    automaticCheckKey.current = JSON.stringify({ stagedUploadId, mapping, recordType, mixedStrategy, dateFormat, detectedFormat, dateAmbiguous });
    setBusy(true);
    setError(null);
    try {
      const body = {
        stagedUploadId,
        recordType,
        businessProfileId: task.businessId,
        columnMapping: columnMappingPayload(mapping, recordType, mixedStrategy),
        corrections: correctionsPayload(corrections),
        ...(recordType === "mixed" ? { mixedStrategy } : {}),
        ...(dateFormat ? { dateFormat } : {}),
        ...(baselineChoice.required && baselineChoice.decision !== null ? baselineChoice.requestFields() : {}),
      };
      const bodyError = csvReviewBodyError(body);
      if (bodyError) throw new Error(bodyError);
      const preview = await api.post<ImportPreview>("/records/csv-imports/preview", body, task.controller.signal);
      if (!operation.current(task)) return;
      if (latestReviewSignature.current !== reviewSignature) {
        setValidation(null);
        setCategorySuggestions([]);
        setError("Details changed. Check the rows again.");
        return;
      }
      if (!preview.validation) {
        if (preview.dateFormatAmbiguous) { setDateAmbiguous(true); setDateFormat(null); }
        setError(preview.dateFormatAmbiguous ? "Choose how to read these dates, then check again." : "Check the detected columns and date format, then try again.");
        return;
      }
      const nextBaseline = preview.availableFundsBaseline ?? null;
      const baselineIdentityChanged = Boolean(
        nextBaseline
        && (
          !availableFundsBaseline
          || nextBaseline.baselineAt !== availableFundsBaseline.baselineAt
          || nextBaseline.baselineDate !== availableFundsBaseline.baselineDate
        ),
      );
      if (baselineIdentityChanged || !nextBaseline) {
        baselineChoice.setDecision(null);
        setCorrections((previous) => withoutBaselineOverrides(previous));
      }

      setValidation(preview.validation);
      const nextExtras = new Map((preview.reviewRows ?? []).slice(0, 200).map((entry) => [entry.row, entry.values]));
      for (const [number, values] of extraRows) {
        if (Object.keys(corrections[number] ?? {}).length > 0) nextExtras.set(number, values);
      }
      setExtraRows(nextExtras);
      const nextSource = new Map(previewRows.map((values, index) => [index + 2, values]));
      for (const [number, values] of nextExtras) nextSource.set(number, values);
      const nextAnalysed = withCheckedDateProblems(analyseRows([...nextSource.values()], mapping, corrections, dateRules, [...nextSource.keys()]), preview.validation);
      setReviewRowsTruncated(preview.reviewRowsTruncated === true);
      setDuplicateRows(new Set(preview.validation.duplicateRows ?? []));
      setCategorySummary(preview.categorySummary);
      setRowCategories(new Map((preview.rowCategories ?? []).map((entry) => [entry.row, entry])));
      setCategorySuggestions(preview.categorySuggestions ?? []);
      setCategorySuggestionsTruncated(preview.categorySuggestionsTruncated === true);
      setAvailableFundsBaseline(nextBaseline);
      setReviewOrder(problemsFirst(nextAnalysed).map((row) => row.rowNumber));
      if (baselineIdentityChanged && availableFundsBaseline) {
        setError("The recorded balance changed. Choose again before importing.");
      }
      if (
        openConfirmation
        && preview.validation.validRows > 0
        && (!nextBaseline || (!baselineIdentityChanged && baselineChoice.decision !== null))
      ) {
        checkedSignature.current = reviewSignature;
        reviewScrollRestore.current = reviewScrollOffset.current;
        reviewListLaidOut.current = false;
        reviewContentMeasured.current = false;
        setConfirmOpen(true);
      } else if (openConfirmation && nextBaseline && baselineChoice.decision === null) {
        baselineChoice.check();
      }
    } catch (err) {
      if (operation.current(task)) {
        if (await baselineChoice.absorb(err)) {
          setValidation(null);
          setAvailableFundsBaseline(null);
          setError("The recorded balance changed. Review this import again using the latest balance.");
        } else {
          const stageCode = (err as { code?: string }).code;
          if (["CSV_STAGE_EXPIRED", "CSV_STAGE_STALE", "CSV_STAGE_NOT_FOUND"].includes(stageCode ?? "")) setStageExpired(true);
          setError(describeActionFailure(toLoadFailure(err), "Your column choices and row changes are still here.", "local"));
        }
      }
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
    }
  }

  const detectionCheckKey = JSON.stringify({ stagedUploadId, mapping, recordType, mixedStrategy, dateFormat, detectedFormat, dateAmbiguous });
  const automaticCheck = useRef(checkAllRows);
  automaticCheck.current = checkAllRows;
  useEffect(() => {
    if (!stagedUploadId || !mappingCheck.ready || needsDateAnswer || totalRows === 0 || stageExpired || busy || confirmRecovery || editingRow !== null || selecting || result || batchStatus) return;
    if (automaticCheckKey.current === detectionCheckKey) return;
    const timer = setTimeout(() => {
      automaticCheckKey.current = detectionCheckKey;
      void automaticCheck.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [detectionCheckKey, stagedUploadId, mappingCheck.ready, needsDateAnswer, totalRows, stageExpired, busy, confirmRecovery, editingRow, selecting, result, batchStatus]);

  const invalidateReview = useCallback(() => {
    setValidation(null);
    checkedSignature.current = null;
    setConfirmOpen(false);
  }, []);
  const openEditor = useCallback((number: number) => {
    const row = analysed.find((item) => item.rowNumber === number);
    if (!row || row.excluded) return;
    reviewScrollRestore.current = null;
    cancelEditorAlignment();
    alignedEditor.current = null;
    setEditingRow(number);
    setDraft({ ...(corrections[number] ?? {}) });
    setDraftError(null);
    setError(null);
  }, [analysed, corrections, cancelEditorAlignment]);
  const requestEditor = useCallback((number: number) => {
    if (recoveringRef.current) return;
    if (editorRef.current !== null && editorRef.current !== number) { setPendingEditor(number); return; }
    if (editorRef.current === number) return;
    openEditor(number);
  }, [openEditor]);
  const updateDraft = useCallback((field: CorrectableField, value: string) => {
    setDraft((current) => {
      const next = { ...current, [field]: value };
      if (field === "date") delete next.includedInAvailableFundsBaseline;
      return next;
    });
    setDraftError(null);
  }, []);
  const updateDraftBaseline = useCallback((value: boolean | undefined) => {
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined) delete next.includedInAvailableFundsBaseline;
      else next.includedInAvailableFundsBaseline = value;
      return next;
    });
  }, []);
  const closeEditor = useCallback(() => {
    cancelEditorAlignment();
    editorRef.current = null;
    alignedEditor.current = null;
    setEditingRow(null);
    setDraft({});
    setDraftError(null);
    Keyboard.dismiss();
  }, [cancelEditorAlignment]);
  const toggleSelection = useCallback((number: number) => {
    if (recoveringRef.current) return;
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }, []);
  const restoreRow = useCallback((number: number) => {
    if (recoveringRef.current) return;
    invalidateReview();
    setCorrections((current) => {
      const next = { ...current };
      const fields = { ...next[number] };
      delete fields.exclude;
      if (Object.keys(fields).length) next[number] = fields;
      else delete next[number];
      return next;
    });
    AccessibilityInfo.announceForAccessibility(`Row ${number} restored to this import.`);
  }, [invalidateReview]);
  function saveDraft() {
    const number = editorRef.current;
    const row = analysed.find((item) => item.rowNumber === number);
    if (number === null || !row) return;
    const values = { ...row.values };
    for (const field of CORRECTABLE_FIELDS) if (draft[field] !== undefined) values[field] = draft[field];
    const problem = rowProblem(values, dateRules);
    if (problem && CORRECTABLE_FIELDS.includes(problem.field as CorrectableField)) {
      setDraftError({ ...problem });
      AccessibilityInfo.announceForAccessibility(problem.reason);
      return;
    }
    invalidateReview();
    setCorrections((current) => ({ ...current, [number]: { ...draft } }));
    setCategorySuggestions((current) => current.filter((suggestion) => suggestion.row !== number));
    closeEditor();
    AccessibilityInfo.announceForAccessibility(`Changes to row ${number} saved. Check them before importing.`);
  }
  function removeSelected() {
    if (confirmRecovery) return;
    if (!selectedRows.size || editingRow !== null || busy) return;
    const numbers = [...selectedRows].filter((number) => analysed.some((row) => row.rowNumber === number && !row.excluded));
    invalidateReview();
    setCorrections((current) => {
      const next = { ...current };
      for (const number of numbers) next[number] = { ...(next[number] ?? {}), exclude: true };
      return next;
    });
    setLastExcluded(numbers);
    setSelectedRows(new Set());
    setSelecting(false);
    AccessibilityInfo.announceForAccessibility(`${numbers.length} rows excluded from this import. You can undo this.`);
  }
  function undoRemoval() {
    if (confirmRecovery) return;
    invalidateReview();
    setCorrections((current) => {
      const next = { ...current };
      for (const number of lastExcluded) {
        const fields = { ...next[number] };
        delete fields.exclude;
        if (Object.keys(fields).length) next[number] = fields;
        else delete next[number];
      }
      return next;
    });
    setLastExcluded([]);
    AccessibilityInfo.announceForAccessibility("The last excluded rows have been restored.");
  }
  function discardAndSwitch() {
    const next = pendingEditor;
    closeEditor();
    setPendingEditor(null);
    if (next === "select") setSelecting(true);
    else if (next === "back") goBack();
    else if (next === "file") reset();
    else if (next !== null) openEditor(next);
  }

  if (!selected) return null;

  const detectedColumns = <DetectedColumns
    mapping={mapping}
    recordType={recordType}
    mixedStrategy={mixedStrategy}
    check={mappingCheck}
    previewRows={previewRows}
    unmapped={unmappedColumns}
    disabled={busy || editingRow !== null || selecting || confirmRecovery}
    onChoose={setColumnSheetField}
  />;
  const reviewOptions = (
    <View style={{ gap: space.md, marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
      {mappingCheck.ready ? detectedColumns : null}
      <ResultDetails label="import settings" title="Import settings">
        <T variant="caption">Detected as {recordType === "sales" ? "sales" : recordType === "expense" ? "expenses" : mixedStrategy === "sign" ? "sales and expenses, using the amount sign" : `sales and expenses, using ${mapping.recordType || "a type column"}`}.</T>
        <Field label="What to call this import" value={title} onChangeText={setTitle} maxLength={FIELD_LIMITS.importTitle} editable={!busy && editingRow === null && !selecting && !confirmRecovery} />
        <T variant="label">Import as</T>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {([["expense", "Expenses"], ["sales", "Sales"], ["mixed", "Both in one file"]] as const).map(([value, label]) => (
            <SelectChip key={value} label={label} selected={recordType === value} disabled={busy || editingRow !== null || selecting || confirmRecovery} onPress={() => { invalidateReview(); setRecordType(value); }} />
          ))}
        </View>
        {recordType === "mixed" ? (
          <>
            <T variant="label">How does your file say which is which?</T>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <SelectChip label={'A column says "sale" or "expense"'} selected={mixedStrategy === "column"} disabled={busy || editingRow !== null || selecting || confirmRecovery} onPress={() => { invalidateReview(); setMixedStrategy("column"); }} />
              <SelectChip label="Expenses are negative (−)" selected={mixedStrategy === "sign"} disabled={busy || editingRow !== null || selecting || confirmRecovery} onPress={() => { invalidateReview(); setMixedStrategy("sign"); }} />
            </View>
          </>
        ) : null}
      </ResultDetails>
      <ResultDetails label="review details" title="Review details">
        <T variant="caption">{file?.name} · {previewRows.length} sample rows. Each check supplies up to 200 additional issue rows; saved edits and exclusions stay available. Counts cover the whole file.</T>
        {validation && validation.skipped.length > 0 ? <View style={{ gap: space.sm }}>
          {validation.skipped.slice(0, 100).map((entry) => <T key={entry.row} variant="caption">Row {entry.row}: {entry.reason}</T>)}
          {validation.skipped.length > 100 || validation.skippedTruncated ? <T variant="caption">Showing the first 100 skipped row details.</T> : null}
        </View> : null}
        {typeSplit ? <T variant="caption">In sample and review rows: {typeSplit.sales} sales · {typeSplit.expenses} expenses{typeSplit.unknown ? ` · ${typeSplit.unknown} unknown types` : ""}</T> : null}
        {validation && categorySummary ? <T variant="caption">{categorySummary.fromFile} from your file · {categorySummary.suggested} suggested · {categorySummary.uncategorised} uncategorised</T>
          : newCategories.length > 0 ? <T variant="caption">New categories in shown rows: {newCategories.join(", ")}. Later rows may create more categories.</T> : null}
        {categorySuggestions.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <T variant="caption">{categorySuggestions.length} suggestions from your past choices.</T>
            <Button title="Apply category suggestions" variant="secondary" disabled={busy || editingRow !== null || selecting || confirmRecovery} onPress={() => {
              invalidateReview();
              setCorrections((previous) => {
                const next = { ...previous };
                for (const suggestion of categorySuggestions) if (!next[suggestion.row]?.category?.trim()) next[suggestion.row] = { ...next[suggestion.row], category: suggestion.categoryName };
                return next;
              });
              setCategorySuggestions([]);
            }} />
            {categorySuggestionsTruncated ? <T variant="caption">Apply these, then check again for more suggestions.</T> : null}
          </View>
        ) : null}
      </ResultDetails>
    </View>
  );

  // ---- What is on screen right now -------------------------------------

  if (result) {
    return (
      <Screen>
        <ContentScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
            <ImportSteps current={2} />
            <T variant="title" style={{ marginBottom: space.sm }}>Import complete</T>
            <T style={{ fontSize: typeScale.body, marginBottom: space.sm }}>
              Imported {result.imported} of {result.totalRows} rows.
              {result.importedExpenses > 0 && result.importedSales > 0
                ? ` ${result.importedExpenses} as expenses, ${result.importedSales} as sales.`
                : ""}
            </T>
            <View style={{ gap: space.sm }}>
              {result.duplicateOfBatchId ? (
                <AlertBanner kind="duplicate" label="You have imported this file before">
                  These rows match an earlier import. Review duplicates before keeping both.
                </AlertBanner>
              ) : null}
              {result.uncategorised > 0 ? (
                <Callout tone="info">
                  {result.uncategorised} expense(s) need a category.
                </Callout>
              ) : null}
              {result.skippedCount > 0 ? (
                <AlertBanner kind="needs-review" label={`${result.skippedCount} row(s) were skipped`}>
                  These rows were not saved.
                </AlertBanner>
              ) : null}
              {(result.skipped?.length ?? 0) > 0 || result.importedExpenses > 0 || result.importedSales > 0 ? (
                <ResultDetails label="import results">
                  {result.importedExpenses > 0 || result.importedSales > 0 ? <T variant="caption">{result.importedExpenses ?? 0} expenses · {result.importedSales ?? 0} sales</T> : null}
                  {(result.skipped ?? []).slice(0, 100).map((row: { row: number; reason: string }) => <T key={row.row} variant="caption">Row {row.row}: {row.reason}</T>)}
                  {result.skippedTruncated || result.skippedCount > Math.min(100, result.skipped?.length ?? 0) ? <T variant="caption">Some row details are unavailable here. Check the original file.</T> : null}
                </ResultDetails>
              ) : null}
              {result.flagged > 0 ? (
                <AlertBanner kind="duplicate">{result.flagged} row(s) look like possible duplicates.</AlertBanner>
              ) : null}
              {result.largeExpenseFlagged > 0 ? (
                <AlertBanner kind="large-expense">
                  {result.largeExpenseFlagged} row(s) were flagged as large expenses.
                </AlertBanner>
              ) : null}
              {result.flagged > 0 || result.largeExpenseFlagged > 0 ? (
                <Button
                  title="Review the flagged rows"
                  variant="secondary"
                  onPress={() => navigation.navigate("FlaggedRecords", { from: undefined })}
                />
              ) : null}
              <Button title="Done" variant="primary" onPress={goBack} />
            </View>
          </Card>
        </ContentScrollView>
      </Screen>
    );
  }

  /*
   * A large file, still being written. The figures are the server's own row
   * counts — an honest bar or none at all.
   */
  if (batchStatus && !result) {
    const progress = importProgress(batchStatus);
    const failed = batchStatus.processingStatus === "FAILED";
    return (
      <Screen>
        <ContentScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <ImportSteps current={2} />
            <T variant="title" style={{ marginBottom: 4 }}>{failed ? "Import stopped" : "Importing your records"}</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              {failed ? `${batchStatus.importedRows ?? 0} rows saved · ${batchStatus.skippedRows ?? 0} skipped` : "Importing in the background. You can leave this screen."}
            </T>
            {failed ? null : progress ? (
              <>
                <View
                  // Without `accessible`, RN leaves `isAccessibilityElement`
                  // false and the role and value below sit on a view the
                  // platform never surfaces — the bar is announced as nothing
                  // at all. Same fix, same reason, as the Spending Impact
                  // gauge and RecoveryMeter's Bar.
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityLabel="Import progress"
                  accessibilityValue={{
                    min: 0,
                    max: progress.total,
                    now: progress.done,
                    // The caption underneath says this in words; a reader
                    // parked on the bar itself would otherwise get a bare
                    // ratio with no unit.
                    text: `${progress.done} of ${progress.total} rows processed`,
                  }}
                  style={{ height: 8, borderRadius: radius.sm, backgroundColor: paper[200], overflow: "hidden" }}
                >
                  <View
                    style={{
                      width: `${Math.round(progress.fraction * 100)}%`,
                      height: "100%",
                      backgroundColor: brand[500],
                    }}
                  />
                </View>
                <T variant="caption" style={{ marginTop: space.sm }}>
                  {progress.done} of {progress.total} rows processed.
                </T>
              </>
            ) : (
              <T variant="caption">FinSight is processing the import. Checking its row count.</T>
            )}
            {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
            {failed ? (
              <Button title="Review saved records" variant="primary" onPress={() => navigation.navigate("RecordsList")} style={{ marginTop: space.md }} />
            ) : error ? (
              <Button
                title="Check progress"
                variant="secondary"
                onPress={() => void confirm()}
                style={{ marginTop: space.md }}
              />
            ) : null}
          </Card>
        </ContentScrollView>
      </Screen>
    );
  }

  if (!file) {
    return (
      <Screen>
        <ChooseFileStage businessName={selected.name} bottomInset={insets.bottom} busy={busy} error={error} onChoose={() => void pick()} />
      </Screen>
    );
  }

  if (busy && headers.length === 0) {
    return (
      <Screen>
        <ContentScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <ImportSteps current={0} />
            <T variant="caption" style={{ marginBottom: space.md }}>Reading {file.name}…</T>
            <SkeletonList count={4} />
            <Button title="Cancel upload" variant="ghost" onPress={() => { operation.cancel(); setBusy(false); setError("Your file is kept. Try again when ready."); }} />
          </Card>
        </ContentScrollView>
      </Screen>
    );
  }

  if (headers.length === 0) {
    return (
      <Screen>
        <View style={{ padding: space.lg, gap: space.md }}>
          <T variant="title">Couldn’t read this file</T>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button title="Try again" variant="primary" onPress={() => void pick(true)} loading={busy} />
          <Button title="Choose a different file" variant="ghost" onPress={reset} disabled={busy} />
        </View>
      </Screen>
    );
  }

  if ((confirmOpen || busy && confirming.current) && validation && !confirmRecovery) {
    return (
      <Screen>
        <ConfirmImportStage
          businessName={selected.name}
          title={title.trim()}
          fileName={file.name}
          ready={validation.validRows}
          skipped={validation.invalidRows}
          excluded={excludedCount}
          duplicates={validation.possibleDuplicateRows ?? 0}
          newCategories={categorySummary?.newCategories.map((category) => category.name) ?? newCategories}
          bottomInset={insets.bottom}
          busy={busy}
          onImport={() => void confirm()}
          onBack={() => setConfirmOpen(false)}
        />
      </Screen>
    );
  }

  return (
      <Screen>
        <CsvKeyboardFrame>
          <FlatList
            ref={listRef}
            contentOffset={{ x: 0, y: reviewScrollOffset.current }}
            onScroll={(event) => { reviewScrollOffset.current = event.nativeEvent.contentOffset.y; }}
            onScrollBeginDrag={() => { reviewScrollRestore.current = null; }}
            onLayout={(event) => {
              if (event.nativeEvent.layout.height > 0) { reviewListLaidOut.current = true; restoreReviewScroll(); }
            }}
            onContentSizeChange={(_width, height) => {
              if (height > 0) { reviewContentMeasured.current = true; restoreReviewScroll(); }
            }}
            scrollEventThrottle={16}
            onScrollToIndexFailed={({ index, averageItemLength }) => listRef.current?.scrollToOffset({ offset: reviewHeaderHeight.current + space.lg + space.sm + index * averageItemLength, animated: false })}
            data={shownRows}
            extraData={{ editingRow, draft, selectedRows, validation }}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={5}
            removeClippedSubviews={false}
            keyExtractor={(row) => String(row.rowNumber)}
            style={{ flex: 1, width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", pointerEvents: busy || confirmRecovery ? "none" : "auto" }}
            contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            automaticallyAdjustKeyboardInsets
            ListHeaderComponent={
              <View onLayout={(event) => { reviewHeaderHeight.current = event.nativeEvent.layout.height; }} style={{ gap: space.sm, marginBottom: space.sm }}>
                <ImportSteps current={1} />
                <T variant="title" accessibilityRole="header">Review your records</T>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T variant="caption">{selected.name}</T>
                    <T variant="caption" numberOfLines={2}>{file.name}</T>
                  </View>
                  <Button title="Change file" variant="ghost" disabled={busy || confirmRecovery} onPress={() => {
                    if (editingRow !== null) { setPendingEditor("file"); return; }
                    reset();
                  }} />
                </View>
                {validation ? (
                  <View style={{ gap: space.xs, paddingVertical: space.sm }}>
                    <View style={{ flexDirection: "row", gap: space.md }}>
                      {([[validation.validRows, "Ready to import", t.brandText], [validation.invalidRows, "Will be skipped", t.statusText.warning]] as const).map(([count, label, color]) => (
                        <View key={label} accessible accessibilityLabel={`${label}: ${count.toLocaleString()}`} style={{ flex: 1, gap: space.xs }}>
                          <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.title, color }}>{count.toLocaleString()}</T>
                          <T variant="caption">{label}</T>
                        </View>
                      ))}
                    </View>
                    {excludedCount > 0 ? <T variant="caption" accessibilityLabel={`Left out by you: ${excludedCount.toLocaleString()}, included in will be skipped`}>Includes {excludedCount.toLocaleString()} left out by you.</T> : null}
                  </View>
                ) : <T variant="caption">{busy ? "Checking the whole file…" : "Check your saved changes before importing."}</T>}
                {(validation?.possibleDuplicateRows ?? 0) > 0 ? <T variant="caption" style={{ color: statusText.warning }}>{validation!.possibleDuplicateRows!.toLocaleString()} possible duplicates · Included in ready, flagged if imported</T> : null}
                {validation && categorySummary && categorySummary.newCategories.length > 0 ? <T variant="caption">New categories: {categorySummary.newCategories.map((category) => `${category.name} (${category.rows})`).join(", ")}. Created when you import.</T> : null}
                {validation && categorySummary && categorySummary.uncategorised > 0 ? <T variant="caption" style={{ color: statusText.warning }}>{categorySummary.uncategorised.toLocaleString()} expense{categorySummary.uncategorised === 1 ? " has" : "s have"} no category. You can add one while reviewing.</T> : null}
                {totalRows === 0 ? <Callout tone="warn">This file has column headings but no records. Choose a CSV with one transaction per row.</Callout> : null}
                {dateAmbiguous ? (
                  <View style={{ gap: space.sm }}>
                    <Callout tone="warn">These dates can be read two ways. Choose the format your file uses before importing.</Callout>
                    <Pressable
                      disabled={busy || editingRow !== null || selecting || confirmRecovery}
                      onPress={() => setDateSheetOpen(true)}
                      accessibilityRole="button"
                      accessibilityLabel="Choose how the dates in this file should be read"
                      accessibilityState={{ disabled: busy || editingRow !== null || selecting || confirmRecovery }}
                      style={{ minHeight: TAP_FLOOR, justifyContent: "center", borderWidth: 1, borderColor: dateFormat ? brand[600] : statusText.warning, borderRadius: radius.md, paddingHorizontal: space.md }}
                    >
                      <T style={{ color: dateFormat ? ink[900] : statusText.warning }}>{dateFormat ? DATE_FORMAT_LABELS[dateFormat] : "Choose how to read these dates"}</T>
                    </Pressable>
                  </View>
                ) : null}
                {!mappingCheck.ready ? detectedColumns : null}
                {availableFundsBaseline ? (
                  <View style={{ gap: space.sm, marginVertical: space.sm }}>
                    <AvailableFundsBaselineChoice choice={baselineChoice} disabled={busy || editingRow !== null || confirmRecovery} question="Were these rows already included in the recorded balance?" help={`${availableFundsBaseline.matchingRowCount} valid rows use the balance date. Choose the default answer; edit a row to override it.`} />
                  </View>
                ) : null}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  {([
                    ["preview", `Preview (${previewRows.length})`],
                    ["problems", `Needs fixing (${counts.problems})`],
                    ["duplicates", `Duplicates (${analysed.filter((row) => duplicateRows.has(row.rowNumber) && !row.excluded).length})`],
                    ["excluded", `Excluded (${excludedCount})`],
                    ["edited", `Edited (${counts.corrected})`],
                  ] as const).filter(([value]) => value === "preview" || value === "problems" && counts.problems > 0 || value === "duplicates" && duplicateRows.size > 0 || value === "excluded" && excludedCount > 0 || value === "edited" && counts.corrected > 0).map(([value, label]) => (
                    <SelectChip key={value} label={label} selected={reviewFilter === value} disabled={busy || confirmRecovery} onPress={() => {
                      if (recoveringRef.current) return;
                      if (editingRow !== null) { setError("Save or cancel this edit before changing the list."); return; }
                      reviewScrollRestore.current = null;
                      setReviewFilter(value); setSelectedRows(new Set());
                    }} />
                  ))}
                </View>
                <T variant="caption">{reviewFilter === "preview" ? `${previewRows.length} sample rows shown.` : `${shownRows.length} available rows shown.`} {validation ? `All ${totalRows.toLocaleString()} rows checked.` : "Check saved changes before importing."}</T>
                {reviewRowsTruncated || validation?.duplicateRowsTruncated || validation?.skippedTruncated ? <T variant="caption" style={{ color: statusText.warning }}>Limited row details. Fix remaining issues in the CSV.</T> : null}
                {counts.corrected > 0 ? <T variant="caption">{counts.corrected} edited row{counts.corrected === 1 ? "" : "s"} · {validation ? "Checked" : "Awaiting check"}</T> : null}
                {lastExcluded.length > 0 ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                    <T variant="caption">{lastExcluded.length} rows removed from this import.</T>
                    <Button title="Undo" variant="ghost" onPress={undoRemoval} disabled={busy || editingRow !== null || confirmRecovery} />
                  </View>
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                    <T variant="heading" accessibilityRole="header">{selecting ? `${selectedRows.size} selected` : "Records"}</T>
                    <T variant="caption">{selecting ? "Select rows to leave out." : "Tap a row to edit."}</T>
                  </View>
                  <Button title={selecting ? "Done" : "Select"} variant="ghost" disabled={busy || confirmRecovery} onPress={() => {
                    if (recoveringRef.current) return;
                    if (editingRow !== null) { setPendingEditor("select"); return; }
                    setSelecting((current) => !current); setSelectedRows(new Set());
                  }} />
                </View>
              </View>
            }
            renderItem={({ item }) => <ReviewRowCard
              row={item}
              categoryDecision={rowCategories.get(item.rowNumber)}
              corrected={corrections[item.rowNumber] ?? EMPTY_CORRECTION}
              editing={editingRow === item.rowNumber}
              draft={editingRow === item.rowNumber ? draft : undefined}
              draftError={editingRow === item.rowNumber ? draftError : undefined}
              selecting={selecting}
              selected={selectedRows.has(item.rowNumber)}
              disabled={busy || confirmRecovery}
              duplicate={duplicateRows.has(item.rowNumber)}
              duplicateStale={validation === null}
              signedAmounts={recordType === "mixed" && mixedStrategy === "sign"}
              sourceRow={sourceRows.get(item.rowNumber)!}
              onEdit={requestEditor}
              onEditorLayout={alignEditor}
              onDraftChange={updateDraft}
              onSelect={toggleSelection}
              onRestore={restoreRow}
              baselineDate={availableFundsBaseline?.baselineDate}
              baselineDecision={baselineChoice.decision}
              rowDate={parseCsvDate(editingRow === item.rowNumber ? draft.date ?? item.values.date : item.values.date, dateRules.dateFormat)}
              onDraftBaseline={updateDraftBaseline}
            />}
            ListEmptyComponent={<Callout tone="info">{reviewFilter === "excluded" ? "No rows are excluded." : reviewFilter === "problems" ? "No shown rows need fixing." : reviewFilter === "duplicates" ? "No duplicate details are available in this list." : reviewFilter === "edited" ? "No included edited rows remain." : "No included sample rows remain. Check the file before continuing."}</Callout>}
            ListFooterComponent={reviewOptions}
          />
          <View testID="csv-review-footer" style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, padding: space.md, paddingBottom: Math.max(insets.bottom, space.md), gap: space.sm }}>
            {confirmRecovery ? <ErrorNote>The confirmation response was lost. Check the same import before making more changes.</ErrorNote> : error ? <ErrorNote>{error}</ErrorNote> : null}
            {stageExpired ? <Button title="Upload this file again" variant="secondary" loading={busy} onPress={() => void pick(true, true)} /> : null}
            {confirmRecovery ? <Button title="Check the same import" variant="primary" loading={busy} onPress={() => void confirm()} /> : editingRow !== null ? (
              <>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <Button title="Cancel" variant="secondary" onPress={closeEditor} style={{ flex: 1 }} />
                  <Button title="Save changes" variant="brand" onPress={saveDraft} style={{ flex: 1 }} />
                </View>
                <T variant="caption">Save or cancel this edit to continue.</T>
              </>
            ) : selecting ? (
              <>
                <Button title={`Remove ${selectedRows.size} from import`} variant="danger" onPress={removeSelected} disabled={busy || selectedRows.size === 0} />
                <T variant="caption">Only selected rows are excluded. They can be restored.</T>
              </>
            ) : (
              <>
                <Button title="Check & continue" variant="primary" onPress={() => void checkAllRows(true)} loading={busy} disabled={stageExpired || !mappingCheck.ready || needsDateAnswer || totalRows === 0 || !title.trim() || validation?.validRows === 0} />
                {!mappingCheck.ready || needsDateAnswer ? <T variant="caption">{needsDateAnswer ? "Choose how to read these dates first." : mappingCheck.duplicated.length > 0 ? "Each field needs a different column." : `Choose the missing columns: ${mappingCheck.missing.map((field) => FIELD_LABELS[field]).join(", ")}.`}</T> : null}
                <T variant="caption">Nothing is added until you confirm.</T>
              </>
            )}
          </View>
        </CsvKeyboardFrame>
        <ConfirmSheet visible={pendingEditor !== null} title="Discard this unsaved edit?" body="The row's saved changes are kept. Only the changes you have not saved will be discarded." confirmLabel="Discard edit" onConfirm={discardAndSwitch} onCancel={() => setPendingEditor(null)} />
        <OptionSheet
          visible={columnSheetField !== null}
          title={`Choose ${columnSheetField ? FIELD_LABELS[columnSheetField].toLowerCase() : "a column"}`}
          options={[
            ...(columnSheetField && !requiredFields(recordType, mixedStrategy).includes(columnSheetField) ? [{ id: "", name: "Not in file", detail: "Do not import this optional field" }] : []),
            ...headers.map((name) => ({ id: name, name, detail: previewRows.find((row) => row[name]?.trim())?.[name] || "No sample value" })),
          ]}
          value={columnSheetField ? mapping[columnSheetField] : null}
          onChoose={(name) => {
            if (!columnSheetField) return;
            setMapping((current) => ({ ...current, [columnSheetField]: name }));
            invalidateReview();
          }}
          onClose={() => setColumnSheetField(null)}
          emptyText="No columns found."
          searchPlaceholder="Search column names"
        />
        <OptionSheet
          visible={dateSheetOpen}
          title="How should these dates be read?"
          options={(["dmy", "mdy"] as const).map((id) => ({ id, name: DATE_FORMAT_LABELS[id] }))}
          value={dateFormat}
          onChoose={setDateFormat}
          onClose={() => setDateSheetOpen(false)}
          emptyText="No date formats available."
        />
      </Screen>
  );
}
