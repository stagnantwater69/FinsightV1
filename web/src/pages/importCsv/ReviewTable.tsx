import { useState } from "react";
import { Button } from "../../components/Button";
import { SelectInput, TextInput } from "../../components/Field";
import { IconEdit, IconTrash } from "../../components/icons";
import { Money } from "../../components/Money";
import { Pill, Tag } from "../../components/ui";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { parseSignedAmount, type RowRecordType } from "../../lib/recordTypeDetection";
import type { MappedField, RowCategory, RowProblem } from "./types";

export interface ReviewRow {
  rowNumber: number;
  /** The row as it will be imported: the file's cells with the owner's edits over them. */
  values: Record<MappedField, string>;
  problem: RowProblem;
  /** Mixed files only: what the row will become, or null when the file does not say. */
  recordType?: RowRecordType | null;
  excluded: boolean;
  duplicate: boolean;
  /** FinSight's category for the row (expense rows only). */
  category: RowCategory | null;
  /** The owner chose the category themselves. */
  categoryEdited: boolean;
  edited: boolean;
  baselineDateMatch: boolean;
  includedInAvailableFundsBaseline?: boolean;
}

const PAGE = 25;
const OTHER = "\u0000other";

type Status = { label: string; tone: "ok" | "warn" | "danger" | "neutral" };

function statusOf(row: ReviewRow, isExpense: boolean): Status {
  if (row.excluded) return { label: "Removed", tone: "neutral" };
  if (row.recordType === null) return { label: "Type unknown", tone: "danger" };
  if (row.problem) return { label: row.problem.reason, tone: "danger" };
  if (row.duplicate) return { label: "Possible duplicate", tone: "warn" };
  if (isExpense && !row.categoryEdited && row.category?.source === "none") return { label: "No category", tone: "warn" };
  return { label: "Ready", tone: "ok" };
}

/** Rows the owner should look at before importing. */
export function needsReview(row: ReviewRow, isExpense: boolean): boolean {
  return statusOf(row, isExpense).tone !== "ok" && !row.excluded;
}

function CategoryBadge({ row }: { row: ReviewRow }) {
  if (row.categoryEdited) return <Pill tone="neutral">Edited</Pill>;
  const category = row.category;
  if (!category) return null;
  if (category.isNew) return <Pill tone="info">New</Pill>;
  if (category.source === "suggested" || category.source === "history") {
    return <Pill tone={category.confidence === "low" ? "warn" : "info"}>{category.confidence === "low" ? "Check" : "Suggested"}</Pill>;
  }
  return null;
}

function CategoryCell({
  row,
  options,
  onChange,
}: {
  row: ReviewRow;
  options: string[];
  onChange: (value: string) => void;
}) {
  const current = row.values.Category || row.category?.name || "";
  const [typing, setTyping] = useState(false);
  const label = `Category for row ${row.rowNumber}`;
  if (typing) {
    return (
      <TextInput
        aria-label={label}
        autoFocus
        defaultValue={current}
        maxLength={FIELD_LIMITS.categoryName}
        onBlur={(event) => {
          if (event.target.value.trim()) onChange(event.target.value.trim());
          setTyping(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") setTyping(false);
        }}
      />
    );
  }
  const choices = current && !options.includes(current) ? [current, ...options] : options;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <SelectInput
        aria-label={label}
        title={current || undefined}
        value={current}
        disabled={row.excluded}
        onChange={(event) => {
          if (event.target.value === OTHER) setTyping(true);
          else onChange(event.target.value);
        }}
      >
        {current ? null : <option value="">Choose</option>}
        {choices.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </SelectInput>
      <CategoryBadge row={row} />
    </div>
  );
}

function AmountText({ value }: { value: string }) {
  const parsed = parseSignedAmount(value);
  return parsed !== null && value.trim() !== "" ? <Money value={parsed} /> : <span className="text-tone-danger">{value || "Empty"}</span>;
}

function TypeBadge({ type }: { type: RowRecordType | null }) {
  if (type === null) {
    return (
      <span className="inline-flex shrink-0 rounded-lg bg-tint-danger px-2 py-0.5 text-[11.5px] font-semibold text-tone-danger ring-1 ring-edge-danger">
        Unknown
      </span>
    );
  }
  return <Tag kind={type === "expense" ? "expense" : "sales"} />;
}

/**
 * The rows being imported, editable in place.
 *
 * Shows the file's first rows plus every row the server flagged further down
 * (skipped, possible duplicate, uncategorised), so a problem at row 900 is
 * fixed here rather than in the spreadsheet. Nothing is saved until Import.
 */
export function ReviewTable({
  rows,
  totalRows,
  showExpenseFields,
  mixed,
  categoryOptions,
  onEdit,
  onToggleExclude,
  baselineDefault,
  onBaselineDecision,
}: {
  rows: ReviewRow[];
  totalRows: number;
  showExpenseFields: boolean;
  mixed: boolean;
  categoryOptions: string[];
  onEdit: (rowNumber: number, field: MappedField, value: string) => void;
  onToggleExclude: (rowNumber: number) => void;
  baselineDefault: boolean | null;
  onBaselineDecision: (rowNumber: number, value: boolean | undefined) => void;
}) {
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<number | null>(null);

  const isExpenseRow = (row: ReviewRow) => showExpenseFields && (!mixed || row.recordType === "expense");
  const flagged = rows.filter((row) => needsReview(row, isExpenseRow(row)));
  const listed = filter === "review" ? flagged : rows;
  const visible = listed.slice(0, limit);
  const editableFields: MappedField[] = showExpenseFields
    ? ["Date", "Description", "Vendor", "Amount"]
    : ["Date", "Description", "Amount"];
  const showBalanceColumn = baselineDefault !== null && rows.some((row) => row.baselineDateMatch);

  function field(row: ReviewRow, name: MappedField) {
    const id = `csv-row-${row.rowNumber}-${name.toLowerCase()}`;
    const invalid = row.problem?.field === name;
    if (editing === row.rowNumber) {
      return (
        <TextInput
          id={id}
          aria-label={`${name}, row ${row.rowNumber}`}
          value={row.values[name]}
          aria-invalid={invalid || undefined}
          maxLength={name === "Description" ? FIELD_LIMITS.recordDescription : name === "Vendor" ? FIELD_LIMITS.vendor : 100}
          inputMode={name === "Amount" ? "decimal" : undefined}
          onChange={(event) => onEdit(row.rowNumber, name, event.target.value)}
        />
      );
    }
    if (name === "Amount") return <AmountText value={row.values.Amount} />;
    const text = row.values[name];
    return text ? <span className={invalid ? "text-tone-danger" : ""}>{text}</span> : <span className={invalid ? "text-tone-danger" : "text-ink-600"}>Empty</span>;
  }

  /** Plain Edit and Remove are icons so every column fits; Fix and Done stay words. */
  function actions(row: ReviewRow) {
    const isEditing = editing === row.rowNumber;
    const verb = isEditing ? "Done editing" : row.problem ? "Fix" : "Edit";
    const iconEdit = verb === "Edit";
    const iconRemove = !row.excluded;
    return (
      <div className="flex justify-end gap-1">
        {!row.excluded ? (
          <Button
            type="button"
            size="sm"
            variant={row.problem && !isEditing ? "brand" : "ghost"}
            onClick={() => setEditing(isEditing ? null : row.rowNumber)}
            aria-label={`${verb} row ${row.rowNumber}`}
            title={iconEdit ? "Edit" : undefined}
            className={iconEdit ? "min-w-tap px-0" : ""}
          >
            {iconEdit ? <IconEdit className="h-4 w-4" /> : isEditing ? "Done" : verb}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (isEditing) setEditing(null);
            onToggleExclude(row.rowNumber);
          }}
          aria-label={`${row.excluded ? "Restore" : "Remove"} row ${row.rowNumber}`}
          title={iconRemove ? "Remove" : undefined}
          className={iconRemove ? "min-w-tap px-0" : ""}
        >
          {iconRemove ? <IconTrash className="h-4 w-4" /> : row.excluded ? "Restore" : "Remove"}
        </Button>
      </div>
    );
  }

  return (
    <section aria-labelledby="csv-rows-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="csv-rows-title" className="text-base font-semibold text-ink-900">
          Rows
        </h2>
        <div role="group" aria-label="Show rows" className="flex gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1">
          {(
            [
              ["all", `All (${rows.length})`],
              ["review", `Needs review (${flagged.length})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setLimit(PAGE);
              }}
              className={`tap rounded-lg px-3 text-[13px] font-semibold transition ${
                filter === value ? "bg-paper text-tone-brand shadow-sm" : "text-ink-600 hover:text-tone-brand"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {listed.length === 0 ? (
        <p className="mt-4 rounded-xl bg-paper-100 px-4 py-6 text-center text-sm text-ink-600">
          {rows.length === 0 ? "No data rows in this file." : "Nothing needs review."}
        </p>
      ) : (
        <>
          {/* Always a table: rows and columns are how an owner checks a file
              against their spreadsheet. On a narrow screen it scrolls sideways
              inside this frame rather than stacking each row into a card.
              `relative` keeps the sr-only caption and header inside the
              scroller; without it they are positioned against <main> and
              widen the page. */}
          <div className="scroll-slim relative mt-4 overflow-x-auto rounded-xl border border-paper-200">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Rows to import, with any edits applied</caption>
              <thead>
                <tr className="bg-paper-100">
                  <th scope="col" className="w-10 px-2.5 py-2.5 text-right text-xs font-semibold text-ink-600">#</th>
                  {mixed ? <th scope="col" className="px-2.5 py-2.5 text-xs font-semibold text-ink-600">Type</th> : null}
                  {editableFields.map((name) => (
                    <th key={name} scope="col" className={`px-2.5 py-2.5 text-xs font-semibold text-ink-600 ${name === "Amount" ? "text-right" : ""}`}>
                      {name}
                    </th>
                  ))}
                  {showExpenseFields ? <th scope="col" className="px-2.5 py-2.5 text-xs font-semibold text-ink-600">Category</th> : null}
                  {showBalanceColumn ? <th scope="col" className="px-2.5 py-2.5 text-xs font-semibold text-ink-600">Recorded balance</th> : null}
                  <th scope="col" className="px-2.5 py-2.5 text-xs font-semibold text-ink-600">Status</th>
                  <th scope="col" className="px-2.5 py-2.5 text-right text-xs font-semibold text-ink-600"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const status = statusOf(row, isExpenseRow(row));
                  return (
                    <tr key={row.rowNumber} className={`border-t border-paper-200 align-top ${row.excluded ? "opacity-60" : status.tone === "danger" ? "bg-tint-danger/30" : ""}`}>
                      <td className="figure px-2.5 py-2.5 text-right text-xs text-ink-600">{row.rowNumber}</td>
                      {mixed ? <td className="whitespace-nowrap px-2.5 py-2.5"><TypeBadge type={row.recordType ?? null} /></td> : null}
                      {editableFields.map((name) => (
                        <td
                          key={name}
                          className={`px-2.5 py-2.5 text-ink-700 ${
                            name === "Amount"
                              ? "whitespace-nowrap text-right"
                              : name === "Description"
                                ? "min-w-[9rem] break-words"
                                : name === "Vendor"
                                  ? "min-w-[7rem] break-words"
                                  : "whitespace-nowrap"
                          } ${row.excluded ? "line-through" : ""}`}
                        >
                          {field(row, name)}
                        </td>
                      ))}
                      {showExpenseFields ? (
                        <td className="w-[11rem] min-w-[10rem] px-2.5 py-1.5">
                          {isExpenseRow(row) ? (
                            <CategoryCell row={row} options={categoryOptions} onChange={(value) => onEdit(row.rowNumber, "Category", value)} />
                          ) : (
                            <span className="text-xs text-ink-600">Not used for sales</span>
                          )}
                        </td>
                      ) : null}
                      {showBalanceColumn ? (
                        <td className="min-w-[12rem] px-2.5 py-1.5">
                          {row.baselineDateMatch ? (
                            <SelectInput
                              aria-label={`Recorded balance inclusion for row ${row.rowNumber}`}
                              value={row.includedInAvailableFundsBaseline === undefined ? "default" : row.includedInAvailableFundsBaseline ? "included" : "after"}
                              disabled={row.excluded}
                              onChange={(event) => onBaselineDecision(
                                row.rowNumber,
                                event.target.value === "default" ? undefined : event.target.value === "included",
                              )}
                            >
                              <option value="default">Use import answer ({baselineDefault ? "included" : "after balance"})</option>
                              <option value="included">Already included</option>
                              <option value="after">After the balance</option>
                            </SelectInput>
                          ) : (
                            <span className="text-xs text-ink-600">Not the balance date</span>
                          )}
                        </td>
                      ) : null}
                      <td className="whitespace-nowrap px-2.5 py-2.5">
                        <Pill tone={status.tone}>{status.label}</Pill>
                      </td>
                      <td className="px-1 py-1.5">{actions(row)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {listed.length > visible.length ? (
            <div className="mt-3 flex justify-center">
              <Button type="button" variant="secondary" size="sm" onClick={() => setLimit((value) => value + PAGE)}>
                Show {Math.min(PAGE, listed.length - visible.length)} more
              </Button>
            </div>
          ) : null}
        </>
      )}

      {totalRows > rows.length ? (
        <p className="mt-3 text-xs text-ink-600">
          Showing {rows.length} of {totalRows.toLocaleString()} rows. Every row is checked on import.
        </p>
      ) : null}
    </section>
  );
}
