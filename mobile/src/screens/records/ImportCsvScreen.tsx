import { useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Alert as AlertBanner, Button, Callout, Card, ConfirmSheet, ErrorNote, Field, OptionSheet, Screen, SelectChip, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import {
  EMPTY_MAPPING,
  analyseRows,
  checkMapping,
  columnMappingPayload,
  correctionsPayload,
  defaultImportTitle,
  guessMapping,
  importProgress,
  newCategoryNames,
  newIdempotencyKey,
  offeredFields,
  problemsFirst,
  requiredFields,
  reviewCounts,
  type AnalysedRow,
  type ColumnMapping,
  type CorrectableField,
  type Corrections,
  type ImportRecordType,
  type MappedField,
  type MixedStrategy,
  type RowRules,
} from "../../lib/csvImport";
import { DATE_FORMAT_LABELS, type ChosenDateFormat, type CsvDateFormat } from "../../lib/csvDates";
import { SkeletonList } from "../../components/Skeleton";
import { TAP, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { ImportSteps } from "./importCsv/ImportSteps";
import { ReviewRowCard } from "./importCsv/ReviewRowCard";
import { FIELD_LABELS, IMPORT_POLL_INTERVAL_MS, IMPORT_POLL_TIMEOUT_MS, IMPORT_STAGE_WORDS } from "./importCsv/constants";

/**
 * Importing a spreadsheet, in the three steps the website has always had:
 * choose a file, map the columns, review the rows.
 *
 * WHAT WAS MISSING BEFORE, and why each absence mattered on a phone
 * specifically — this is the client most FinSight owners actually have:
 *
 *   - NO ROW REVIEW AT ALL. The app posted a mapping and found out afterwards
 *     which rows had been thrown away, listed as "Row 47: Invalid date" with
 *     no way to fix one except editing the file on a computer the owner may
 *     not own.
 *   - NO CORRECTIONS. The server has accepted a `corrections` patch since the
 *     web review panel was built. Mobile never sent one.
 *   - NO VENDOR COLUMN. A supplier column in the file was silently dropped.
 *   - NO EDITABLE TITLE. `file.name` was posted raw, so a long export name —
 *     the kind a bank app or a phone's Downloads folder produces — failed the
 *     whole import with a 400 naming a field the screen never showed.
 *   - NO IDEMPOTENCY KEY. A retried confirm imported the file twice.
 *
 * The rules behind the review step are in lib/csvImport.ts, mirrored from the
 * server's own `validateRows`, and unit-tested there — this file is the
 * interface over them. The step components and constants it shares with
 * nothing else live in ./importCsv/.
 */
export function ImportCsvScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, ink, paper, statusText, status } = t;
  const { selected, categories } = useBusinessProfiles();
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
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  const [autoMapped, setAutoMapped] = useState<MappedField[]>([]);
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
  const [dateFormat, setDateFormat] = useState<ChosenDateFormat | null>(null);
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  const [corrections, setCorrections] = useState<Corrections>({});
  const [step, setStep] = useState<"map" | "review">("map");
  const [result, setResult] = useState<any | null>(null);
  /** The polled status of a large import the server took off the request. */
  const [batchStatus, setBatchStatus] = useState<any | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateRules: RowRules = useMemo(
    () => ({
      recordType,
      mixedStrategy,
      // The owner's answer wins; otherwise the file speaks for itself.
      dateFormat: dateFormat ?? detectedFormat,
    }),
    [recordType, mixedStrategy, dateFormat, detectedFormat],
  );

  const analysed = useMemo(
    () => analyseRows(previewRows, mapping, corrections, dateRules),
    [previewRows, mapping, corrections, dateRules],
  );
  /**
   * The order the review list is shown in, FROZEN when the step opens.
   *
   * Problem rows come first — a phone shows about two cards at a time, and
   * leaving the four that need fixing scattered through three hundred that do
   * not is the same as hiding them. But the order must then STOP moving: if it
   * were recomputed as the owner typed, the row being corrected would jump to
   * the bottom of the list the moment it became valid, taking the keyboard and
   * their place on screen with it.
   */
  const [reviewOrder, setReviewOrder] = useState<number[]>([]);
  const reviewRows = useMemo(() => {
    const byRow = new Map(analysed.map((r) => [r.rowNumber, r]));
    const ordered = reviewOrder.map((n) => byRow.get(n)).filter((r): r is AnalysedRow => r !== undefined);
    // Anything the frozen order does not know about (a mapping changed after
    // the freeze) is appended rather than dropped.
    return ordered.length === analysed.length ? ordered : problemsFirst(analysed);
  }, [analysed, reviewOrder]);
  const counts = reviewCounts(analysed, corrections);
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

  if (!selected) return null;

  function formFor(f: DocumentPicker.DocumentPickerAsset) {
    const form = new FormData();
    form.append("file", { uri: f.uri, name: f.name, type: "text/csv" } as any);
    return form;
  }

  function reset() {
    setFile(null);
    setIdempotencyKey(null);
    setHeaders([]);
    setPreviewRows([]);
    setTotalRows(0);
    setMapping(EMPTY_MAPPING);
    setAutoMapped([]);
    setRecordType("expense");
    setMixedStrategy("column");
    setTitle("");
    setDetectedFormat("iso");
    setDateAmbiguous(false);
    setDateFormat(null);
    setCorrections({});
    setReviewOrder([]);
    setStep("map");
    setResult(null);
    setBatchStatus(null);
    setError(null);
  }

  async function pick() {
    const res = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "*/*"] });
    if (res.canceled || !res.assets?.[0]) return;
    const f = res.assets[0];
    reset();
    setFile(f);
    // Minted with the file, not with the request — see the state declaration.
    setIdempotencyKey(newIdempotencyKey());
    setTitle(defaultImportTitle(f.name));
    setBusy(true);
    try {
      const preview = await api.upload<{
        headers: string[];
        previewRows: Record<string, string>[];
        totalRows: number;
        detectedTypeColumn?: string | null;
        columnsWithNegatives?: string[];
        detectedDateFormat?: CsvDateFormat;
        dateFormatAmbiguous?: boolean;
      }>("/records/csv-imports/preview", formFor(f));

      setHeaders(preview.headers);
      setPreviewRows(preview.previewRows ?? []);
      setTotalRows(preview.totalRows ?? 0);
      setDetectedFormat(preview.detectedDateFormat ?? "iso");
      setDateAmbiguous(preview.dateFormatAmbiguous === true);

      const guess = guessMapping(preview.headers, {
        detectedTypeColumn: preview.detectedTypeColumn,
        columnsWithNegatives: preview.columnsWithNegatives,
      });
      // Offered, not applied silently: the owner still sees every choice, and
      // the review step labels each row before anything is written.
      setMapping(guess.mapping);
      setAutoMapped(guess.autoMapped);
      setRecordType(guess.recordType);
      setMixedStrategy(guess.mixedStrategy);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Follows a large import the server took off the request.
   *
   * The counts are the SERVER's — processedRows out of totalRows — so the bar
   * moves because rows were committed, not because time passed. ADR-4's rule:
   * never fake determinate progress.
   */
  async function pollBatch(batchId: number) {
    const deadline = Date.now() + IMPORT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_INTERVAL_MS));
      const status = await api.get<any>(`/records/csv-imports/batches/${batchId}/status`);
      setBatchStatus(status);
      if (status.processingStatus === "COMPLETE") {
        const summary = status.resultSummary ?? {};
        setResult({
          batchId,
          title,
          totalRows: status.totalRows,
          imported: status.importedRows,
          skipped: summary.skipped ?? [],
          skippedCount: status.skippedRows,
          flagged: status.flaggedRows,
          largeExpenseFlagged: summary.largeExpenseFlagged ?? 0,
          importedExpenses: summary.importedExpenses ?? 0,
          importedSales: summary.importedSales ?? 0,
          uncategorised: summary.uncategorised ?? 0,
        });
        return;
      }
      if (status.processingStatus === "FAILED") {
        throw new Error(
          status.failureStage
            ? `The import stopped while it was ${IMPORT_STAGE_WORDS[status.failureStage] ?? status.failureStage}. Nothing was half-saved — try importing the same file again.`
            : "The import could not be finished. Try importing the same file again.",
        );
      }
    }
    throw new Error(
      "This import is taking longer than expected. It is still running on FinSight's side — check your records in a few minutes before trying again.",
    );
  }

  async function confirm() {
    if (!file || !idempotencyKey) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    try {
      const form = formFor(file);
      form.append("businessProfileId", String(selected!.id));
      form.append("recordType", recordType);
      if (recordType === "mixed") form.append("mixedStrategy", mixedStrategy);
      form.append("title", title.trim());
      form.append("columnMapping", JSON.stringify(columnMappingPayload(mapping, recordType, mixedStrategy)));
      const patch = correctionsPayload(corrections);
      if (Object.keys(patch).length > 0) form.append("corrections", JSON.stringify(patch));
      // The same key on every attempt: the server returns the SAME logical
      // import for a replay rather than a second copy of the records.
      form.append("idempotencyKey", idempotencyKey);
      // Sent only when the file cannot say for itself — otherwise confirm
      // refuses the file, which is the server asking this exact question.
      if (dateAmbiguous && dateFormat) form.append("dateFormat", dateFormat);

      const confirmed = await api.upload<any>("/records/csv-imports/confirm", form);
      if (confirmed.processingStatus === "PENDING" || confirmed.processingStatus === "PROCESSING") {
        // 202: the batch exists and the worker has it, but no records are
        // written yet. Nothing here is final until the poll says so.
        setBatchStatus({ ...confirmed, processedRows: 0 });
        await pollBatch(confirmed.batchId);
      } else {
        setResult({ ...confirmed, skippedCount: confirmed.skipped?.length ?? 0 });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function correct(rowNumber: number, field: CorrectableField, value: string) {
    setCorrections((prev) => ({ ...prev, [rowNumber]: { ...prev[rowNumber], [field]: value } }));
  }

  // ---- What is on screen right now -------------------------------------

  if (result) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
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
                  Every row in it matches an import you already have. Nothing was blocked — but if this was
                  an accident, the new rows are the ones to delete.
                </AlertBanner>
              ) : null}
              {result.uncategorised > 0 ? (
                <Callout tone="info">
                  {result.uncategorised} expense(s) had no category and went into "Uncategorised". They're
                  imported and counted — sorting them is what makes them show up in your spending breakdown.
                </Callout>
              ) : null}
              {result.skippedCount > 0 ? (
                <AlertBanner kind="needs-review" label={`${result.skippedCount} row(s) were skipped`}>
                  {(result.skipped ?? []).slice(0, 20).map((s: any) => `Row ${s.row}: ${s.reason}`).join("\n") ||
                    "Open the import in your records to see which rows they were."}
                </AlertBanner>
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
                  onPress={() => navigation.navigate("FlaggedRecords")}
                />
              ) : null}
              <Button title="Done" variant="primary" onPress={() => navigation.goBack()} />
            </View>
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  /*
   * A large file, still being written. The figures are the server's own row
   * counts — an honest bar or none at all.
   */
  if (batchStatus && !result) {
    const progress = importProgress(batchStatus);
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>Importing your records</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              This file is large enough that FinSight is importing it in the background. You can leave this
              screen — the import carries on without you.
            </T>
            {progress ? (
              <>
                <View
                  accessibilityRole="progressbar"
                  accessibilityValue={{ min: 0, max: progress.total, now: progress.done }}
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
                  {progress.done} of {progress.total} rows checked and saved.
                </T>
              </>
            ) : (
              <T variant="caption">FinSight is reading the file. It will start counting rows in a moment.</T>
            )}
            {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
            {error ? (
              <Button
                title="Try again"
                variant="secondary"
                onPress={() => {
                  setBatchStatus(null);
                  setError(null);
                }}
                style={{ marginTop: space.md }}
              />
            ) : null}
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  if (!file) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>Import a spreadsheet</T>
            <T variant="caption" style={{ marginBottom: space.lg }}>
              Bring in sales and expenses from a CSV you already keep — one file can hold both. You'll map
              the columns and check the rows before anything is saved.
            </T>
            <ImportSteps current={0} />
            {error ? <View style={{ marginBottom: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
            <Button title="Choose a CSV file" variant="primary" onPress={pick} />
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  if (busy && headers.length === 0) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <ImportSteps current={0} />
            <T variant="caption" style={{ marginBottom: space.md }}>Reading {file.name}…</T>
            <SkeletonList count={4} />
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  if (step === "review") {
    return (
      <Screen>
        <FlatList
          /*
           * VIRTUALIZED, unlike the mapping list above it. A preview is up to
           * fifty rows and each card here carries up to four text inputs — a
           * ScrollView would mount every one of them, and the inputs are the
           * expensive part. This is also the screen an owner scrolls hardest.
           */
          data={reviewRows}
          keyExtractor={(row) => String(row.rowNumber)}
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.sm }}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={{ gap: space.sm, marginBottom: space.sm }}>
              <Card>
                <ImportSteps current={2} />
                <T variant="title" style={{ marginBottom: 4 }}>Check your rows</T>
                <T variant="caption">
                  {counts.problems === 0
                    ? `All ${counts.total} rows read cleanly.`
                    : `${counts.problems} of ${counts.total} rows can't be imported as they are. They're first in the list — fix them here and FinSight will import them.`}
                  {previewRows.length < totalRows
                    ? ` This is the first ${previewRows.length} of ${totalRows} rows; the rest are checked when you import.`
                    : ""}
                </T>
                {counts.corrected > 0 ? (
                  <T variant="caption" style={{ marginTop: space.sm, color: brand[700] }}>
                    {counts.corrected} row{counts.corrected === 1 ? "" : "s"} corrected. Your fixes are sent
                    with the file — the original stays as it is.
                  </T>
                ) : null}
              </Card>

              {typeSplit ? (
                <Callout tone={typeSplit.unknown > 0 ? "warn" : "info"}>
                  In these rows: {typeSplit.sales} sales · {typeSplit.expenses} expenses
                  {typeSplit.unknown > 0
                    ? ` · ${typeSplit.unknown} unrecognised. Rows FinSight can't read a type from are skipped, never guessed.`
                    : "."}
                </Callout>
              ) : null}

              {newCategories.length > 0 ? (
                <Callout tone="info">
                  This import will create {newCategories.length} new categor
                  {newCategories.length === 1 ? "y" : "ies"}: {newCategories.join(", ")}.
                  {previewRows.length < totalRows
                    ? ` That is from the ${previewRows.length} rows checked — later rows may add more.`
                    : ""}{" "}
                  If one is a misspelling of a category you already have, fix it here or change the Category
                  column, or you'll end up with two categories for the same thing.
                </Callout>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <ReviewRowCard
              row={item}
              onCorrect={(field, value) => correct(item.rowNumber, field, value)}
              corrected={corrections[item.rowNumber] ?? {}}
            />
          )}
          ListFooterComponent={
            <View style={{ marginTop: space.md, gap: space.sm }}>
              {error ? <ErrorNote>{error}</ErrorNote> : null}
              <Button
                title={counts.problems > 0 ? `Import the other ${counts.total - counts.problems} rows` : "Import these rows"}
                variant="primary"
                onPress={() => setConfirmOpen(true)}
                loading={busy}
              />
              <Button title="Back to the columns" variant="ghost" onPress={() => setStep("map")} />
            </View>
          }
        />
        <ConfirmSheet
          visible={confirmOpen}
          title="Import this file?"
          body={
            `${totalRows} row${totalRows === 1 ? "" : "s"} will be checked and added to your records as "${title.trim()}".` +
            (counts.problems > 0
              ? ` The ${counts.problems} row${counts.problems === 1 ? "" : "s"} still marked below will be skipped and listed afterwards.`
              : "") +
            (newCategories.length > 0 ? ` ${newCategories.length} new categor${newCategories.length === 1 ? "y" : "ies"} will be created.` : "")
          }
          confirmLabel="Import"
          onConfirm={confirm}
          onCancel={() => setConfirmOpen(false)}
        />
      </Screen>
    );
  }

  // ---- Step 2: map the columns -----------------------------------------

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
          keyboardShouldPersistTaps="handled"
        >
          <Card>
            <ImportSteps current={1} />
            <T variant="label" style={{ marginBottom: 4 }}>{file.name}</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              Match your columns to FinSight's fields. Every field says what it will be filled from.
            </T>

            {/*
              A file with a header row and nothing under it. Caught here rather
              than at confirm: uploading it, storing it and creating a batch
              row for it just to report "0 imported" is work nobody needed and
              an empty import in the owner's records afterwards.
            */}
            {totalRows === 0 ? (
              <View style={{ marginBottom: space.md }}>
                <Callout tone="warn">
                  This file has column headings but no rows under them. There is nothing to import — check
                  you picked the right file.
                </Callout>
              </View>
            ) : null}

            <Field
              label="What to call this import"
              value={title}
              onChangeText={setTitle}
              maxLength={FIELD_LIMITS.importTitle}
            />
            <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
              So you can find it again in your records. Starts from the file's name, shortened to fit.
            </T>

            <T variant="label" style={{ marginBottom: 4 }}>Import as</T>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
              {(
                [
                  ["expense", "Expenses"],
                  ["sales", "Sales"],
                  ["mixed", "Both in one file"],
                ] as const
              ).map(([value, label]) => (
                <SelectChip
                  key={value}
                  label={label}
                  selected={recordType === value}
                  onPress={() => setRecordType(value)}
                />
              ))}
            </View>

            {/*
              Asked as a question about the FILE, not about FinSight: an owner
              knows whether their sheet has a "type" column or writes expenses
              with a minus sign; they do not know what a "strategy" is.
            */}
            {recordType === "mixed" ? (
              <>
                <T variant="label" style={{ marginBottom: 4 }}>How does your file say which is which?</T>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
                  <SelectChip
                    label={'A column says "sale" or "expense"'}
                    selected={mixedStrategy === "column"}
                    onPress={() => setMixedStrategy("column")}
                  />
                  <SelectChip
                    label="Expenses are negative (−)"
                    selected={mixedStrategy === "sign"}
                    onPress={() => setMixedStrategy("sign")}
                  />
                </View>
              </>
            ) : null}

            {/*
              THE ONE QUESTION ONLY THE OWNER CAN ANSWER. When every sampled
              date fits both readings, "05/01/2026" is either 5 January or
              1 May, and no amount of parsing settles it. The server refuses
              the file until it is told, which is the right refusal — a month
              of records filed into the wrong months is not recoverable by
              looking at them.
            */}
            {dateAmbiguous ? (
              <View style={{ marginBottom: space.md, gap: space.sm }}>
                <Callout tone="warn">
                  The dates in this file can be read two ways — 05/01/2026 is either 5 January or 1 May.
                  FinSight will not guess. Tell it which your file uses.
                </Callout>
                <Pressable
                  onPress={() => setDateSheetOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Choose how the dates in this file should be read"
                  style={{
                    minHeight: TAP,
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: dateFormat ? brand[600] : statusText.warning,
                    borderRadius: radius.md,
                    paddingHorizontal: space.md,
                  }}
                >
                  <T style={{ fontSize: typeScale.bodySm, color: dateFormat ? ink[900] : statusText.warning }}>
                    {dateFormat ? DATE_FORMAT_LABELS[dateFormat] : "Choose how to read these dates"}
                  </T>
                </Pressable>
              </View>
            ) : null}

            {offeredFields(recordType, mixedStrategy).map((field) => (
              <View key={field} style={{ marginBottom: space.md }}>
                <T variant="label" style={{ marginBottom: 4 }}>
                  {FIELD_LABELS[field]}
                  {requiredFields(recordType, mixedStrategy).includes(field) ? "" : " (optional)"}
                </T>
                {autoMapped.includes(field) && mapping[field] ? (
                  <T variant="caption" style={{ marginBottom: 4 }}>
                    Matched automatically — change it if that's the wrong column.
                  </T>
                ) : null}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  {headers.map((h) => (
                    <SelectChip
                      key={h}
                      label={h}
                      selected={mapping[field] === h}
                      onPress={() => {
                        // Tapping the chosen column again clears it, which is
                        // the only way to UNMAP an optional field.
                        setMapping((m) => ({ ...m, [field]: m[field] === h ? "" : h }));
                        setAutoMapped((prev) => prev.filter((f) => f !== field));
                      }}
                      // Every column name appears once per field, so the chip
                      // has to say which field it would fill — otherwise four
                      // identical "Amount" chips read out identically.
                      accessibilityLabel={`${h}, for ${FIELD_LABELS[field]}`}
                    />
                  ))}
                </View>
                {mapping[field] && mappingCheck.duplicated.includes(mapping[field]) ? (
                  <T variant="caption" style={{ marginTop: 4, color: statusText.critical }}>
                    "{mapping[field]}" is already filling another field. Each one needs its own column.
                  </T>
                ) : null}
              </View>
            ))}

            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button
              title="Check the rows"
              variant="primary"
              onPress={() => {
                setReviewOrder(problemsFirst(analysed).map((r) => r.rowNumber));
                setStep("review");
              }}
              disabled={!mappingCheck.ready || needsDateAnswer || title.trim().length === 0 || totalRows === 0}
              style={{ marginTop: space.sm }}
            />
            {!mappingCheck.ready || needsDateAnswer ? (
              <T variant="caption" style={{ marginTop: space.sm }}>
                {needsDateAnswer
                  ? "Choose how the dates should be read first."
                  : mappingCheck.duplicated.length > 0
                    ? "Two fields are pointing at the same column."
                    : `Still to map: ${mappingCheck.missing.map((f) => FIELD_LABELS[f]).join(", ")}.`}
              </T>
            ) : null}
            <Button title="Choose a different file" variant="ghost" onPress={reset} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>

      <OptionSheet
        visible={dateSheetOpen}
        title="How should these dates be read?"
        options={(["dmy", "mdy", "iso"] as const).map((id) => ({ id, name: DATE_FORMAT_LABELS[id] }))}
        value={dateFormat}
        onChoose={(id) => setDateFormat(id as ChosenDateFormat)}
        onClose={() => setDateSheetOpen(false)}
        emptyText="No date formats available."
      />
    </Screen>
  );
}
