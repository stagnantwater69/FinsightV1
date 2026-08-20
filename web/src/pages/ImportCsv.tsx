import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { Callout, Card, FormPage, PageHead, Tag } from "../components/ui";
import { classifyTypeValue, parseSignedAmount, type RowRecordType } from "../lib/recordTypeDetection";
import { parseCsvDate } from "../lib/csvDates";
import { Button, ButtonLink } from "../components/Button";
import { Celebration } from "../components/Confirmation";
import { Field, FileInput, FormError, SelectInput, TextInput } from "../components/Field";
import { Money } from "../components/Money";
import { SkeletonLine } from "../components/Skeleton";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import type { CsvConfirmDateFormat, CsvDateFormat, CsvImportStatus, CsvProcessingStatus } from "../lib/types";

interface PreviewResult {
  headers: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
  /** The server's guess at a sale/expense column, from its values. May be absent on older responses. */
  detectedTypeColumn?: string | null;
  /** Columns mixing negative and positive numbers — candidates for the sign convention. */
  columnsWithNegatives?: string[];
  /**
   * The date convention the file appears to use, read off its first
   * date-shaped column.
   */
  detectedDateFormat?: CsvDateFormat;
  /**
   * True when every sampled date fits BOTH day-first and month-first readings.
   * Confirm refuses such a file until the owner says which, so this screen has
   * to ask before it will let them import — see the date-convention card.
   */
  dateFormatAmbiguous?: boolean;
}

interface ImportResult {
  batchId: number;
  title: string;
  status: string;
  totalRows: number;
  imported: number;
  skipped: { row: number; reason: string }[];
  flagged: number;
  largeExpenseFlagged: number;
  importedExpenses?: number;
  importedSales?: number;
  uncategorised?: number;
  /** Where the WRITE got to, as opposed to the owner-facing review status. */
  processingStatus?: CsvProcessingStatus;
  /**
   * Another completed import of this profile carried byte-identical content.
   * A warning, never a block: re-importing a corrected export is legitimate,
   * but importing the same file twice by accident is the single most common
   * way an owner doubles a month of records.
   */
  duplicateOfBatchId?: number;
  /** Total skipped rows. Exceeds `skipped.length` when the worker capped its list. */
  skippedCount?: number;
  skippedTruncated?: boolean;
}

/**
 * The summary, rebuilt from a finished asynchronous import.
 *
 * A large file's confirm returns 202 with zero counts — the numbers only exist
 * once the worker is done, and they arrive through the status endpoint. This
 * maps that shape onto the one the summary screen already renders, so there is
 * exactly one summary screen rather than a second one for big files.
 */
function resultFromStatus(status: CsvImportStatus, title: string): ImportResult {
  const summary = status.resultSummary ?? {};
  return {
    batchId: status.batchId,
    title,
    status: status.status,
    processingStatus: status.processingStatus,
    totalRows: status.totalRows,
    imported: status.importedRows,
    skipped: summary.skipped ?? [],
    skippedCount: status.skippedRows,
    skippedTruncated: summary.skippedTruncated ?? false,
    flagged: status.flaggedRows,
    largeExpenseFlagged: summary.largeExpenseFlagged ?? 0,
    importedExpenses: summary.importedExpenses,
    importedSales: summary.importedSales,
    uncategorised: summary.uncategorised,
  };
}

/**
 * How often the import status is asked for while a large file runs.
 *
 * The endpoint is two indexed reads with no parsing and no writes, and is
 * deliberately NOT rate limited on the server for exactly this reason — a
 * limit sized for confirms would start rejecting the polling the async import
 * depends on.
 */
const STATUS_POLL_INTERVAL_MS = 1500;

/** What the file is being read as. "mixed" splits it row by row. */
type ImportRecordType = "expense" | "sales" | "mixed";
/** How a mixed file says which row is which. */
type MixedStrategy = "column" | "sign";

/**
 * Header synonyms, for guessing the column mapping.
 *
 * Owners export from Excel, Google Sheets, a POS app or a bookkeeper's
 * template, and the headings are mostly the obvious English words. Making
 * someone map four dropdowns by hand when their file literally says
 * "date,description,amount,category" is the kind of friction UAT item 32
 * measures ("could record a day quickly enough to do it regularly").
 *
 * The guess is a starting point, never a decision: every field stays editable
 * and says that it was matched automatically.
 */
const HEADER_SYNONYMS: Record<"date" | "description" | "amount" | "category" | "vendor", string[]> = {
  date: ["date", "txn date", "transaction date", "trans date", "posted", "day", "petsa"],
  description: ["description", "item", "particulars", "details", "detail", "memo", "notes", "note"],
  amount: ["amount", "total", "price", "cost", "value", "debit", "halaga"],
  category: ["category", "type", "class", "account", "group", "uri"],
  vendor: ["vendor", "supplier", "store", "shop", "merchant", "payee", "seller", "from", "tindahan"],
};

/**
 * The server's row rules, mirrored so a bad row can be shown and fixed
 * BEFORE the import runs rather than reported after it.
 *
 * This is a deliberate second copy of csvImport.service's validateRows, for
 * the same reason the receipt split editor re-checks its own arithmetic: the
 * server is still the authority and re-runs every one of these checks on the
 * corrected value, so the worst a drift here can do is show the owner a
 * problem that turns out not to be one (or miss one, which the server then
 * reports exactly as it does today). It can never let a bad row through.
 * The checks and their order — description, then date, then amount, then
 * category — match the server's so the reported reason is the same one.
 */
export type RowProblem = { field: MappedField; reason: string } | null;

function problemWith(
  values: Record<MappedField, string>,
  needsCategory: boolean,
  dateFormat: CsvDateFormat,
): RowProblem {
  if (!values.Description.trim()) return { field: "Description", reason: "Missing description" };

  /*
   * Parsed with the shared calendar parser, NOT `new Date(rawDate)`.
   *
   * The string constructor guessed month-first, parsed in browser-local time
   * and rolled Feb 31 over into March — so this check used to pass rows the
   * server then skipped and flag rows it would have accepted. A preview that
   * disagrees with the import is worse than no preview: the owner "fixes" a
   * row that was never wrong. See lib/csvDates.ts.
   */
  const rawDate = values.Date.trim();
  if (!rawDate || parseCsvDate(rawDate, dateFormat) === null) {
    return { field: "Date", reason: `Invalid date: "${rawDate}"` };
  }

  const rawAmount = values.Amount.trim();
  const amount = rawAmount ? Number(rawAmount.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { field: "Amount", reason: `Invalid amount: "${rawAmount}"` };
  }

  if (needsCategory && !values.Category.trim()) {
    return { field: "Category", reason: "Missing category" };
  }
  return null;
}

function normalise(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/** Exact synonym match first, then a contains match, so "Txn Date (PHP)" lands. */
function guessColumn(headers: string[], field: keyof typeof HEADER_SYNONYMS): string {
  const synonyms = HEADER_SYNONYMS[field];
  const exact = headers.find((h) => synonyms.includes(normalise(h)));
  if (exact) return exact;
  return headers.find((h) => synonyms.some((s) => normalise(h).includes(s))) ?? "";
}

export function ImportCsv() {
  const { selected } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  /*
   * Set when the setup wizard's last step sent the owner here. The import
   * itself is identical either way — this only changes where "done" points, so
   * that finishing setup lands on the dashboard the wizard promised rather than
   * dropping a brand-new owner into a records table.
   */
  const fromOnboarding = Boolean((useLocation().state as { fromOnboarding?: boolean } | null)?.fromOnboarding);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [recordType, setRecordType] = useState<ImportRecordType>("expense");
  const [mixedStrategy, setMixedStrategy] = useState<MixedStrategy>("column");
  /** The column naming each row's kind, for the "column" strategy. */
  const [typeCol, setTypeCol] = useState("");
  const [title, setTitle] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [descriptionCol, setDescriptionCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [categoryCol, setCategoryCol] = useState("");
  const [vendorCol, setVendorCol] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  /**
   * THE THING THAT MAKES A RETRY SAFE.
   *
   * Generated ONCE per chosen file and reused for every confirm attempt on
   * that file, including retries after an error. The server keys the import on
   * it: a replayed key returns the SAME logical import at whatever stage it
   * reached, never a second copy of the records (ADR-3). A key regenerated per
   * attempt would defeat the whole mechanism — an impatient second click, a
   * proxy retry or a refresh would each look like a brand-new import and
   * double a month of books, which is the worst outcome this endpoint has.
   *
   * Cleared only when a different file is chosen, because at that point it IS
   * a different import.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  /**
   * The owner's answer to "are these dates day-first or month-first?".
   *
   * Only asked when the preview reports the file ambiguous, and confirm is
   * blocked until it is answered — the server refuses such a file outright
   * rather than guessing, and guessing here would silently move every
   * transaction in the file by up to eleven months.
   */
  const [dateFormat, setDateFormat] = useState<CsvConfirmDateFormat | "">("");
  /** Live counts while a large import runs on the worker. */
  const [progress, setProgress] = useState<CsvImportStatus | null>(null);
  /** Invalidates an in-flight poll loop when the owner starts over. */
  const pollToken = useRef(0);
  /** Which fields were guessed rather than chosen, so each can say so. */
  const [autoMapped, setAutoMapped] = useState<Set<string>>(new Set());
  /**
   * Cells the owner has retyped, keyed by spreadsheet row number then field.
   * Sent to the server as `corrections` and applied there over the file.
   */
  const [corrections, setCorrections] = useState<Record<number, Partial<Record<MappedField, string>>>>({});

  /**
   * What each previewed row resolves to under the current strategy.
   *
   * Runs the SAME readers the server will (lib/recordTypeDetection.ts), so the
   * badge against a row and the record it becomes cannot disagree. `null` is a
   * row the file does not classify — shown as such rather than defaulted,
   * because a row silently defaulted to the wrong side is the one failure this
   * feature must not have.
   *
   * Above the `!selected` return because hooks cannot sit behind one, which is
   * also why the mixed check is spelled out here rather than using `isMixed`.
   */
  const previewRowTypes = useMemo(() => {
    if (!preview || recordType !== "mixed") return null;
    return preview.previewRows.map((row): RowRecordType | null => {
      if (mixedStrategy === "sign") {
        const amount = amountCol ? parseSignedAmount(row[amountCol]) : null;
        if (amount === null || amount === 0) return null;
        return amount < 0 ? "expense" : "sales";
      }
      return typeCol ? classifyTypeValue(row[typeCol]) : null;
    });
  }, [preview, recordType, mixedStrategy, amountCol, typeCol]);

  const typeSplit = useMemo(() => {
    if (!previewRowTypes) return null;
    return {
      sales: previewRowTypes.filter((t) => t === "sales").length,
      expenses: previewRowTypes.filter((t) => t === "expense").length,
      unknown: previewRowTypes.filter((t) => t === null).length,
    };
  }, [previewRowTypes]);

  if (!selected) return null;

  /**
   * One CSV column mapped to two FinSight fields is always a mistake — it would
   * import the description as the amount, or the date as the category — and
   * nothing stopped it before.
   */
  const isMixed = recordType === "mixed";
  /** Whether a category may be supplied at all — sales rows never carry one. */
  const usesCategory = recordType === "expense" || isMixed;

  const requiredMapping: [string, string][] = [
    ["date", dateCol],
    ["description", descriptionCol],
    ["amount", amountCol],
    // Required for a pure expense import, OPTIONAL for a mixed one: a combined
    // export often has no category column at all, and those expense rows land
    // in "Uncategorised" rather than being rejected.
    ...(recordType === "expense" ? ([["category", categoryCol]] as [string, string][]) : []),
    ...(isMixed && mixedStrategy === "column" ? ([["recordType", typeCol]] as [string, string][]) : []),
  ];

  // Vendor is checked for collisions but not for completeness: it is optional
  // (ExpenseRecord.vendor is nullable), so leaving it unmapped is a valid
  // choice, while pointing it at a column another field already owns is not.
  // Category joins it in the optional-but-exclusive set for mixed files.
  const allMapping: [string, string][] = [
    ...requiredMapping,
    ...(usesCategory ? ([["vendor", vendorCol]] as [string, string][]) : []),
    ...(isMixed ? ([["category", categoryCol]] as [string, string][]) : []),
  ];

  const duplicateColumns = new Set(
    allMapping
      .map(([, col]) => col)
      .filter((col, i, all) => col !== "" && all.indexOf(col) !== i),
  );

  const mappingIsComplete = requiredMapping.every(([, col]) => col !== "");
  const mappingIsValid = mappingIsComplete && duplicateColumns.size === 0;

  /**
   * A file whose dates read both ways cannot be imported until the owner says
   * which. The server refuses it outright (naming both readings) rather than
   * picking one, so blocking here is not extra strictness — it is asking the
   * question at the only moment the answer is cheap.
   */
  const dateChoiceNeeded = preview?.dateFormatAmbiguous === true && dateFormat === "";
  const readyToImport = mappingIsValid && !dateChoiceNeeded;


  function duplicateError(col: string): string | null {
    return col !== "" && duplicateColumns.has(col)
      ? `"${col}" is already mapped to another field. Each FinSight field needs its own column.`
      : null;
  }

  /** Once the owner picks a column themselves, it is no longer a guess. */
  function clearAuto(field: string) {
    setAutoMapped((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }


  async function handlePreview(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await api.post<PreviewResult>("/records/csv-imports/preview", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setPreview(data);
      setTitle(file.name.replace(/\.csv$/i, ""));

      // Guess the mapping from the headings. Anything not recognised stays
      // empty and the owner picks it, which is the behaviour that existed for
      // all four columns before.
      const guessed = {
        date: guessColumn(data.headers, "date"),
        description: guessColumn(data.headers, "description"),
        amount: guessColumn(data.headers, "amount"),
        category: guessColumn(data.headers, "category"),
        vendor: guessColumn(data.headers, "vendor"),
      };
      setDateCol(guessed.date);
      setDescriptionCol(guessed.description);
      setAmountCol(guessed.amount);
      setCategoryCol(guessed.category);
      setVendorCol(guessed.vendor);
      /*
       * OFFERED, NOT APPLIED SILENTLY — the owner still sees "Import as" and
       * can change it, and the table below badges every row so the split is
       * visible before anything is written.
       *
       * A detected type column also steals itself back from `category`, whose
       * synonym list contains "type": a file with a Type column of Sale/Expense
       * values would otherwise be auto-mapped as if those were category names,
       * and quietly create categories called "Sale" and "Expense".
       */
      const detectedType = data.detectedTypeColumn ?? "";
      if (detectedType) {
        setRecordType("mixed");
        setMixedStrategy("column");
        setTypeCol(detectedType);
        if (guessed.category === detectedType) {
          guessed.category = "";
          setCategoryCol("");
        }
      } else if ((data.columnsWithNegatives ?? []).includes(guessed.amount) && guessed.amount) {
        setRecordType("mixed");
        setMixedStrategy("sign");
        setTypeCol("");
      } else {
        setTypeCol("");
      }

      setAutoMapped(
        new Set([
          ...(Object.keys(guessed) as (keyof typeof guessed)[]).filter((k) => guessed[k] !== ""),
          ...(detectedType ? ["recordType"] : []),
        ]),
      );
    } catch (err) {
      setPreviewError(getErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  /**
   * A chosen file, and the replay token that will identify its import.
   *
   * The key is minted HERE — at the moment the import becomes a distinct
   * thing — rather than at confirm time, which is what makes every confirm
   * attempt for this file, retries included, the same logical import.
   */
  function handleSelectFile(next: File | null) {
    setFile(next);
    setIdempotencyKey(next ? crypto.randomUUID() : null);
    setDateFormat("");
    setProgress(null);
    setConfirmError(null);
  }

  /**
   * Back to the file picker, clearing the mapping with it.
   *
   * The mapping used to survive into the next file, whose headers may not
   * contain any of those column names — leaving the selects showing a blank
   * value that looked like a choice the owner had made.
   */
  function handleChooseDifferentFile() {
    // A different file is a different import, so the replay token goes with
    // it — reusing one across files would make the server answer with the
    // FIRST file's import.
    pollToken.current += 1;
    setIdempotencyKey(null);
    setDateFormat("");
    setProgress(null);
    setPreview(null);
    setFile(null);
    setTitle("");
    setDateCol("");
    setDescriptionCol("");
    setAmountCol("");
    setCategoryCol("");
    setVendorCol("");
    setTypeCol("");
    setRecordType("expense");
    setMixedStrategy("column");
    setAutoMapped(new Set());
    setCorrections({});
    setConfirmError(null);
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (!file || !mappingIsValid || dateChoiceNeeded) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("businessProfileId", String(selected!.id));
      formData.append("recordType", recordType);
      if (isMixed) formData.append("mixedStrategy", mixedStrategy);
      formData.append("title", title);
      formData.append(
        "columnMapping",
        JSON.stringify({
          date: dateCol,
          description: descriptionCol,
          amount: amountCol,
          // Omitted entirely when unmapped — the server's schema takes these as
          // optional, not as an empty string.
          ...(usesCategory && categoryCol ? { category: categoryCol } : {}),
          ...(usesCategory && vendorCol ? { vendor: vendorCol } : {}),
          ...(isMixed && mixedStrategy === "column" && typeCol ? { recordType: typeCol } : {}),
        }),
      );
      if (Object.keys(corrections).length > 0) {
        // Lower-cased keys, because the server names its fields the way the
        // columnMapping does rather than the way the table headings read.
        formData.append(
          "corrections",
          JSON.stringify(
            Object.fromEntries(
              Object.entries(corrections).map(([rowNumber, fields]) => [
                rowNumber,
                Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v])),
              ]),
            ),
          ),
        );
      }
      // Sent on EVERY attempt, retries included. See the state declaration.
      if (idempotencyKey) formData.append("idempotencyKey", idempotencyKey);
      // Sent only when the owner was asked. An unambiguous file speaks for
      // itself, and overriding it with a convention nobody chose would be a
      // guess wearing a decision's clothes.
      if (dateFormat) formData.append("dateFormat", dateFormat);

      const response = await api.post<ImportResult>("/records/csv-imports/confirm", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      /*
       * 202 — TOO BIG TO IMPORT INSIDE THE REQUEST.
       *
       * The batch exists and the durable worker has it, but no records are
       * written yet and every count in the body is zero. Rendering that as a
       * summary would tell the owner their 20,000-row file imported nothing.
       * So the screen switches to the progress view and follows the status
       * endpoint until the worker finishes, then renders the same summary
       * from the real counts.
       *
       * Detected on BOTH the status code and processingStatus: the status code
       * is the contract, and the field is what survives a proxy that rewrites
       * it.
       */
      const accepted =
        response.status === 202 ||
        response.data.processingStatus === "PENDING" ||
        response.data.processingStatus === "PROCESSING";

      if (accepted) {
        await followImport(response.data.batchId, response.data);
        return;
      }

      setResult(response.data);
    } catch (err) {
      setConfirmError(getErrorMessage(err));
    } finally {
      setConfirming(false);
    }
  }

  /**
   * Follows a worker-run import to its end, showing REAL progress.
   *
   * processedRows/totalRows is a genuine measurement the server keeps as it
   * commits each chunk, which is the only reason this screen shows a
   * determinate bar at all — the receipt reader, which has no such number,
   * deliberately shows named stages instead.
   *
   * `token` guards against the owner starting over mid-import: an abandoned
   * loop stops writing to state rather than reviving a screen they left.
   */
  async function followImport(batchId: number, initial: ImportResult) {
    pollToken.current += 1;
    const token = pollToken.current;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (pollToken.current !== token) return;
      let status: CsvImportStatus;
      try {
        const { data } = await api.get<CsvImportStatus>(
          `/records/csv-imports/batches/${batchId}/status`,
        );
        status = data;
      } catch (err) {
        /*
         * A dropped poll is not a failed import. The worker owns the batch and
         * carries on; what is lost is this screen's view of it. Saying so, and
         * naming the batch, is better than either a false failure or a
         * spinner that never resolves.
         */
        setProgress(null);
        setConfirmError(
          `${getErrorMessage(err)} — your import is still running on the server. Reopen your records in a moment to see it.`,
        );
        return;
      }

      if (pollToken.current !== token) return;
      setProgress(status);

      if (status.processingStatus === "COMPLETE") {
        setResult(resultFromStatus(status, initial.title || title));
        return;
      }
      if (status.processingStatus === "FAILED") {
        setProgress(null);
        setConfirmError(
          `This import stopped during the ${status.failureStage ?? "import"} step after ${status.processedRows} of ${status.totalRows} rows. Press Import again — FinSight will pick up the same import rather than starting a second one.`,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
    }
  }

  if (result) {
    const flaggedTotal = result.flagged + (result.largeExpenseFlagged ?? 0);
    // The COUNT, not the length of the list: a worker-run import caps the list
    // of skipped rows it persists, so `skipped.length` under-reports a large
    // file and "0 skipped" over a file that skipped 400 rows would be a lie.
    const skippedTotal = result.skippedCount ?? result.skipped.length;
    const clean = skippedTotal === 0 && flaggedTotal === 0 && result.duplicateOfBatchId === undefined;

    return (
      <FormPage eyebrow="Records" title="Import complete">
        {/*
          Confirmation.tsx names CSV import as one of the three moments that
          earns a designed ending — a lot of work landing at once — and it was
          the one that never got it. A clean import is a genuine payoff; an
          import with rows to review is not, so that case keeps the calm
          summary instead of being congratulated.
        */}
        {clean ? (
          <Celebration title={`${result.imported} record${result.imported === 1 ? "" : "s"} imported`}>
            Every row in <strong className="text-ink-800">{result.title}</strong> went in cleanly — nothing
            was skipped and nothing needs review.
          </Celebration>
        ) : null}

        <dl className={`space-y-2 text-sm ${clean ? "mt-6" : ""}`}>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-500">Rows in file</dt>
            <dd className="figure font-medium text-ink-900">{result.totalRows}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-500">Imported</dt>
            <dd className="figure font-medium text-ink-900">{result.imported}</dd>
          </div>
          {/*
            Broken out only when the file actually held both. A single-type
            import already said what it was on the previous screen, and
            repeating "0 sales" there would be noise.
          */}
          {result.importedExpenses !== undefined &&
          result.importedSales !== undefined &&
          result.importedExpenses > 0 &&
          result.importedSales > 0 ? (
            <>
              <div className="flex justify-between gap-3 pl-4">
                <dt className="text-ink-500">— as expenses</dt>
                <dd className="figure font-medium text-ink-900">{result.importedExpenses}</dd>
              </div>
              <div className="flex justify-between gap-3 pl-4">
                <dt className="text-ink-500">— as sales</dt>
                <dd className="figure font-medium text-ink-900">{result.importedSales}</dd>
              </div>
            </>
          ) : null}
          <div className="flex justify-between gap-3">
            <dt className="text-ink-500">Skipped</dt>
            <dd className="figure font-medium text-ink-900">{skippedTotal}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-500">Flagged as possible duplicates</dt>
            <dd className="figure font-medium text-ink-900">{result.flagged}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-500">Flagged as large expenses</dt>
            <dd className="figure font-medium text-ink-900">{result.largeExpenseFlagged ?? 0}</dd>
          </div>
        </dl>

        {/*
          THE SAME FILE, IMPORTED TWICE.

          The server hashes the file's bytes and tells us when a previous
          COMPLETE import of this profile carried identical content. It is a
          warning and never a block — re-importing a corrected export is
          legitimate — but importing the same file twice by accident is the
          single most common way an owner doubles a month of records, and the
          only cheap moment to notice is now.

          The duplicate detector will also have flagged the rows individually;
          this says the thing those individual flags are all about.
        */}
        {result.duplicateOfBatchId !== undefined ? (
          <div className="mt-4">
            <Callout tone="warn">
              <b className="font-semibold">This file was imported before.</b> An earlier import of this
              business had byte-for-byte the same contents, so these records are probably a second copy
              of ones you already have.{" "}
              <Link
                to="/records/flagged"
                className="tap-inline font-semibold text-tone-accent underline underline-offset-2"
              >
                Review the duplicates →
              </Link>
            </Callout>
          </div>
        ) : null}

        {/*
          The flag counts used to be dead numbers. A count of things needing
          review, with no way to reach them, is worse than no count — it tells
          the owner there is a problem and then leaves them to find it.
        */}
        {flaggedTotal > 0 ? (
          <div className="mt-4">
            <Callout tone="warn">
              <b className="font-semibold">
                {flaggedTotal} record{flaggedTotal === 1 ? "" : "s"} need a second look.
              </b>{" "}
              FinSight flags a record when it matches one you already have, or when it's large for your
              business.{" "}
              <Link
                to="/records/flagged"
                className="tap-inline font-semibold text-tone-accent underline underline-offset-2"
              >
                Review them now →
              </Link>
            </Callout>
          </div>
        ) : null}

        {/*
          Said here rather than left to be discovered: these rows imported
          successfully, so nothing is wrong — but an expense with no category is
          missing from every category breakdown until it has one, and the owner
          would otherwise have no reason to go looking.
        */}
        {result.uncategorised ? (
          <div className="mt-4">
            <Callout tone="info">
              <b className="font-semibold">
                {result.uncategorised} expense{result.uncategorised === 1 ? "" : "s"} had no category
                and went into "Uncategorised".
              </b>{" "}
              They're imported and counted — sorting them into real categories is what makes them
              show up in your spending breakdown.{" "}
              <Link
                to="/records"
                className="tap-inline font-semibold text-brand-700 underline underline-offset-2"
              >
                Sort them now →
              </Link>
            </Callout>
          </div>
        ) : null}

        {skippedTotal > 0 ? (
          <div className="mt-4 rounded-lg bg-tint-danger p-3 text-xs text-tone-danger ring-1 ring-edge-danger">
            <p className="mb-1 font-medium">
              These rows couldn't be read and were not imported. Fix them in your spreadsheet and import
              again:
            </p>
            <ul className="list-inside list-disc space-y-0.5">
              {result.skipped.map((s) => (
                <li key={s.row}>
                  Row {s.row}: {s.reason}
                </li>
              ))}
            </ul>
            {/* A worker-run import caps the list it keeps. Saying so is the
                difference between "these are the skipped rows" and "these are
                some of them". */}
            {result.skipped.length < skippedTotal ? (
              <p className="mt-1.5 font-medium">
                Showing {result.skipped.length} of {skippedTotal} skipped rows.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          {fromOnboarding ? (
            <ButtonLink to="/dashboard" variant={clean ? "primary" : "brand"}>
              Go to my dashboard
            </ButtonLink>
          ) : (
            /*
             * Straight to THIS import's records, not to all of them.
             *
             * It used to link to a bare /records, which dropped the owner into
             * every record they have ever had at the one moment they want to
             * look at the few hundred that just arrived — and left them to
             * rediscover the two filters (Source, then Which import) that
             * narrow it. The page already reads both from the URL, so the link
             * only has to say so.
             */
            <ButtonLink
              to={`/records?source=CSV_UPLOAD&importBatchId=${result.batchId}`}
              variant={clean ? "primary" : "brand"}
            >
              See these {result.imported} records
            </ButtonLink>
          )}
          <ButtonLink
            to="/records/csv-imports/new"
            state={fromOnboarding ? { fromOnboarding: true } : undefined}
            variant="secondary"
          >
            Import another file
          </ButtonLink>
        </div>
      </FormPage>
    );
  }

  // ---- stage 1: choose a file -------------------------------------------
  if (!preview) {
    return (
      <FormPage
        eyebrow="Records"
        title="Import CSV records"
        subtitle="Bring in a batch of expenses or sales from a spreadsheet export."
      >
        <form onSubmit={handlePreview} className="space-y-4">
          <Field label="CSV file" htmlFor="file" required>
            <FileInput
              accept=".csv,text/csv"
              maxBytes={5 * 1024 * 1024}
              file={file}
              onSelect={handleSelectFile}
              hintText="A .csv export from your spreadsheet, up to 5MB. The first row should be your column headings."
            />
          </Field>
          <p className="text-xs text-ink-500">
            Not sure what to include?{" "}
            <a href="/sample-import.csv" download className="font-medium text-brand-700 hover:text-brand-800">
              Download an example CSV
            </a>
          </p>
          {previewError ? <FormError>{previewError}</FormError> : null}

          {/* Parsing a real export can take a moment — commit to the shape of
              the mapping table that's about to appear rather than leaving the
              button label as the only signal, same reasoning as ScanReceipt's
              read skeleton. */}
          {previewing ? (
            <div aria-busy="true" aria-live="polite" className="space-y-3 rounded-xl bg-paper-100 p-4">
              <span className="sr-only">Reading your file…</span>
              <p className="text-xs font-medium text-ink-500">Reading your file…</p>
              <SkeletonLine className="w-1/3" />
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-2/3" />
            </div>
          ) : null}

          <Button type="submit" variant="primary" fullWidth disabled={previewing || !file}>
            {previewing ? "Reading file…" : "Preview"}
          </Button>
        </form>
      </FormPage>
    );
  }

  // ---- stage 2: map the columns and check the result ---------------------
  //
  // Deliberately NOT inside FormPage, for the reason ScanReceipt's confirm
  // screen isn't either: FormPage's single form-measure column (max-w-3xl)
  // exists to keep label/field pairs scannable, and it is exactly the wrong
  // container for a wide data table. The table is the primary object on this
  // screen, so the screen is built around the table instead.
  const columns: MappedColumn[] = [
    {
      field: "Date",
      value: dateCol,
      onChange: (v) => {
        setDateCol(v);
        clearAuto("date");
      },
      auto: autoMapped.has("date"),
    },
    {
      field: "Description",
      value: descriptionCol,
      onChange: (v) => {
        setDescriptionCol(v);
        clearAuto("description");
      },
      auto: autoMapped.has("description"),
    },
    ...(recordType === "expense"
      ? [
          {
            field: "Category" as const,
            value: categoryCol,
            onChange: (v: string) => {
              setCategoryCol(v);
              clearAuto("category");
            },
            auto: autoMapped.has("category"),
          },
          {
            field: "Vendor" as const,
            value: vendorCol,
            onChange: (v: string) => {
              setVendorCol(v);
              clearAuto("vendor");
            },
            auto: autoMapped.has("vendor"),
            optional: true,
          },
        ]
      : []),
    {
      field: "Amount",
      value: amountCol,
      onChange: (v) => {
        setAmountCol(v);
        clearAuto("amount");
      },
      auto: autoMapped.has("amount"),
      align: "right" as const,
    },
  ];

  /**
   * Every previewed row, read through the mapping and through any correction
   * the owner has typed, with the first thing wrong with it (if anything).
   *
   * Row numbers are the spreadsheet's own — header is row 1 — so the number
   * shown here is the number to look for in Excel, and is the same key the
   * server reports skips against.
   */
  const analysed = preview.previewRows.map((row, i) => {
    const rowNumber = i + 2;
    const values = Object.fromEntries(
      columns.map((c) => [c.field, corrections[rowNumber]?.[c.field] ?? (c.value ? (row[c.value] ?? "") : "")]),
    ) as Record<MappedField, string>;
    return {
      rowNumber,
      values,
      // The owner's stated convention when they were asked for one, otherwise
      // whatever the server detected from the file itself — the same answer
      // the import will use, so the two cannot disagree.
      problem: problemWith(values, recordType === "expense", dateFormat || (preview.detectedDateFormat ?? "iso")),
    };
  });
  const brokenRows = mappingIsValid ? analysed.filter((r) => r.problem !== null) : [];
  const fixedCount = Object.keys(corrections).length;

  /**
   * Category names in the file that this business does not have yet.
   *
   * WHY THIS IS WORTH SAYING OUT LOUD: confirmImport CREATES every category
   * name the file mentions that it cannot match (resolveCategories), silently.
   * That is the right behaviour — an import must not fail because a category
   * does not exist yet — but it means one typo becomes a permanent second
   * category. A file reading "Inventroy" against a business that already has
   * "Inventory" imports cleanly, and the owner finds the near-duplicate weeks
   * later in a report that splits their stock spending across two lines.
   *
   * Matched case-insensitively because resolveCategories matches that way; a
   * warning that flags "inventory" as new when the server will match it to
   * "Inventory" would be a lie about what is going to happen.
   *
   * Computed from the rows on screen, not the whole file, which is why the
   * callout says which rows it looked at whenever the preview is truncated —
   * a category first appearing at row 300 of a 500-row file is not something
   * this can see, and implying otherwise would be worse than saying nothing.
   */
  const newCategoryNames = (() => {
    if (recordType !== "expense" || !categoryCol) return [];
    const existing = new Set(categories.map((c) => c.name.trim().toLowerCase()));
    const seen = new Map<string, string>();
    for (const { values } of analysed) {
      const raw = values.Category?.trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      // Deduplicated on the same key resolveCategories uses, so a file
      // spelling it "Inventory" and "inventory" reports one new category
      // rather than two — which is also what the server will create.
      if (!existing.has(key) && !seen.has(key)) seen.set(key, raw);
    }
    return [...seen.values()];
  })();

  /** A real date from the file, so the question above is about their data. */
  const sampleDate = dateCol
    ? (preview.previewRows.find((row) => (row[dateCol] ?? "").trim() !== "")?.[dateCol] ?? "")
    : "";

  function correct(rowNumber: number, field: MappedField, value: string) {
    setCorrections((prev) => ({ ...prev, [rowNumber]: { ...prev[rowNumber], [field]: value } }));
  }

  return (
    <div>
      <PageHead
        eyebrow="Records"
        title="Map your columns"
        subtitle="Each heading below picks which column of your file feeds it. The rows underneath are your real data, read through those choices — what you see is what gets imported."
        actions={
          <Button type="button" variant="secondary" size="sm" onClick={handleChooseDifferentFile}>
            Choose a different file
          </Button>
        }
      />

      <form onSubmit={handleConfirm} className="space-y-4">
        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Import as"
              htmlFor="csv-record-type"
              required
              hint={
                isMixed
                  ? "FinSight will sort each row using your file's own values — check the Type column below before importing."
                  : undefined
              }
            >
              <SelectInput
                value={recordType}
                onChange={(e) => setRecordType(e.target.value as ImportRecordType)}
              >
                <option value="expense">Expense records</option>
                <option value="sales">Sales reference records</option>
                <option value="mixed">Both — my file has sales and expenses</option>
              </SelectInput>
            </Field>
            <Field
              label="Batch title"
              htmlFor="csv-title"
              required
              hint="What to call this import in your records, so you can find it again."
            >
              <TextInput
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={FIELD_LIMITS.importTitle}
                required
              />
            </Field>
          </div>

          {/*
            Only for a mixed file, and stated as a question about the FILE
            rather than about FinSight — an owner knows whether their sheet has
            a "Type" column or uses minus signs; they do not know what a
            "strategy" is.
          */}
          {isMixed ? (
            <div className="mt-4 border-t border-paper-200 pt-4">
              <Field
                label="How does your file say which is which?"
                htmlFor="csv-mixed-strategy"
                required
              >
                <SelectInput
                  value={mixedStrategy}
                  onChange={(e) => setMixedStrategy(e.target.value as MixedStrategy)}
                >
                  <option value="column">A column says "sale" or "expense"</option>
                  <option value="sign">Expenses are negative amounts (−)</option>
                </SelectInput>
              </Field>

              {mixedStrategy === "column" ? (
                <Field
                  label="Which column?"
                  htmlFor="csv-type-col"
                  required
                  error={duplicateError(typeCol)}
                  hint={
                    autoMapped.has("recordType")
                      ? "Matched automatically from your file — change it if that's wrong."
                      : undefined
                  }
                >
                  <SelectInput value={typeCol} onChange={(e) => setTypeCol(e.target.value)}>
                    <option value="">Choose a column…</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              ) : null}

              {/*
                The count is the check. A file the owner believes is half sales
                that reads as 50 sales and 0 expenses is a mapping mistake they
                can see here, in a second, instead of discovering it in their
                dashboard a week later.
              */}
              {typeSplit ? (
                <Callout tone={typeSplit.unknown > 0 ? "warn" : "info"}>
                  {preview.totalRows > preview.previewRows.length ? (
                    <>In the first {preview.previewRows.length} rows: </>
                  ) : (
                    <>In this file: </>
                  )}
                  <b className="font-semibold">{typeSplit.sales} sales</b> ·{" "}
                  <b className="font-semibold">{typeSplit.expenses} expenses</b>
                  {typeSplit.unknown > 0 ? (
                    <>
                      {" "}
                      · <b className="font-semibold">{typeSplit.unknown} unrecognised</b>. Rows
                      FinSight can't read a type from are skipped and listed after the import — they
                      are never guessed.
                    </>
                  ) : (
                    <>. Every row below shows which it will become.</>
                  )}
                </Callout>
              ) : null}
            </div>
          ) : null}
        </Card>

        {/*
          THE DATE QUESTION, ASKED BEFORE ANYTHING IS WRITTEN.

          "03/04/2026" is either the 3rd of April or the 4th of March, and
          nothing in the file settles it. The server refuses a file whose dates
          fit both readings rather than guessing — a wrong guess moves every
          transaction by up to eleven months, silently, and the owner would
          find out from a report weeks later.

          Shown only when the preview says the file is genuinely ambiguous. A
          file with a month spelled out, or with any date past the 12th, is
          unambiguous and is never asked about.
        */}
        {preview.dateFormatAmbiguous ? (
          <Card className="border-edge-accent p-5">
            <fieldset>
              <legend className="text-sm font-semibold text-ink-900">
                Which way round are your dates?
              </legend>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                {sampleDate ? (
                  <>
                    Your file has dates like <b className="figure font-semibold text-ink-700">{sampleDate}</b>,
                    which could be read either way. FinSight won't guess — every date in the file is read the
                    way you choose here.
                  </>
                ) : (
                  <>
                    The dates in this file could be read either way. FinSight won't guess — every date is read
                    the way you choose here.
                  </>
                )}
              </p>
              <div className="mt-3 space-y-2">
                {(
                  [
                    { value: "dmy", label: "Day first — 03/04 means 3 April", hint: "Usual in the Philippines, the UK and most of Europe." },
                    { value: "mdy", label: "Month first — 03/04 means 4 March", hint: "Usual in the United States, and in some POS exports." },
                  ] as { value: CsvConfirmDateFormat; label: string; hint: string }[]
                ).map((option) => (
                  <label
                    key={option.value}
                    className={`flex min-h-tap cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors ${
                      dateFormat === option.value
                        ? "border-edge-brand bg-tint-brand"
                        : "border-paper-200 hover:bg-paper-100"
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
                      <span className="block text-xs text-ink-500">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </Card>
        ) : null}

        {/*
          The mapping lives in the table header rather than in four selects
          stacked above it.

          It used to be both: four full-height <Field> rows saying "Date ←
          txn_date", and then a preview immediately below re-stating the same
          four mappings as its column headings. The owner scrolled past ~400px
          of controls — usually all four already correct, since the header
          guess in HEADER_SYNONYMS lands on most real exports — to reach the
          data they actually wanted to look at.

          Merging the two puts each choice against the values it governs, so a
          wrong guess is visible rather than inferred, and gives the table the
          vertical space that the duplicated controls were using. The submitted
          columnMapping is byte-for-byte what it was.
        */}
        {/*
          A capped height, deliberately, rather than letting the table run the
          full length of the page.

          `overflow-x: auto` is needed so a narrow screen scrolls the table
          instead of the document, and that computes `overflow-y` to `auto`
          too — which makes this div a scroll container whether or not it is
          told a height. Without a max-height it is a scroll container that can
          never scroll, and `sticky` on the headers then resolves against it and
          silently does nothing: scroll the page on a 50-row file and the
          mapping controls leave the screen with no way back. Capping it makes
          the sticky header real, so the pickers stay pinned above the data
          they govern for the whole scroll.
        */}
        <div className="max-h-[70vh] overflow-auto rounded-2xl border border-paper-200 bg-paper shadow-sm">
          <table className="w-full min-w-[58rem] border-collapse text-left text-sm">
            <caption className="sr-only">
              Your CSV data, shown through the current column mapping
            </caption>
            <thead>
              <tr>
                {/* A row-number gutter, so "Row 3" in the panel below is
                    something the owner can actually find up here — and the
                    same number their spreadsheet uses. */}
                <th
                  scope="col"
                  className="sticky top-0 z-10 w-12 border-b border-paper-200 bg-paper-100/95 px-3 py-2.5 align-top text-right backdrop-blur"
                >
                  <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-400">#</span>
                </th>
                {/* Only for a mixed file: the column that says what each row
                    becomes, which is the whole thing being checked here. */}
                {isMixed ? (
                  <th
                    scope="col"
                    className="sticky top-0 z-10 w-28 border-b border-paper-200 bg-paper-100/95 px-3 py-2.5 align-top backdrop-blur"
                  >
                    <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-400">
                      Imports as
                    </span>
                  </th>
                ) : null}
                {columns.map((c) => (
                  <MappedHeader
                    key={c.field}
                    column={c}
                    headers={preview.headers}
                    error={duplicateError(c.value)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {analysed.map(({ rowNumber, values, problem }, rowIndex) => (
                <tr
                  key={rowNumber}
                  // A row that won't import is marked here too, so the count in
                  // the panel below corresponds to something visible in the data
                  // rather than being a number the owner has to take on trust.
                  className={`border-t border-paper-200 ${
                    problem ? "bg-tint-danger/40" : "even:bg-paper-100/40"
                  }`}
                >
                  <td className="figure px-3 py-2 text-right text-xs text-ink-400">{rowNumber}</td>
                  {isMixed ? (
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <RowTypeBadge type={previewRowTypes?.[rowIndex] ?? null} />
                    </td>
                  ) : null}
                  {columns.map((c) => (
                    <td
                      key={c.field}
                      className={`px-3 py-2 align-top text-ink-700 ${
                        c.align === "right" ? "text-right" : ""
                      } ${c.field === "Description" ? "" : "whitespace-nowrap"}`}
                    >
                      <CellValue value={values[c.field]} column={c} isProblem={problem?.field === c.field} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/*
          What this import will ADD, not just what it will bring in.

          Creating a category is a side effect the owner never asked for and
          previously never saw — they asked to import expenses, and got new
          entries in a list they curate elsewhere. Naming them here makes a
          typo obvious while the mapping can still be changed, which is the
          only moment it is cheap to fix.

          An observation, never a blocker: a genuinely new category is the
          normal case for a first import, and most of these will be correct.
        */}
        {newCategoryNames.length > 0 ? (
          <Callout tone="info">
            <b className="font-semibold">
              This import will create {newCategoryNames.length} new categor
              {newCategoryNames.length === 1 ? "y" : "ies"}:
            </b>{" "}
            {newCategoryNames.join(", ")}.{" "}
            {preview.previewRows.length < preview.totalRows
              ? `That is from the ${preview.previewRows.length} rows shown — later rows may add more. `
              : ""}
            If one of those is a misspelling of a category you already have, fix it in the
            highlighted rows or change the Category column above, or you'll end up with two
            categories for the same thing.
          </Callout>
        ) : null}

        {/*
          Rows that won't import, put in front of the owner while the import
          can still include them.

          The skip report already existed, but only afterwards, and it said
          "Fix them in your spreadsheet and import again" — reopen Excel, find
          the row, retype the cell, re-upload, re-map. For a file where three
          dates are formatted oddly that is the whole import done twice. The
          same three cells are editable here, and the fixes ride along with
          the import as corrections applied over the file.
        */}
        {brokenRows.length > 0 ? (
          <Card className="border-edge-accent p-5">
            <h2 className="text-sm font-semibold text-ink-900">
              {brokenRows.length} row{brokenRows.length === 1 ? "" : "s"} won't import as{" "}
              {brokenRows.length === 1 ? "it is" : "they are"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Fix the highlighted cell to bring the row in, or leave it and it will be skipped — the
              rest of the file imports either way. Nothing here changes your original file.
            </p>

            <ul className="mt-3 space-y-2">
              {brokenRows.map(({ rowNumber, values, problem }) => (
                <li key={rowNumber} className="rounded-xl bg-paper-100 p-3">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="figure text-xs font-semibold text-ink-600">Row {rowNumber}</span>
                    <p
                      id={`fix-${rowNumber}-${problem!.field}-why`}
                      className="text-xs text-tone-danger"
                    >
                      {problem!.reason}
                    </p>
                  </div>
                  {/*
                    The broken cell gets the full width and the keyboard; the
                    rest are read-only context so the owner can recognise the
                    row without going back to the spreadsheet. Grid rather than
                    a nowrap flex row — at five columns the row no longer fits
                    on one line at any sensible field width.
                  */}
                  <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]">
                    {columns.map((c) => {
                      const isProblem = problem!.field === c.field;
                      const id = `fix-${rowNumber}-${c.field}`;
                      return (
                        <div key={c.field} className={`min-w-0 ${isProblem ? "sm:col-span-2" : ""}`}>
                          <label htmlFor={id} className="block text-[11px] font-medium text-ink-500">
                            {c.field}
                          </label>
                          {isProblem ? (
                            <TextInput
                              id={id}
                              value={values[c.field]}
                              onChange={(e) => correct(rowNumber, c.field, e.target.value)}
                              aria-describedby={`${id}-why`}
                              aria-invalid
                              className="!border-edge-danger"
                            />
                          ) : (
                            <p className="truncate pt-1.5 text-sm text-ink-600" title={values[c.field]}>
                              {values[c.field] || "—"}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : fixedCount > 0 ? (
          <Callout tone="brand">
            Every row is ready to import now.
          </Callout>
        ) : null}

        {confirmError ? <FormError>{confirmError}</FormError> : null}

        {/*
          REAL PROGRESS, OR NONE.

          A large file leaves the request (202) and runs on the durable worker,
          which records processedRows as it commits each chunk. That is a
          genuine measurement, so this is one of the few places in FinSight
          that draws a determinate bar — and the number beside it is the
          server's own count, not an animation.

          Before the first status comes back there is nothing to measure, so
          the same block says what is happening in words instead of drawing an
          empty bar and calling it 0%.
        */}
        {confirming ? (
          <ImportProgress progress={progress} totalRows={preview.totalRows} />
        ) : null}

        {/*
          The action bar sticks to the bottom of the viewport rather than
          sitting at the end of the page.

          WHY: this screen is deliberately tall — a 70vh table, and under it one
          editable card per row that won't import. Ending with the button meant
          the owner scrolled the whole file AND every fix panel to reach
          "Import", and then scrolled back down again after correcting a cell.
          The primary action of a screen should not be the hardest thing on it
          to reach.

          It also keeps the row count permanently in view, which is the number
          that tells the owner whether the mapping above is doing what they
          think — that count used to scroll away with the table it described.
        */}
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-paper-200 bg-paper/95 px-1 py-3 backdrop-blur">
          <div className="flex flex-wrap gap-3">
            {/*
              The count promises what will actually land. Saying "Import 35 rows"
              over a file where three of them are going to be skipped is a small
              lie the owner only discovers on the results screen — and the
              preview is capped, so it is only a reliable count when the whole
              file is on screen.
            */}
            <Button type="submit" variant="primary" disabled={confirming || !readyToImport}>
              {confirming
                ? "Importing…"
                : brokenRows.length > 0 && preview.previewRows.length === preview.totalRows
                  ? `Import ${preview.totalRows - brokenRows.length} of ${preview.totalRows} rows`
                  : `Import ${preview.totalRows} row${preview.totalRows === 1 ? "" : "s"}`}
            </Button>
            <Button type="button" variant="secondary" onClick={handleChooseDifferentFile}>
              Choose a different file
            </Button>
          </div>
          <p className="text-xs text-ink-500">
            Showing {preview.previewRows.length} of {preview.totalRows} row
            {preview.totalRows === 1 ? "" : "s"}.{" "}
            {brokenRows.length === 0
              ? `All ${preview.totalRows} will be imported.`
              : `${brokenRows.length} won't import as ${brokenRows.length === 1 ? "it is" : "they are"}.`}
          </p>
        </div>
      </form>
    </div>
  );
}

/**
 * A running import, as the owner sees it.
 *
 * Two states, and the difference between them matters: before the first status
 * response there is no measurement, so there is no bar. Drawing an empty one
 * and calling it 0% would be the same lie as an indeterminate bar that fills
 * on a timer.
 */
function ImportProgress({
  progress,
  totalRows,
}: {
  progress: CsvImportStatus | null;
  totalRows: number;
}) {
  const total = progress?.totalRows || totalRows;
  const processed = progress?.processedRows ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  if (!progress) {
    return (
      <div aria-busy="true" className="space-y-3 rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm">
        <p aria-live="polite" className="text-sm font-medium text-ink-700">
          Importing your records…
        </p>
        <p className="text-xs text-ink-500">
          FinSight is validating every row before it writes any of them.
        </p>
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-2/3" />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p aria-live="polite" className="text-sm font-medium text-ink-700">
          Importing your records…
        </p>
        <p className="figure text-sm text-ink-600">
          {processed.toLocaleString()} of {total.toLocaleString()} rows
        </p>
      </div>
      {/*
        `motion-safe:` on the width transition, not on the bar itself — the bar
        must still move for someone who asked for reduced motion, it just
        should not glide.
      */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
        aria-valuetext={`${processed} of ${total} rows imported`}
        className="h-2 w-full overflow-hidden rounded-full bg-paper-200"
      >
        <div
          className="h-full rounded-full bg-brand-600 motion-safe:transition-[width] motion-safe:duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-ink-500">
        This file is large enough that FinSight is importing it in the background. You can leave this
        page — the import finishes either way.
      </p>
    </div>
  );
}

/** FinSight's own field names — the things a CSV column can become. */
export type MappedField = "Date" | "Description" | "Category" | "Vendor" | "Amount";

interface MappedColumn {
  /** FinSight's own field name — the thing this column becomes on import. */
  field: MappedField;
  /** The CSV header currently feeding it, or "" when unmapped. */
  value: string;
  onChange: (v: string) => void;
  /** True while this is still FinSight's guess rather than the owner's choice. */
  auto: boolean;
  align?: "right";
  /** Leaving it unmapped is a valid choice — currently Vendor alone. */
  optional?: boolean;
}

/**
 * Per-column widths.
 *
 * Left to itself the table gives five equal columns, which is wrong in both
 * directions at once: a date needs about nine characters and a description
 * routinely runs past forty, so the dates sit in a sea of whitespace while the
 * descriptions wrap. These are the shape of the data, not the header.
 */
const COLUMN_WIDTH: Record<MappedField, string> = {
  Date: "w-[9.5rem]",
  Description: "w-auto",
  Category: "w-[11rem]",
  Vendor: "w-[11rem]",
  Amount: "w-[9.5rem]",
};

/**
 * A column heading that is also its own column picker.
 *
 * `scope="col"` and the visible field name are kept so the header still does
 * its ordinary table job for a screen reader; the select carries an explicit
 * aria-label because "Date" alone doesn't say what choosing something here
 * would do.
 */
/**
 * What one row of a mixed file will become.
 *
 * Reuses the app's existing expense/sales Tag so an imported row is labelled
 * here exactly as it will be labelled everywhere else. The unreadable case gets
 * its own treatment rather than a third colour of the same chip: it is not a
 * third kind of record, it is a row that will not be imported at all, and it
 * has to read as a problem.
 */
function RowTypeBadge({ type }: { type: RowRecordType | null }) {
  if (type === null) {
    return (
      <span className="inline-flex shrink-0 rounded-lg bg-tint-danger px-2 py-0.5 text-[11.5px] font-semibold text-tone-danger ring-1 ring-edge-danger">
        Can't tell
      </span>
    );
  }
  return <Tag kind={type === "expense" ? "expense" : "sales"} />;
}

function MappedHeader({
  column,
  headers,
  error,
}: {
  column: MappedColumn;
  headers: string[];
  error: string | null;
}) {
  const id = `csv-map-${column.field.toLowerCase()}`;
  return (
    <th
      scope="col"
      className={`sticky top-0 z-10 border-b border-paper-200 bg-paper-100/95 px-3 py-2.5 align-top backdrop-blur ${COLUMN_WIDTH[column.field]}`}
    >
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
        {column.field}
        {column.optional ? (
          <span className="ml-1 font-normal normal-case tracking-normal text-ink-400">(optional)</span>
        ) : (
          <span className="ml-1 text-tone-danger" title="Required">
            <span aria-hidden>*</span>
            <span className="sr-only">(required)</span>
          </span>
        )}
      </label>
      <SelectInput
        id={id}
        required={!column.optional}
        value={column.value}
        onChange={(e) => column.onChange(e.target.value)}
        aria-label={`Which CSV column holds the ${column.field.toLowerCase()}?`}
        aria-invalid={error ? true : undefined}
        className={`mt-1.5 ${error ? "border-edge-danger" : ""}`}
      >
        {/* An optional field has to be un-choosable again, or a stray guess
            could never be undone. The required ones keep a disabled prompt. */}
        <option value="" disabled={!column.optional}>
          {column.optional ? "Don't import this" : "Select a column"}
        </option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </SelectInput>
      {error ? (
        <p role="alert" className="mt-1.5 flex items-start gap-1 text-[11px] font-normal normal-case tracking-normal text-tone-danger">
          <span aria-hidden>⚠</span>
          <span className="min-w-0">{error}</span>
        </p>
      ) : column.auto ? (
        // Shortened to two words. At four columns the full sentence was a
        // useful nudge; at five it is the same forty characters repeated five
        // times across the widest element on the page, which reads as noise
        // and pushes the data further down. The title carries the long form.
        <p
          className="mt-1.5 text-[11px] font-normal normal-case tracking-normal text-ink-400"
          title="FinSight matched this column automatically — change it if that's wrong."
        >
          ✦ Auto-matched
        </p>
      ) : (
        // Holds the row height steady so the header doesn't jump as hints
        // appear and disappear while the owner works through the columns.
        <p aria-hidden className="mt-1.5 text-[11px] text-transparent">
          &nbsp;
        </p>
      )}
    </th>
  );
}

/**
 * One preview cell.
 *
 * An unmapped column shows a placeholder rather than blanking the whole table:
 * the previous version hid the preview entirely until all four selects were
 * filled, which meant the data an owner needed in order to CHOOSE a mapping
 * only appeared once they had finished choosing it.
 */
function CellValue({
  value,
  column,
  isProblem,
}: {
  value: string;
  column: MappedColumn;
  isProblem?: boolean;
}) {
  if (column.value === "") {
    return <span className="text-ink-400">—</span>;
  }

  if (column.field === "Amount") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) && value.trim() !== "" ? (
      <Money value={parsed} />
    ) : (
      <span className="text-tone-danger">{value || "—"}</span>
    );
  }

  if (isProblem) {
    return <span className="text-tone-danger">{value || "—"}</span>;
  }
  return <>{value || <span className="text-ink-400">—</span>}</>;
}
