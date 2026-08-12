import { useEffect, useState, type ReactNode } from "react";
import { Money } from "./Money";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { CsvBatchPreview, RecordOrigin } from "../lib/types";

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
}: {
  origin: RecordOrigin;
  recordAmount: number;
}) {
  /*
   * Split into a component per origin kind rather than branching inside one.
   * The receipt panel needs state of its own for the tab strip, and a hook
   * cannot live below the early return the CSV branch used to make — this is
   * the rules-of-hooks fix, not a stylistic one.
   */
  if (origin.kind === "csv_import") return <CsvOrigin origin={origin} />;
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
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="tablist" className="mt-3 flex gap-1 border-b border-paper-200">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
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

function CsvOrigin({ origin }: { origin: Extract<RecordOrigin, { kind: "csv_import" }> }) {
  // Same two-view split as the receipt panel, so a source panel behaves the
  // same way whichever kind of source it is describing.
  const [tab, setTab] = useState<"details" | "file">("details");

  return (
    <section className="rounded-2xl border border-paper-200 bg-paper-50 p-4">
      <h2 className="text-sm font-semibold text-ink-800">From a CSV import</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        {/*
          A spreadsheet row IS the record — there are no line items behind
          it. So the useful provenance is the batch: which file this came in
          on, and what else came with it.
        */}
        This record was one row in an imported file. A CSV row has no item
        breakdown behind it — what you see here is the whole record.
      </p>

      <TabStrip
        tabs={[
          { id: "details", label: "Import details" },
          { id: "file", label: "File rows" },
        ]}
        active={tab}
        onSelect={(id) => setTab(id as "details" | "file")}
      />

      {tab === "file" ? (
        <CsvFilePreview batchId={origin.batchId} />
      ) : (
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <Detail label="Import" value={origin.title} />
        <Detail label="Uploaded" value={new Date(origin.uploadDate).toLocaleDateString()} />
        <Detail label="Status" value={origin.status} />
        <Detail
          label="Rows in this import"
          value={`${origin.rowCount} record${origin.rowCount === 1 ? "" : "s"}`}
        />
        <div className="sm:col-span-2">
          <dt className="font-medium text-ink-600">File</dt>
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
                className="tap-inline font-medium text-brand-700 underline-offset-2 hover:underline"
              >
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

  const chargesCentavos =
    Math.round(recordAmount * 100) - Math.round(origin.itemsSubtotal * 100);

  return (
    <section className="rounded-2xl border border-paper-200 bg-paper-50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-800">From a scanned receipt</h2>
        <p className="text-xs text-ink-500">
          Scanned {new Date(origin.scannedAt).toLocaleDateString()}
          {origin.extractedVendor ? ` · ${origin.extractedVendor}` : ""}
        </p>
      </div>

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
        />
      ) : null}

      {tab === "photo" && origin.imageUrl ? (
        <ReceiptImage url={origin.imageUrl} />
      ) : (
      <>
      {origin.items.length > 0 ? (
        <>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            The {origin.items.length} line{origin.items.length === 1 ? "" : "s"} that make up this record.
          </p>

          <div className="mt-2.5 overflow-x-auto rounded-xl border border-paper-200 bg-paper">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <caption className="sr-only">Items from the receipt that make up this record</caption>
              <thead>
                <tr className="border-b border-paper-200 bg-paper-100">
                  <Th>Item</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Unit</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {origin.items.map((item) => (
                  <tr key={item.id} className="border-t border-paper-200">
                    <td className="px-3 py-2 text-ink-800">
                      {item.name}
                      {/*
                        A line the owner typed in is not something FinSight
                        read off the receipt, and this panel must not let the
                        heading above imply otherwise.
                      */}
                      {item.addedByOwner ? (
                        <span className="ml-1.5 rounded-full bg-paper-200 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">
                          you added
                        </span>
                      ) : null}
                      {/*
                        Nor did FinSight read this one off the receipt's text —
                        OCR found none, so AI interpreted the photograph. The
                        same reasoning as the badge above: the heading claims a
                        reading, and a line that was inferred must say so.
                      */}
                      {item.extractedByVision ? (
                        <span className="ml-1.5 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent">
                          AI read from photo
                        </span>
                      ) : null}
                    </td>
                    <td className="figure px-3 py-2 text-right text-ink-600">{item.quantity ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-ink-600">
                      {item.unitPrice === null ? "—" : <Money value={item.unitPrice} decimals bare />}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-900">
                      <Money value={item.amount} decimals bare />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-paper-200 bg-paper-100">
                  <td colSpan={3} className="px-3 py-2 text-xs font-medium text-ink-600">
                    Items subtotal
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
                  className="min-w-0 truncate text-brand-700 underline-offset-2 hover:underline"
                >
                  {sibling.categoryName}
                  <span className="ml-1.5 text-xs text-ink-400">{sibling.description}</span>
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
        className="tap-inline mt-2 inline-block text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
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
function CsvFilePreview({ batchId }: { batchId: number }) {
  const [preview, setPreview] = useState<CsvBatchPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<CsvBatchPreview>(`/records/csv-imports/batches/${batchId}/preview`)
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
  }, [batchId]);

  return (
    <div className="mt-3">
      {loading ? (
        <p className="text-xs text-ink-500">Loading the file…</p>
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
            <div className="scroll-slim mt-2 max-h-[28rem] overflow-auto rounded-xl border border-paper-200 bg-paper">
              <table className="w-full min-w-[26rem] text-left text-sm">
                <caption className="sr-only">The imported file's own rows</caption>
                {/* Sticky, because the body scrolls inside the capped box
                    above — column names that scroll away make the rows
                    unreadable halfway down a 50-row file. */}
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-paper-200 bg-paper-100">
                    {preview.headers.map((h) => (
                      <Th key={h}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.previewRows.map((row, i) => (
                    <tr key={i} className="border-t border-paper-200">
                      {preview.headers.map((h) => (
                        <td key={h} className="px-3 py-2 text-ink-700">
                          {row[h] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
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
                Showing the first {preview.previewRows.length} of {preview.totalRows} rows.
              </p>
            ) : null}
        </>
      ) : null}
    </div>
  );
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-ink-600">{label}</dt>
      <dd className="mt-0.5 text-ink-800">{value}</dd>
    </div>
  );
}
