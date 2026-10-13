import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { isAxiosError } from "axios";
import { useLocation } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { ReportingPeriodScope } from "../context/ReportingPeriodContext";
import { invalidateServerState } from "../lib/serverStateCache";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { todayIso } from "../lib/dates";
import { Callout, Card, PageHead } from "../components/ui";
import { classifyTypeValue, parseSignedAmount, type RowRecordType } from "../lib/recordTypeDetection";
import { Button } from "../components/Button";
import { FormError } from "../components/Field";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { randomId } from "../lib/uuid";
import type { CsvConfirmDateFormat, CsvImportStatus } from "../lib/types";
import { problemWith, resultFromStatus, STATUS_POLL_INTERVAL_MS } from "./importCsv/csvImportRules";
import { ImportProgress } from "./importCsv/ImportProgress";
import { ImportResultSummary } from "./importCsv/ImportResultSummary";
import { FileSelectStage } from "./importCsv/FileSelectStage";
import { DetectedColumns } from "./importCsv/DetectedColumns";
import { ReviewTable, type ReviewRow } from "./importCsv/ReviewTable";
import { CsvFileSummary, CsvImportBreadcrumbs, CsvImportStepper } from "./importCsv/CsvImportStepper";
import type {
  ColumnChoice,
  ImportRecordType,
  ImportResult,
  MappedField,
  MixedStrategy,
  PreviewResult,
  RowCategory,
  RowCorrection,
  StagedPreviewResult,
} from "./importCsv/types";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { parseCsvDate } from "../lib/csvDates";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../components/AvailableFundsBaselineChoice";

const STAGED_UPLOAD_UNAVAILABLE = new Set([
  "CSV_STAGE_EXPIRED",
  "CSV_STAGE_NOT_FOUND",
  "CSV_STAGE_UNAVAILABLE",
  "CSV_IMPORT_STAGE_EXPIRED",
  "CSV_IMPORT_STAGE_NOT_FOUND",
]);

function isStagedUploadUnavailable(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status === 404 || status === 410) return true;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && STAGED_UPLOAD_UNAVAILABLE.has(code);
}

const NO_COLUMNS: ColumnChoice = { date: "", description: "", amount: "", category: "", vendor: "" };

/** How long the review waits after an edit before re-checking the whole file. */
const RECHECK_DELAY_MS = 700;

function withoutBaselineOverrides(corrections: Record<number, RowCorrection>): Record<number, RowCorrection> {
  let changed = false;
  const next: Record<number, RowCorrection> = {};
  for (const [rawRow, fields] of Object.entries(corrections)) {
    const row = Number(rawRow);
    const nextFields = { ...fields };
    if (nextFields.includedInAvailableFundsBaseline !== undefined) {
      delete nextFields.includedInAvailableFundsBaseline;
      changed = true;
    }
    if (Object.keys(nextFields).length > 0) next[row] = nextFields;
  }
  return changed ? next : corrections;
}

export function ImportCsv() {
  const { selected } = useBusinessProfiles();
  const location = useLocation();
  return (
    <ReportingPeriodScope>
      <ImportCsvForm key={`${selected?.id ?? "no-profile"}-${location.key}`} />
    </ReportingPeriodScope>
  );
}

/**
 * Upload -> Review and edit -> Import.
 *
 * There is no mapping step. The server reads the headings on upload and says
 * which column is which (backend lib/csvColumnDetection); the owner lands on
 * the review with the rows already read, each expense row already given a
 * category (lib/importCategoriser), and corrects only what is wrong. Every
 * edit is re-checked against the whole file on the server before import.
 */
function ImportCsvForm() {
  const { selected } = useBusinessProfiles();
  const { categories, refresh: refreshCategories } = useExpenseCategories();
  /*
   * Set when the setup wizard's last step sent the owner here. The import is
   * identical either way; this only changes where "done" points.
   */
  const fromOnboarding = Boolean((useLocation().state as { fromOnboarding?: boolean } | null)?.fromOnboarding);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [stagedUploadId, setStagedUploadId] = useState<string | null>(null);
  const [stage, setStage] = useState<"upload" | "review">("upload");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [recordType, setRecordType] = useState<ImportRecordType>("expense");
  const [mixedStrategy, setMixedStrategy] = useState<MixedStrategy>("column");
  /** The column naming each row's kind, for the "column" strategy. */
  const [typeCol, setTypeCol] = useState("");
  const [title, setTitle] = useState("");
  const [columns, setColumns] = useState<ColumnChoice>(NO_COLUMNS);
  /** The owner's edits, keyed by spreadsheet row number. Sent as `corrections`. */
  const [corrections, setCorrections] = useState<Record<number, RowCorrection>>({});
  /**
   * The owner's answer to "are these dates day-first or month-first?". Asked
   * only when the file is ambiguous; the server refuses such a file rather
   * than guess, and a wrong guess moves every row by up to eleven months.
   */
  const [dateFormat, setDateFormat] = useState<CsvConfirmDateFormat | "">("");

  /** The latest full-file check, and the inputs it was for. */
  const [check, setCheck] = useState<PreviewResult | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  /** Rows past the sample that a check flagged, kept so a fixed row stays on screen. */
  const [extraRows, setExtraRows] = useState<Map<number, Record<string, string>>>(new Map());
  const availableFundsBaseline = check
    ? (check.availableFundsBaseline ?? null)
    : (preview?.availableFundsBaseline ?? null);
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
  const dateSemanticsKey = `${columns.date}\u0000${dateFormat}`;
  const previousDateSemantics = useRef(dateSemanticsKey);

  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  /**
   * THE THING THAT MAKES A RETRY SAFE. Minted once per chosen file and reused
   * for every confirm attempt on it: the server keys the import on it, so an
   * impatient second click, a proxy retry or a refresh returns the SAME import
   * instead of doubling a month of books. Cleared only for a different file.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  /** Live counts while a large import runs on the worker. */
  const [progress, setProgress] = useState<CsvImportStatus | null>(null);
  /** Invalidates an in-flight poll loop when the owner starts over. */
  const pollToken = useRef(0);
  const checkSeq = useRef(0);
  const requests = useRef(new AbortController());
  const stageHeading = useRef<HTMLDivElement>(null);
  const previewPending = useRef(false);
  const confirmPending = useRef(false);
  /** Keeps review edits when an expired stage has to upload the same file again. */
  const restaging = useRef(false);

  useEffect(() => {
    requests.current = new AbortController();
    return () => {
      requests.current.abort();
      pollToken.current += 1;
    };
  }, []);

  useEffect(() => {
    if (previousDateSemantics.current === dateSemanticsKey) return;
    previousDateSemantics.current = dateSemanticsKey;
    setBaselineDecision(null);
    setCorrections((current) => withoutBaselineOverrides(current));
    setCheck(null);
    setCheckedKey(null);
    setPreview((current) => current ? { ...current, availableFundsBaseline: null } : current);
  }, [dateSemanticsKey, setBaselineDecision]);

  const isMixed = recordType === "mixed";
  const usesExpenseFields = recordType !== "sales";
  const usesSign = isMixed && mixedStrategy === "sign";
  const requiredColumns = [columns.date, columns.description, columns.amount, ...(isMixed && mixedStrategy === "column" ? [typeCol] : [])];
  const usedColumns = [
    ...requiredColumns,
    ...(usesExpenseFields ? [columns.vendor, columns.category] : []),
  ].filter(Boolean);
  const mappingIsValid =
    requiredColumns.every((column) => column !== "") && new Set(usedColumns).size === usedColumns.length;
  const dateChoiceNeeded = preview?.dateFormatAmbiguous === true && dateFormat === "";

  const columnMapping = useMemo(
    () => ({
      date: columns.date,
      description: columns.description,
      amount: columns.amount,
      ...(usesExpenseFields && columns.category ? { category: columns.category } : {}),
      ...(usesExpenseFields && columns.vendor ? { vendor: columns.vendor } : {}),
      ...(isMixed && mixedStrategy === "column" && typeCol ? { recordType: typeCol } : {}),
    }),
    [columns, usesExpenseFields, isMixed, mixedStrategy, typeCol],
  );

  const submittedCorrections = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(corrections)
          .map(([row, fields]) => [
            row,
            Object.fromEntries(
              Object.entries(fields)
                .filter(([key, value]) => (
                  key === "exclude"
                    ? value === true
                    : key === "includedInAvailableFundsBaseline"
                      ? typeof value === "boolean"
                      : typeof value === "string"
                ))
                .map(([key, value]) => [
                  key === "exclude" || key === "includedInAvailableFundsBaseline" ? key : key.toLowerCase(),
                  value,
                ]),
            ),
          ])
          .filter(([, fields]) => Object.keys(fields as object).length > 0),
      ),
    [corrections],
  );

  const reviewPayload = useMemo(
    () => ({
      stagedUploadId,
      businessProfileId: selected?.id,
      recordType,
      ...(isMixed ? { mixedStrategy } : {}),
      columnMapping,
      ...(Object.keys(submittedCorrections).length > 0 ? { corrections: submittedCorrections } : {}),
      ...(dateFormat ? { dateFormat } : {}),
      ...(baselineChoice.required && baselineChoice.decision !== null && availableFundsBaseline
        ? {
            includedInAvailableFundsBaseline: baselineChoice.decision,
            availableFundsBaselineAt: availableFundsBaseline.baselineAt,
          }
        : {}),
    }),
    [stagedUploadId, selected?.id, recordType, isMixed, mixedStrategy, columnMapping, submittedCorrections, dateFormat, baselineChoice.required, baselineChoice.decision, availableFundsBaseline],
  );
  const inputKey = JSON.stringify(reviewPayload);
  const checkIsCurrent = checkedKey === inputKey;
  const canCheck = stage === "review" && Boolean(stagedUploadId) && mappingIsValid && !dateChoiceNeeded && (preview?.totalRows ?? 0) > 0;

  /** Runs the server's own import rules over the whole file for these inputs. */
  async function runCheck(key: string, payload: typeof reviewPayload): Promise<PreviewResult | null> {
    const seq = ++checkSeq.current;
    const signal = requests.current.signal;
    setChecking(true);
    setCheckError(null);
    try {
      const { data } = await api.post<PreviewResult>("/records/csv-imports/preview", payload, { signal });
      if (seq !== checkSeq.current) return null;
      const nextBaseline = data.availableFundsBaseline ?? null;
      const baselineIdentityChanged = (availableFundsBaseline?.baselineAt ?? null) !== (nextBaseline?.baselineAt ?? null)
        || (availableFundsBaseline?.baselineDate ?? null) !== (nextBaseline?.baselineDate ?? null);
      if (baselineIdentityChanged) {
        setBaselineDecision(null);
        setCorrections((current) => withoutBaselineOverrides(current));
      }
      setCheck(data);
      setCheckedKey(key);
      if (data.reviewRows?.length) {
        setExtraRows((previous) => {
          const next = new Map(previous);
          for (const entry of data.reviewRows!) next.set(entry.row, entry.values);
          return next;
        });
      }
      return data;
    } catch (err) {
      if (signal.aborted || seq !== checkSeq.current) return null;
      if (isStagedUploadUnavailable(err)) recoverUnavailableStagedUpload();
      else if (await baselineChoice.absorb(err)) {
        setCheck(null);
        setCheckedKey(null);
        setCheckError("The recorded balance changed. Review this import again using the latest balance.");
      }
      else setCheckError(getErrorMessage(err));
      return null;
    } finally {
      if (seq === checkSeq.current && !signal.aborted) setChecking(false);
    }
  }

  // Re-check after every change, once the owner pauses. The first check runs
  // straight away so the review opens with real counts.
  useEffect(() => {
    if (!canCheck || checkIsCurrent) return;
    const payload = reviewPayload;
    const key = inputKey;
    const timer = setTimeout(() => void runCheck(key, payload), check ? RECHECK_DELAY_MS : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, canCheck]);

  useEffect(() => {
    setConfirmError(null);
  }, [inputKey, title]);

  useEffect(() => {
    if (stage !== "upload") stageHeading.current?.focus();
  }, [stage]);

  /** What each row becomes in a mixed file, read the same way the server reads it. */
  function rowTypeOf(raw: Record<string, string>, rowNumber: number): RowRecordType | null | undefined {
    if (!isMixed) return undefined;
    if (mixedStrategy === "sign") {
      const amount = parseSignedAmount(corrections[rowNumber]?.Amount ?? (columns.amount ? raw[columns.amount] : ""));
      if (amount === null || amount === 0) return null;
      return amount < 0 ? "expense" : "sales";
    }
    return typeCol ? classifyTypeValue(raw[typeCol]) : null;
  }

  const rowCategories = useMemo(() => new Map<number, RowCategory>((check?.rowCategories ?? []).map((entry) => [entry.row, entry])), [check]);
  const duplicateRows = useMemo(() => new Set(check?.validation?.duplicateRows ?? []), [check]);

  // Rows dated after the business's today are refused, here and on the server.
  const today = todayIso(selected?.timezone);
  const reviewRows: ReviewRow[] = useMemo(() => {
    if (!preview) return [];
    const source = new Map<number, Record<string, string>>();
    extraRows.forEach((values, row) => source.set(row, values));
    preview.previewRows.forEach((values, index) => source.set(index + 2, values));
    const fileValue = (raw: Record<string, string>, column: string) => (column ? (raw[column] ?? "") : "");
    return [...source.entries()]
      .sort(([a], [b]) => a - b)
      .map(([rowNumber, raw]) => {
        const fix = corrections[rowNumber] ?? {};
        const values: Record<MappedField, string> = {
          Date: fix.Date ?? fileValue(raw, columns.date),
          Description: fix.Description ?? fileValue(raw, columns.description),
          Amount: fix.Amount ?? fileValue(raw, columns.amount),
          Vendor: fix.Vendor ?? (usesExpenseFields ? fileValue(raw, columns.vendor) : ""),
          Category: fix.Category ?? "",
        };
        return {
          rowNumber,
          values,
          problem: mappingIsValid ? problemWith(values, dateFormat || (preview.detectedDateFormat ?? "iso"), usesSign, today) : null,
          recordType: rowTypeOf(raw, rowNumber),
          excluded: fix.exclude === true,
          duplicate: duplicateRows.has(rowNumber),
          category: rowCategories.get(rowNumber) ?? null,
          categoryEdited: fix.Category !== undefined,
          edited: Object.keys(fix).length > 0,
          baselineDateMatch: Boolean(
            availableFundsBaseline
              && parseCsvDate(values.Date, dateFormat || (preview.detectedDateFormat ?? "iso")) === availableFundsBaseline.baselineDate,
          ),
          includedInAvailableFundsBaseline: fix.includedInAvailableFundsBaseline,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, extraRows, corrections, columns, usesExpenseFields, mappingIsValid, dateFormat, usesSign, today, rowCategories, duplicateRows, isMixed, mixedStrategy, typeCol, availableFundsBaseline]);

  /** The owner's categories, then the ones this import would create, alphabetically. */
  const categoryOptions = useMemo(() => {
    const names = new Set<string>(categories.map((category) => category.name));
    for (const entry of check?.categorySummary?.newCategories ?? []) names.add(entry.name);
    for (const entry of check?.rowCategories ?? []) names.add(entry.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [categories, check]);

  if (!selected) return <NoBusinessProfile />;
  const businessProfileId = selected.id;

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (file && preview && stagedUploadId) {
      setStage("review");
      return;
    }
    if (!file || !idempotencyKey || previewPending.current) return;
    previewPending.current = true;
    const signal = requests.current.signal;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("businessProfileId", String(businessProfileId));
      formData.append("idempotencyKey", idempotencyKey);
      const { data } = await api.post<StagedPreviewResult>("/records/csv-imports/preview", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        signal,
      });
      signal.throwIfAborted();
      if (typeof data.stagedUploadId !== "string" || data.stagedUploadId.trim() === "") {
        setPreviewError("This file couldn't be prepared. Try again.");
        return;
      }
      const preserveDraft = restaging.current;
      restaging.current = false;
      setStagedUploadId(data.stagedUploadId);
      setPreview(data);
      setCheck(null);
      setCheckedKey(null);
      setExtraRows(new Map());
      setStage("review");
      if (preserveDraft) return;

      /*
       * Not asked for on the review screen: the batch is named after the file,
       * and the import type, split and type column come from detection below.
       */
      setTitle((file.name.replace(/\.csv$/i, "").trim() || "CSV import").slice(0, FIELD_LIMITS.importTitle));
      const detected = data.suggestedMapping ?? {};
      const next: ColumnChoice = {
        date: detected.date ?? "",
        description: detected.description ?? "",
        amount: detected.amount ?? "",
        category: detected.category ?? "",
        vendor: detected.vendor ?? "",
      };
      /*
       * A detected type column (Sale / Expense in words) makes this a mixed
       * file, and takes itself back from `category`, whose names include
       * "type": otherwise it would be read as category names and create
       * categories called "Sale" and "Expense". A column of negative amounts
       * is the bank-statement convention. Both are shown and changeable.
       */
      const detectedType = data.detectedTypeColumn ?? "";
      if (detectedType) {
        setRecordType("mixed");
        setMixedStrategy("column");
        setTypeCol(detectedType);
        if (next.category === detectedType) next.category = "";
      } else if (next.amount && (data.columnsWithNegatives ?? []).includes(next.amount)) {
        setRecordType("mixed");
        setMixedStrategy("sign");
        setTypeCol("");
      } else {
        setRecordType(data.columnDetection?.suggestedRecordType ?? "expense");
        setTypeCol("");
      }
      setColumns(next);
    } catch (err) {
      if (!signal.aborted) setPreviewError(getErrorMessage(err));
    } finally {
      previewPending.current = false;
      if (!signal.aborted) setPreviewing(false);
    }
  }

  /**
   * A chosen file, and the replay token that will identify its import — minted
   * HERE, when the import becomes a distinct thing, so every confirm attempt
   * for this file (retries included) is the same logical import.
   */
  function handleSelectFile(next: File | null) {
    if (previewPending.current || confirmPending.current) return;
    handleChooseDifferentFile();
    if (next) {
      setFile(next);
      setIdempotencyKey(randomId());
    }
  }

  /** Back to the file picker, clearing everything read from the old file. */
  function handleChooseDifferentFile() {
    if (confirmPending.current) return;
    const discardedStage = stagedUploadId;
    if (discardedStage) {
      void api.delete(`/records/csv-imports/stages/${encodeURIComponent(discardedStage)}`).catch(() => undefined);
    }
    // A different file is a different import, so the replay token goes with it.
    pollToken.current += 1;
    checkSeq.current += 1;
    restaging.current = false;
    setStagedUploadId(null);
    setIdempotencyKey(null);
    setDateFormat("");
    setProgress(null);
    setStage("upload");
    setPreview(null);
    setFile(null);
    setTitle("");
    setColumns(NO_COLUMNS);
    setTypeCol("");
    setRecordType("expense");
    setMixedStrategy("column");
    setCorrections({});
    setCheck(null);
    setCheckedKey(null);
    setChecking(false);
    setCheckError(null);
    setExtraRows(new Map());
    setConfirmError(null);
    setPreviewError(null);
  }

  function recoverUnavailableStagedUpload() {
    pollToken.current += 1;
    checkSeq.current += 1;
    restaging.current = Boolean(file);
    setStagedUploadId(null);
    setIdempotencyKey(file ? randomId() : null);
    setStage("upload");
    setPreview(null);
    setProgress(null);
    setCheck(null);
    setCheckedKey(null);
    setChecking(false);
    setConfirmError(null);
    setPreviewError(
      file ? "This upload expired. Upload the file again to continue." : "This upload expired. Choose the file again.",
    );
  }

  async function handleImport(e: FormEvent) {
    e.preventDefault();
    if (!file || !stagedUploadId || !idempotencyKey || !mappingIsValid || dateChoiceNeeded || title.trim() === "" || confirmPending.current) return;
    if (!baselineChoice.check()) return;
    confirmPending.current = true;
    const signal = requests.current.signal;
    setConfirming(true);
    setConfirmError(null);
    try {
      // Import exactly what was checked: re-check first if anything changed.
      let checked = checkIsCurrent ? check : null;
      if (!checked) checked = await runCheck(inputKey, reviewPayload);
      signal.throwIfAborted();
      if (!checked) return;
      if (checked.dateFormatAmbiguous && !dateFormat) {
        setConfirmError("Choose the date format first.");
        return;
      }
      if (!checked.validation) {
        setConfirmError("This file couldn't be checked. Try again.");
        return;
      }
      if (checked.validation.validRows === 0) {
        setConfirmError("No rows are ready to import.");
        return;
      }

      const checkedBaseline = checked.availableFundsBaseline ?? null;
      if (
        checkedBaseline
        && (
          !availableFundsBaseline
          || checkedBaseline.baselineAt !== availableFundsBaseline.baselineAt
          || checkedBaseline.baselineDate !== availableFundsBaseline.baselineDate
          || baselineChoice.decision === null
        )
      ) {
        setBaselineDecision(null);
        setConfirmError("The recorded balance changed. Choose again before importing.");
        return;
      }

      const correctionsWithoutBaseline = Object.fromEntries(
        Object.entries(reviewPayload.corrections ?? {})
          .map(([row, fields]) => {
            const nextFields = { ...(fields as Record<string, string | boolean>) };
            delete nextFields.includedInAvailableFundsBaseline;
            return [row, nextFields];
          })
          .filter(([, fields]) => Object.keys(fields).length > 0),
      );
      const confirmPayload = checkedBaseline
        ? {
            ...reviewPayload,
            includedInAvailableFundsBaseline: baselineChoice.decision!,
            availableFundsBaselineAt: checkedBaseline.baselineAt,
          }
        : {
            ...reviewPayload,
            includedInAvailableFundsBaseline: undefined,
            availableFundsBaselineAt: undefined,
            corrections: Object.keys(correctionsWithoutBaseline).length > 0
              ? correctionsWithoutBaseline
              : undefined,
          };

      const response = await api.post<ImportResult>(
        "/records/csv-imports/confirm",
        { ...confirmPayload, title, idempotencyKey },
        { signal },
      );
      signal.throwIfAborted();

      /*
       * 202: too big to import inside the request. The worker has it and every
       * count is still zero, so follow the status endpoint to the real counts
       * rather than render a summary saying nothing was imported. Detected on
       * both the status code and processingStatus, which survives a proxy.
       */
      const accepted =
        response.status === 202 ||
        response.data.processingStatus === "PENDING" ||
        response.data.processingStatus === "PROCESSING";
      if (accepted) {
        await followImport(response.data.batchId, response.data);
        return;
      }
      finish(response.data);
    } catch (err) {
      if (!signal.aborted) {
        if (isStagedUploadUnavailable(err)) recoverUnavailableStagedUpload();
        else if (await baselineChoice.absorb(err)) {
          setCheck(null);
          setCheckedKey(null);
          setConfirmError("The recorded balance changed. Review this import again using the latest balance.");
        }
        else setConfirmError(getErrorMessage(err));
      }
    } finally {
      confirmPending.current = false;
      if (!signal.aborted) setConfirming(false);
    }
  }

  /** New categories and new months exist now; the pickers elsewhere should show them. */
  function finish(summary: ImportResult, publishTerminalLedger = false) {
    setResult(summary);
    void refreshCategories().catch(() => undefined);
    if (publishTerminalLedger && selected) {
      invalidateServerState({
        businessProfileId: selected.id,
        tags: ["financial", "record-months", "notifications"],
      });
    }
  }

  /**
   * Follows a worker-run import to its end with REAL progress: processedRows
   * is the server's own count as each chunk commits. `token` stops an
   * abandoned loop from reviving a screen the owner left.
   */
  async function followImport(batchId: number, initial: ImportResult) {
    pollToken.current += 1;
    const token = pollToken.current;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (pollToken.current !== token) return;
      let status: CsvImportStatus;
      try {
        const { data } = await api.get<CsvImportStatus>(`/records/csv-imports/batches/${batchId}/status`, {
          signal: requests.current.signal,
        });
        status = data;
      } catch {
        if (pollToken.current !== token || requests.current.signal.aborted) return;
        // A dropped poll is not a failed import: the worker carries on.
        setProgress(null);
        setConfirmError("Couldn't check the import status. It may still be running. Press Import again to check safely.");
        return;
      }

      if (pollToken.current !== token) return;
      setProgress(status);

      if (status.processingStatus === "COMPLETE" || status.processingStatus === "FAILED") {
        if (status.processingStatus === "FAILED") setProgress(null);
        // A terminal failure can leave committed chunks; the summary shows them.
        finish(
          { ...resultFromStatus(status, initial.title || title), duplicateOfBatchId: initial.duplicateOfBatchId },
          true,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
    }
  }

  if (result) {
    return <ImportResultSummary result={result} fromOnboarding={fromOnboarding} />;
  }

  if (stage === "upload" || !preview) {
    return (
      <FileSelectStage
        file={file}
        totalRows={preview?.totalRows}
        previewError={previewError}
        previewing={previewing}
        onSelectFile={handleSelectFile}
        onSubmit={handleUpload}
      />
    );
  }

  function edit(rowNumber: number, field: MappedField, value: string) {
    setCorrections((previous) => {
      const current = { ...previous[rowNumber], [field]: value };
      delete current.includedInAvailableFundsBaseline;
      return { ...previous, [rowNumber]: current };
    });
  }

  function toggleExclude(rowNumber: number) {
    setCorrections((previous) => {
      const current = previous[rowNumber] ?? {};
      const next = { ...current, exclude: !current.exclude };
      delete next.includedInAvailableFundsBaseline;
      return { ...previous, [rowNumber]: next };
    });
  }

  function setRowBaselineDecision(rowNumber: number, value: boolean | undefined) {
    setCorrections((previous) => {
      const current = { ...(previous[rowNumber] ?? {}) };
      if (value === undefined) delete current.includedInAvailableFundsBaseline;
      else current.includedInAvailableFundsBaseline = value;
      if (Object.keys(current).length === 0) {
        const next = { ...previous };
        delete next[rowNumber];
        return next;
      }
      return { ...previous, [rowNumber]: current };
    });
  }

  /** A real date from the file, so the date question is about their data. */
  const sampleDate = columns.date
    ? (preview.previewRows.find((row) => (row[columns.date] ?? "").trim() !== "")?.[columns.date] ?? "")
    : "";
  const validation = check?.validation;
  const summary = check?.categorySummary;
  const removedCount = Object.values(corrections).filter((fix) => fix.exclude).length;
  const readyCount = validation?.validRows ?? null;
  const canImport = mappingIsValid && !dateChoiceNeeded && title.trim() !== "" && preview.totalRows > 0 && readyCount !== 0;
  const stale = !checkIsCurrent;

  return (
    <div>
      <CsvImportBreadcrumbs />
      <div ref={stageHeading} tabIndex={-1} className="outline-none">
        <PageHead title="Review import" />
      </div>

      <div className="space-y-5">
        <CsvImportStepper current={confirming ? 3 : 2} />
        <CsvFileSummary file={file!} totalRows={preview.totalRows} onChange={handleChooseDifferentFile} disabled={confirming} />

        <form onSubmit={(event) => void handleImport(event)}>
          <fieldset disabled={confirming} className="min-w-0 space-y-5">
            {/*
              "03/04/2026" is 3 April or 4 March and nothing in the file settles
              it. Asked only for a genuinely ambiguous file; the import waits for
              the answer rather than guessing.
            */}
            {preview.dateFormatAmbiguous ? (
              <Card className="border-edge-accent p-5">
                <fieldset>
                  <legend className="text-sm font-semibold text-ink-900">Date format</legend>
                  <p className="mt-1 text-xs text-ink-500">
                    {sampleDate ? (
                      <>
                        Dates like <b className="figure font-semibold text-ink-700">{sampleDate}</b> can be read two ways.
                      </>
                    ) : (
                      "These dates can be read two ways."
                    )}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        { value: "dmy", label: "Day first: 03/04 is 3 April", hint: "Common in the Philippines" },
                        { value: "mdy", label: "Month first: 03/04 is 4 March", hint: "Common in US exports" },
                      ] as { value: CsvConfirmDateFormat; label: string; hint: string }[]
                    ).map((option) => (
                      <label
                        key={option.value}
                        className={`flex min-h-tap cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors ${
                          dateFormat === option.value ? "border-edge-brand bg-tint-brand" : "border-paper-200 hover:bg-paper-100"
                        }`}
                      >
                        <input
                          type="radio"
                          name="csv-date-format"
                          value={option.value}
                          checked={dateFormat === option.value}
                          onChange={() => setDateFormat(option.value)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink-800">{option.label}</span>
                          <span className="block text-xs text-ink-600">{option.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </Card>
            ) : null}

            <DetectedColumns
              headers={preview.headers}
              choice={columns}
              onChange={(field, header) => setColumns((current) => ({ ...current, [field]: header }))}
              usesExpenseFields={usesExpenseFields}
              unmapped={(preview.columnDetection?.unmapped ?? []).filter(
                (entry) => !Object.values(columns).includes(entry.header) && entry.header !== typeCol,
              )}
              typeColumn={isMixed && mixedStrategy === "column" ? typeCol : ""}
            />

            {availableFundsBaseline ? (
              <AvailableFundsBaselineChoice
                choice={baselineChoice}
                disabled={confirming}
                question="Were these rows already included in the recorded balance?"
                help={`${availableFundsBaseline.matchingRowCount.toLocaleString()} valid row${availableFundsBaseline.matchingRowCount === 1 ? " uses" : "s use"} the same date as the latest balance you recorded. Choose the answer that applies by default, then change any exception in the row table.`}
              />
            ) : null}

            <Card className="p-5">
              <dl aria-live="polite" className={`grid grid-cols-2 gap-4 sm:grid-cols-4 ${stale && validation ? "opacity-60" : ""}`}>
                <Stat label="Rows" value={preview.totalRows.toLocaleString()} />
                <Stat label="Ready" value={readyCount === null ? "…" : readyCount.toLocaleString()} />
                <Stat
                  label="Skipped"
                  value={validation ? Math.max(0, validation.invalidRows - removedCount).toLocaleString() : "…"}
                  tone={validation && validation.invalidRows - removedCount > 0 ? "danger" : undefined}
                />
                <Stat
                  label="Possible duplicates"
                  value={validation ? (validation.possibleDuplicateRows ?? 0).toLocaleString() : "…"}
                  tone={validation?.possibleDuplicateRows ? "warn" : undefined}
                />
                {usesExpenseFields && summary ? (
                  <>
                    <Stat label="Categories suggested" value={summary.suggested.toLocaleString()} />
                    <Stat label="From file" value={summary.fromFile.toLocaleString()} />
                    <Stat
                      label="Uncategorised"
                      value={summary.uncategorised.toLocaleString()}
                      tone={summary.uncategorised > 0 ? "warn" : undefined}
                    />
                    {removedCount > 0 ? <Stat label="Removed" value={removedCount.toLocaleString()} /> : null}
                  </>
                ) : null}
              </dl>
              {checking ? (
                <p role="status" className="mt-3 text-xs text-ink-500">
                  Checking…
                </p>
              ) : checkError ? (
                <p role="alert" className="mt-3 text-xs text-tone-danger">
                  Couldn’t check the file. {checkError}
                </p>
              ) : !mappingIsValid ? (
                <p className="mt-3 text-xs text-tone-danger">Choose the missing columns to check the rows.</p>
              ) : dateChoiceNeeded ? (
                <p className="mt-3 text-xs text-tone-danger">Choose the date format to check the rows.</p>
              ) : null}
            </Card>

            {/*
              The categories this import would CREATE, named before anything is
              written: confirming this import is the owner's approval of them
              (D0-03), and a typo is cheapest to catch here.
            */}
            {usesExpenseFields && summary && summary.newCategories.length > 0 ? (
              <Callout tone="info">
                <b className="font-semibold">New categories:</b>{" "}
                {summary.newCategories.map((entry) => `${entry.name} (${entry.rows})`).join(", ")}. Created when you import.
              </Callout>
            ) : null}

            <Card className="p-5">
              <ReviewTable
                rows={reviewRows}
                totalRows={preview.totalRows}
                showExpenseFields={usesExpenseFields}
                mixed={isMixed}
                categoryOptions={categoryOptions}
                onEdit={edit}
                onToggleExclude={toggleExclude}
                baselineDefault={baselineChoice.decision}
                onBaselineDecision={setRowBaselineDecision}
              />
            </Card>

            {confirmError ? <FormError>{confirmError}</FormError> : null}

            {/* Real progress, or none: a large file reports processedRows as each chunk commits. */}
            {confirming && !checking ? <ImportProgress progress={progress} totalRows={preview.totalRows} /> : null}

            <div className="-mx-1 flex flex-col gap-3 border-t border-paper-200 bg-paper/95 px-1 py-4 sm:flex-row sm:items-center sm:justify-between lg:sticky lg:bottom-0 lg:z-20 lg:backdrop-blur">
              <Button type="button" variant="secondary" disabled={confirming} onClick={handleChooseDifferentFile}>
                Change file
              </Button>
              <Button type="submit" variant="primary" disabled={confirming || !canImport} className="w-full sm:w-auto">
                {confirming
                  ? checking
                    ? "Checking…"
                    : "Importing…"
                  : readyCount !== null && !stale
                    ? `Import ${readyCount.toLocaleString()} row${readyCount === 1 ? "" : "s"}`
                    : "Import"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warn" }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd
        className={`figure mt-1 text-lg font-semibold ${
          tone === "danger" ? "text-tone-danger" : tone === "warn" ? "text-tone-accent" : "text-ink-900"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
