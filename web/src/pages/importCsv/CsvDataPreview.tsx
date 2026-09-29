import { Button } from "../../components/Button";
import type { RowRecordType } from "../../lib/recordTypeDetection";
import { CellValue, RowTypeBadge } from "./ColumnMappingTable";
import type { MappedColumn, MappedField, RowProblem } from "./types";

export interface CsvPreviewRow {
  rowNumber: number;
  values: Record<MappedField, string>;
  problem: RowProblem;
  recordType?: RowRecordType | null;
}

function RowStatus({ row, mappingIsValid, mixed }: { row: CsvPreviewRow; mappingIsValid: boolean; mixed: boolean }) {
  const needsType = mixed && row.recordType === null;
  if (!mappingIsValid) {
    return <span className="inline-flex rounded-lg bg-tint-neutral px-2 py-0.5 text-xs font-semibold text-tone-neutral ring-1 ring-edge-neutral">Map columns</span>;
  }
  if (row.problem || needsType) {
    return <span className="inline-flex rounded-lg bg-tint-danger px-2 py-0.5 text-xs font-semibold text-tone-danger ring-1 ring-edge-danger">Needs review</span>;
  }
  return <span className="inline-flex rounded-lg bg-tint-brand px-2 py-0.5 text-xs font-semibold text-tone-brand ring-1 ring-edge-brand">Preview ready</span>;
}

export function CsvDataPreview({
  rows,
  columns,
  totalRows,
  mappingIsValid,
  mixed,
  expanded,
  onExpandedChange,
}: {
  rows: CsvPreviewRow[];
  columns: MappedColumn[];
  totalRows: number;
  mappingIsValid: boolean;
  mixed: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const visibleRows = expanded ? rows : rows.slice(0, 5);
  const visibleCount = visibleRows.length;
  const returnedCount = rows.length;

  return (
    <section aria-labelledby="csv-preview-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="csv-preview-title" className="text-base font-semibold text-ink-900">Data preview</h2>
          <p className="mt-1 text-xs text-ink-500">
            {returnedCount === 0
              ? "No data rows were returned."
              : `Showing ${visibleCount} of ${returnedCount} preview row${returnedCount === 1 ? "" : "s"}.`}
          </p>
        </div>
        {returnedCount > 5 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls="csv-preview-rows"
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? "Show first 5 rows" : `View all ${returnedCount} preview rows`}
          </Button>
        ) : null}
      </div>

      {returnedCount === 0 ? (
        <div id="csv-preview-rows" className="mt-4 rounded-xl bg-paper-100 px-4 py-8 text-center">
          <p className="text-sm font-medium text-ink-800">This file has headings but no records.</p>
          <p className="mt-1 text-xs text-ink-600">Add at least one data row, then choose the file again.</p>
        </div>
      ) : (
        <div id="csv-preview-rows" className="mt-4">
          <div className="scroll-slim hidden max-h-[32rem] overflow-auto rounded-xl border border-paper-200 md:block">
            <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
              <caption className="sr-only">CSV rows shown through the current FinSight column mapping</caption>
              <thead>
                <tr className="bg-paper-100">
                  <th scope="col" className="sticky top-0 z-10 w-12 border-b border-paper-200 bg-paper-100 px-3 py-2.5 text-right text-xs font-semibold text-ink-600">#</th>
                  {mixed ? <th scope="col" className="sticky top-0 z-10 border-b border-paper-200 bg-paper-100 px-3 py-2.5 text-xs font-semibold text-ink-600">Type</th> : null}
                  {columns.map((column) => (
                    <th key={column.field} scope="col" className={`sticky top-0 z-10 border-b border-paper-200 bg-paper-100 px-3 py-2.5 text-xs font-semibold text-ink-600 ${column.align === "right" ? "text-right" : ""}`}>
                      {column.field}
                    </th>
                  ))}
                  <th scope="col" className="sticky top-0 z-10 border-b border-paper-200 bg-paper-100 px-3 py-2.5 text-xs font-semibold text-ink-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.rowNumber} className={`border-t border-paper-200 ${row.problem ? "bg-tint-danger/30" : "even:bg-paper-100/40"}`}>
                    <td className="figure px-3 py-2.5 text-right text-xs text-ink-600">{row.rowNumber}</td>
                    {mixed ? <td className="whitespace-nowrap px-3 py-2.5 align-top"><RowTypeBadge type={row.recordType ?? null} /></td> : null}
                    {columns.map((column) => (
                      <td key={column.field} className={`px-3 py-2.5 align-top text-ink-700 ${column.align === "right" ? "text-right" : ""} ${column.field === "Description" ? "min-w-[14rem]" : "whitespace-nowrap"}`}>
                        <CellValue value={row.values[column.field]} column={column} isProblem={row.problem?.field === column.field} />
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-2.5 align-top"><RowStatus row={row} mappingIsValid={mappingIsValid} mixed={mixed} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="divide-y divide-paper-200 rounded-xl border border-paper-200 md:hidden">
            {visibleRows.map((row) => (
              <li key={row.rowNumber} className={`p-4 ${row.problem ? "bg-tint-danger/30" : "bg-paper"}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="figure text-xs font-semibold text-ink-600">Row {row.rowNumber}</span>
                  <RowStatus row={row} mappingIsValid={mappingIsValid} mixed={mixed} />
                </div>
                {mixed ? <div className="mt-3"><RowTypeBadge type={row.recordType ?? null} /></div> : null}
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  {columns.map((column) => (
                    <div key={column.field} className="min-w-0">
                      <dt className="text-[11px] font-semibold text-ink-600">{column.field}</dt>
                      <dd className={`mt-0.5 break-words text-sm text-ink-800 ${column.align === "right" ? "figure" : ""}`}>
                        <CellValue value={row.values[column.field]} column={column} isProblem={row.problem?.field === column.field} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}

      {totalRows > returnedCount ? (
        <p className="mt-3 text-xs text-ink-500">
          This preview contains {returnedCount} of {totalRows.toLocaleString()} rows. FinSight checks the full file before import.
        </p>
      ) : null}
    </section>
  );
}
