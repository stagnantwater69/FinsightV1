import { Tag } from "../../components/ui";
import { SelectInput } from "../../components/Field";
import { Money } from "../../components/Money";
import type { RowRecordType } from "../../lib/recordTypeDetection";
import type { MappedColumn, MappedField } from "./types";

/**
 * Per-column widths.
 *
 * Left to itself the table gives five equal columns, which is wrong in both
 * directions at once: a date needs about nine characters and a description
 * routinely runs past forty, so the dates sit in a sea of whitespace while the
 * descriptions wrap. These are the shape of the data, not the header.
 */
export const COLUMN_WIDTH: Record<MappedField, string> = {
  Date: "w-[9.5rem]",
  Description: "w-auto",
  Category: "w-[11rem]",
  Vendor: "w-[11rem]",
  Amount: "w-[9.5rem]",
};

/**
 * What one row of a mixed file will become.
 *
 * Reuses the app's existing expense/sales Tag so an imported row is labelled
 * here exactly as it will be labelled everywhere else. The unreadable case gets
 * its own treatment rather than a third colour of the same chip: it is not a
 * third kind of record, it is a row that will not be imported at all, and it
 * has to read as a problem.
 */
export function RowTypeBadge({ type }: { type: RowRecordType | null }) {
  if (type === null) {
    return (
      <span className="inline-flex shrink-0 rounded-lg bg-tint-danger px-2 py-0.5 text-[11.5px] font-semibold text-tone-danger ring-1 ring-edge-danger">
        Can't tell
      </span>
    );
  }
  return <Tag kind={type === "expense" ? "expense" : "sales"} />;
}

/**
 * A column heading that is also its own column picker.
 *
 * `scope="col"` and the visible field name are kept so the header still does
 * its ordinary table job for a screen reader; the select carries an explicit
 * aria-label because "Date" alone doesn't say what choosing something here
 * would do.
 */
export function MappedHeader({
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
export function CellValue({
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
