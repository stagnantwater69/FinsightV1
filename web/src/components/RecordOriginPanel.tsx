import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Download, FileSpreadsheet, ReceiptText, type LucideIcon } from "lucide-react";
import { Money } from "./Money";
import { SkeletonRows } from "./Skeleton";
import { formatCalendarDate } from "../lib/dates";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { CsvBatchPreview, RecordOrigin } from "../lib/types";
import { useHorizontalTabKeys } from "../lib/hooks";

/**
 * Where a saved record came from.
 *
 * WHY THIS EXISTS: a record created by a receipt scan is a SUMMARY. "Inventory
 * — PHP 1,850" was really buns, patties and a tray of eggs, read off a photo,
 * filed alongside an Equipment record from the same receipt. Opening it to
 * edit and seeing only the summary left the owner with no way to check the
 * figure against reality, no reminder of what the purchase actually was, and
 * no clue that half the receipt was sitting in another record entirely.
 *
 * Everything here is read-only on purpose. Editing an item would mean
 * recomputing the split across sibling records — a much larger change, and one
 * with its own reconciliation problem. This panel answers "what is this?", and
 * the form below it still answers "what should it be?".
 */
export function RecordOriginPanel({
  origin,
  recordAmount,
  expenseId,
  otherExpenseId,
}: {
  origin: RecordOrigin;
  recordAmount: number;
  /** The record being edited, so the File rows tab can find and mark its row. */
  expenseId?: number;
  /** The record it may duplicate, from the same file: marked too, and the File rows tab opened. */
  otherExpenseId?: number;
}) {
  /*
   * Split into a component per origin kind rather than branching inside one.
   * The receipt panel needs state of its own for the tab strip, and a hook
   * cannot live below the early return the CSV branch used to make — this is
   * the rules-of-hooks fix, not a stylistic one.
   */
  if (origin.kind === "csv_import") return <CsvOrigin origin={origin} expenseId={expenseId} otherExpenseId={otherExpenseId} />;
  return <ReceiptOrigin origin={origin} recordAmount={recordAmount} />;
}

/**
 * One view at a time, rather than everything stacked.
 *
 * WHY TABS. The panel used to render the item breakdown AND the photograph one
 * after the other, so a tall receipt pushed a page that is otherwise two
 * columns into thousands of pixels of scroll — and the photo, being the taller
 * of the two by far, buried the table the owner actually needed to check. The
 * two are alternative answers to the same question ("what does the source
 * say?"), not a sequence, so only one needs to be on screen.
 */
function TabStrip({
  tabs,
  active,
  onSelect,
  panelId,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
  panelId: string;
}) {
  const onTabKeys = useHorizontalTabKeys();

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      onKeyDown={onTabKeys}
      className="mt-3 flex gap-1 border-b border-paper-200"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${panelId}-${tab.id}-tab`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={`tap-inline -mb-px border-b-2 px-3 py-2 text-xs font-medium transition ${
              selected
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-ink-500 hover:text-ink-800"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// Fills the form column's height beside it (see FormPage) and scrolls inside.
const SURFACE = "rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm xl:flex xl:h-full xl:flex-col";

function SourceHeading({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{children}</p>
      </div>
    </div>
  );
}

/** "COMPLETE" reads as a database value; owners read "Complete". */
const statusLabel = (status: string) => status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function CsvOrigin({
  origin,
  expenseId,
  otherExpenseId,
}: {
  origin: Extract<RecordOrigin, { kind: "csv_import" }>;
  expenseId?: number;
  otherExpenseId?: number;
}) {
  // Same two-view split as the receipt panel, so a source panel behaves the
  // same way whichever kind of source it is describing.
  const [tab, setTab] = useState<"details" | "file">("details");
  const panelId = useId();
  // Asking to see the other record means seeing where it sits in the file.
  useEffect(() => {
    if (otherExpenseId !== undefined) setTab("file");
  }, [otherExpenseId]);

  return (
    <section className={SURFACE}>
      {/* A spreadsheet row IS the record, with no line items behind it, so the
          useful provenance is the batch: which file, and what came with it. */}
      <SourceHeading icon={FileSpreadsheet} title="From a CSV import">
        This record was one row in an imported file. A row has no item breakdown, so the form shows the whole record.
      </SourceHeading>

      <TabStrip
        tabs={[
          { id: "details", label: "Import details" },
          { id: "file", label: `File rows (${origin.rowCount})` },
        ]}
        active={tab}
        onSelect={(id) => setTab(id as "details" | "file")}
        panelId={panelId}
      />

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-${tab}-tab`}
        tabIndex={0}
        className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
      >
        {tab === "file" ? (
          <CsvFilePreview batchId={origin.batchId} expenseId={expenseId} otherExpenseId={otherExpenseId} />
        ) : (
          <dl className="mt-4 grid gap-2.5 text-xs sm:grid-cols-3">
        <Detail label="Import" value={origin.title} wide />
        <Detail label="Uploaded" value={dateLabel(origin.uploadDate)} />
        <Detail label="Status" value={statusLabel(origin.status)} />
        <Detail
          label="Rows in this import"
          value={`${origin.rowCount} record${origin.rowCount === 1 ? "" : "s"}`}
        />
        <div className="rounded-xl bg-paper-50 px-3 py-2.5 ring-1 ring-paper-200 sm:col-span-3">
          <dt className="text-ink-500">File</dt>
          {/*
            The stored path was shown here before, which told the owner
            nothing they could act on — "4/9f2e1c40-...-expenses.csv" is an
            internal detail, not an answer to "what did I upload?". The
            file's own name, and a way to open it, is what makes this row
            worth its space.

            Download is separate from the File rows tab: this leaves the
            app for the owner's own spreadsheet program, which is the right
            place to actually work with the file rather than just check it.
          */}
          <dd className="mt-0.5 break-all text-ink-800">
            {origin.fileUrl ? (
              <a
                href={origin.fileUrl}
                className="tap-inline inline-flex items-center gap-1.5 font-medium link-action"
              >
                <Download aria-hidden className="h-3.5 w-3.5" />
                Download the file this was imported from
              </a>
            ) : (
              /*
               * The link expires, and sourceCleanup deletes the file when its
               * batch goes. Saying the file is unavailable is honest; a dead
               * link that downloads an XML error page is not.
               */
              <span className="text-ink-500">No longer available</span>
            )}
          </dd>
        </div>
          </dl>
        )}
      </div>
    </section>
  );
}

function ReceiptOrigin({
  origin,
  recordAmount,
}: {
  origin: Extract<RecordOrigin, { kind: "receipt_scan" }>;
  recordAmount: number;
}) {
  /*
   * Items first, not the photo. The breakdown is the thing that explains the
   * record's own figure; the photograph is what you reach for when the
   * breakdown looks wrong.
   */
  const [tab, setTab] = useState<"items" | "photo">("items");
  const panelId = useId();

  const chargesCentavos =
    Math.round(recordAmount * 100) - Math.round(origin.itemsSubtotal * 100);

  // The whole receipt in line order, with this record's lines marked, like the record's row in a CSV.
  const otherLines = origin.otherLines ?? [];
  const lines = [
    ...origin.items.map((item) => ({ ...item, key: `item-${item.id}`, mine: true })),
    ...otherLines.map((line) => ({ ...line, key: `line-${line.lineNumber}`, mine: false, addedByOwner: false })),
  ].sort((a, b) => a.lineNumber - b.lineNumber);

  return (
    <section className={SURFACE}>
      <SourceHeading icon={ReceiptText} title="From a scanned receipt">
        Scanned {dateLabel(origin.scannedAt)}
        {origin.extractedVendor ? ` · ${origin.extractedVendor}` : ""}
      </SourceHeading>

      {/* The photo tab is offered only when there is a photo to show — a
          signed URL that could not be minted leaves the panel with one view,
          and a lone tab pretending to be a choice is worse than no strip. */}
      {origin.imageUrl ? (
        <TabStrip
          tabs={[
            { id: "items", label: origin.items.length > 0 ? `Items (${origin.items.length})` : "Details" },
            { id: "photo", label: "Receipt photo" },
          ]}
          active={tab}
          onSelect={(id) => setTab(id as "items" | "photo")}
          panelId={panelId}
        />
      ) : null}

      <div
        id={panelId}
        role={origin.imageUrl ? "tabpanel" : undefined}
        aria-labelledby={origin.imageUrl ? `${panelId}-${tab}-tab` : undefined}
        tabIndex={origin.imageUrl ? 0 : undefined}
        className="scroll-slim xl:min-h-0 xl:flex-1 xl:overflow-y-auto"
      >
        {tab === "photo" && origin.imageUrl ? (
          <ReceiptImage url={origin.imageUrl} />
        ) : (
          <>
      {origin.items.length > 0 ? (
        <>
          <p className="mt-2 text-xs leading-relaxed text-ink-600">
            {otherLines.length > 0
              ? `This receipt has ${lines.length} lines. The ${origin.items.length} highlighted make up this record.`
              : `All ${lines.length} line${lines.length === 1 ? "" : "s"} on this receipt make up this record.`}
          </p>

          <div className="mt-2.5 overflow-x-auto rounded-xl border border-paper-200 bg-paper">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <caption className="sr-only">The receipt's items; the highlighted ones make up this record</caption>
              <thead>
                <tr className="border-b border-paper-200 bg-paper-100">
                  <Th>Item</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Unit</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((item) => (
                  <tr
                    key={item.key}
                    aria-current={item.mine ? "true" : undefined}
                    className={`border-t border-paper-200 ${item.mine ? "bg-tint-brand text-ink-900" : "text-ink-600"}`}
                  >
                    <td className="px-3 py-2">
                      {item.name}
                      {item.mine ? null : (
                        <span className="sr-only">{"recordId" in item && item.recordId ? " (in another record)" : " (not in any record)"}</span>
                      )}
                      {/*
                        A line the owner typed in is not something FinSight
                        read off the receipt, and this panel must not let the
                        heading above imply otherwise.
                      */}
                      {item.addedByOwner ? (
                        <span className="ml-1.5 rounded-full bg-paper-200 px-1.5 py-0.5 text-xs font-medium text-ink-600">
                          you added
                        </span>
                      ) : null}
                      {/* The per-line "AI read from photo" tag is hidden here as on the scan
                          screen (SHOW_AI_PHOTO_EXTRACTION_LABEL); extractedByVision is still stored. */}
                    </td>
                    <td className="figure px-3 py-2 text-right">{item.quantity ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {item.unitPrice === null ? "—" : <Money value={item.unitPrice} decimals bare />}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money value={item.amount} decimals bare />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-paper-200 bg-paper-100">
                  <td colSpan={3} className="px-3 py-2 text-xs font-medium text-ink-600">
                    {otherLines.length > 0 ? "Highlighted items subtotal" : "Items subtotal"}
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-medium text-ink-900">
                    <Money value={origin.itemsSubtotal} decimals bare />
                  </td>
                </tr>
                {/*
                  The arithmetic, shown rather than hidden.

                  A receipt's items routinely do not sum to what was paid — a
                  VAT-exclusive register adds tax on top, a discount takes some
                  off. That share is part of this record's amount, and showing
                  the record's total without it would make the items look like
                  they simply don't add up.
                */}
                {chargesCentavos !== 0 ? (
                  <tr className="bg-paper-100">
                    <td colSpan={3} className="px-3 py-2 text-xs font-medium text-ink-600">
                      {chargesCentavos > 0 ? "Share of tax and charges" : "Share of discount"}
                    </td>
                    <td className="px-3 py-2 text-right text-sm text-ink-700">
                      <Money value={chargesCentavos / 100} decimals bare signed />
                    </td>
                  </tr>
                ) : null}
                <tr className="border-t border-paper-200 bg-paper-100">
                  <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-ink-700">
                    This record
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-semibold text-ink-900">
                    <Money value={recordAmount} decimals bare />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          FinSight couldn't read individual items off this receipt, so it was saved as a single total.
        </p>
      )}

      {/*
        The other half of the receipt.

        Without this, an owner looking at the Inventory record from a
        mixed receipt has no way to tell that the equipment they remember
        buying is filed separately rather than missing entirely.
      */}
      {origin.siblings.length > 0 ? (
        <div className="mt-3 rounded-xl bg-paper-100 p-3">
          <p className="text-xs font-semibold text-ink-600">
            This receipt was also split into {origin.siblings.length} other record
            {origin.siblings.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1.5 space-y-1">
            {origin.siblings.map((sibling) => (
              <li key={sibling.id} className="flex items-baseline justify-between gap-3 text-sm">
                <a
                  href={`/records/expenses/${sibling.id}/edit`}
                  className="min-w-0 truncate py-3 link-action"
                >
                  {sibling.categoryName}
                  <span className="ml-1.5 text-xs text-ink-600">{sibling.description}</span>
                </a>
                <span className="shrink-0 text-ink-800">
                  <Money value={sibling.amount} decimals />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The receipt photo, bounded.
 *
 * THE BUG THIS FIXES: this was `w-full` with no height limit, so the image
 * rendered at whatever height its aspect ratio demanded once stretched to the
 * column — a portrait photo of a till receipt is very tall and very narrow, so
 * "fill the width" meant thousands of pixels of scroll for a picture that only
 * needed a few hundred.
 *
 * So the constraint is on HEIGHT, and the width follows. `w-auto` with
 * `mx-auto` keeps a narrow receipt its natural width and centred, instead of
 * blown up to fill a column it was never shaped for.
 *
 * Full size stays one click away, in a new tab where the browser's own zoom
 * and pan are better than anything reimplemented here.
 */
function ReceiptImage({ url }: { url: string }) {
  return (
    <div className="mt-3">
      <div className="flex justify-center rounded-xl border border-paper-200 bg-paper p-2">
        <img
          src={url}
          alt="The scanned receipt this record came from"
          className="max-h-[32rem] w-auto max-w-full rounded-lg object-contain"
        />
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="tap-inline mt-2 inline-block text-xs link-action"
      >
        Open the full-size photo
      </a>
    </div>
  );
}

/**
 * The imported file, re-rendered as a table rather than left as a download.
 *
 * Mounted only when the File rows tab is selected, which is what keeps the
 * download-and-parse this costs (previewImportBatch pulls the whole file back
 * out of storage) off the records nobody ever asks to inspect. The tab itself
 * is now the "do I want this?" control, so the collapse toggle this used to
 * carry would be a second lock on the same door.
 */
function CsvFilePreview({ batchId, expenseId, otherExpenseId }: { batchId: number; expenseId?: number; otherExpenseId?: number }) {
  const [preview, setPreview] = useState<CsvBatchPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<CsvBatchPreview>(
        `/records/csv-imports/batches/${batchId}/preview`,
        expenseId ? { params: { expenseId, ...(otherExpenseId ? { otherExpenseId } : {}) } } : undefined,
      )
      .then(({ data }) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, expenseId, otherExpenseId]);

  // Bring the record's row to the middle of the scroll box, without moving the page.
  const scroller = useRef<HTMLDivElement>(null);
  const firstRow = preview?.firstRowNumber ?? 1;
  const matched = new Set(preview?.matchedRowNumbers ?? []);
  const others = new Set(preview?.otherRowNumbers ?? []);
  const firstMatch = preview?.matchedRowNumbers?.[0];
  useEffect(() => {
    const box = scroller.current;
    const row = box?.querySelector<HTMLElement>("[data-this-record]");
    if (box && row) box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2;
  }, [preview]);

  // A column whose every filled cell is a plain number reads right-aligned, like money.
  const numeric = new Set(
    preview?.headers.filter((h) => {
      const filled = preview.previewRows.map((r) => (r[h] ?? "").trim()).filter(Boolean);
      return filled.length > 0 && filled.every((v) => NUMBER.test(v));
    }),
  );

  return (
    <div className="mt-3 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
      {loading ? (
        <div role="status" aria-label="Loading the file" className="mt-2 rounded-xl border border-paper-200 bg-paper">
          <SkeletonRows rows={6} />
        </div>
      ) : error ? (
        <p className="text-xs text-tone-danger">{error}</p>
      ) : preview ? (
        <>
            {/*
              Capped rather than left to run: PREVIEW_ROW_LIMIT is 50, and 50
              rows unrolled is taller than most screens — it pushed the form
              itself off the bottom of the page. Scrolling within the panel
              keeps both the file and the field visible at once, which is the
              only reason to show the file here at all.
            */}
            {preview.matchedRowNumbers ? (
              <p className="mb-2 text-xs text-ink-600">
                {firstMatch === undefined
                  ? "This record's row couldn't be found in the file. It may have been edited after the import."
                  : preview.matchedRowNumbers.length === 1
                    ? `The highlighted row is the one this record came from (row ${firstMatch}).`
                    : `Rows ${preview.matchedRowNumbers.join(" and ")} both read as this record, so both are highlighted.`}
                {preview.otherRowNumbers?.length ? (
                  <>
                    {" "}
                    <span className="rounded bg-tint-info px-1 font-medium text-ink-900">
                      Row {preview.otherRowNumbers.join(" and ")}
                    </span>{" "}
                    is the record it may repeat.
                  </>
                ) : null}
              </p>
            ) : null}
            <div ref={scroller} className="scroll-slim relative max-h-[28rem] overflow-auto rounded-xl border border-paper-200 bg-paper xl:max-h-none xl:min-h-0 xl:flex-1">
              <table className="w-full min-w-[26rem] text-left text-xs">
                <caption className="sr-only">The imported file's own rows</caption>
                {/* Sticky, because the body scrolls inside the capped box
                    above — column names that scroll away make the rows
                    unreadable halfway down a 50-row file. */}
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-paper-200 bg-paper-100">
                    <th scope="col" className="px-2.5 py-2 text-right font-semibold text-ink-600">Row</th>
                    {preview.headers.map((h) => (
                      // The file's own headers, as written: uppercase tracking made them wider than the data.
                      <th key={h} scope="col" className={`px-2.5 py-2 font-semibold text-ink-600 ${numeric.has(h) ? "text-right" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.previewRows.map((row, i) => {
                    const rowNumber = firstRow + i;
                    const isThis = matched.has(rowNumber);
                    const isOther = others.has(rowNumber);
                    return (
                    <tr
                      key={rowNumber}
                      data-this-record={isThis ? "" : undefined}
                      aria-current={isThis ? "true" : undefined}
                      className={`border-t border-paper-200 transition-colors ${isThis ? "bg-tint-brand text-ink-900" : isOther ? "bg-tint-info text-ink-900" : "hover:bg-paper-50"}`}
                    >
                      <td className="figure whitespace-nowrap px-2.5 py-2 align-top text-right text-ink-600">
                        {rowNumber}
                        {isThis ? <span className="sr-only"> (this record)</span> : null}
                        {isOther ? <span className="sr-only"> (the record it may repeat)</span> : null}
                      </td>
                      {preview.headers.map((h) => (
                        <td
                          key={h}
                          className={`px-2.5 py-2 align-top text-ink-700 ${numeric.has(h) ? "figure whitespace-nowrap text-right" : ""} ${ISO_DATE.test((row[h] ?? "").trim()) ? "whitespace-nowrap" : ""}`}
                        >
                          {readableCell(row[h] ?? "")}
                        </td>
                      ))}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/*
              The same truncation the import screen itself warns about
              (PREVIEW_ROW_LIMIT) — silence here would look like the file
              only ever had this many rows.
            */}
            {preview.totalRows > preview.previewRows.length ? (
              <p className="mt-1.5 text-xs text-ink-500">
                {firstRow === 1
                  ? `Showing the first ${preview.previewRows.length} of ${preview.totalRows} rows.`
                  : `Showing rows ${firstRow} to ${firstRow + preview.previewRows.length - 1} of ${preview.totalRows}.`}
              </p>
            ) : null}
        </>
      ) : null}
    </div>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** The file's own value, written the way the rest of the app writes it: "Oct 1, 2026", "4,500.00". */
function readableCell(raw: string): string {
  const value = raw.trim();
  if (ISO_DATE.test(value)) return formatCalendarDate(value);
  if (NUMBER.test(value)) {
    const decimals = value.split(".")[1]?.length ?? 0;
    return Number(value).toLocaleString("en-PH", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  return raw;
}

function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-500 ${
        align === "right" ? "text-right" : ""
      }`}
    >
      {children}
    </th>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`rounded-xl bg-paper-50 px-3 py-2.5 ring-1 ring-paper-200 ${wide ? "sm:col-span-3" : ""}`}>
      <dt className="text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-ink-900 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
