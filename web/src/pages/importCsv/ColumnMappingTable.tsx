import { Field, SelectInput } from "../../components/Field";
import { Money } from "../../components/Money";
import { Tag } from "../../components/ui";
import { parseSignedAmount, type RowRecordType } from "../../lib/recordTypeDetection";
import type { MappedColumn } from "./types";

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

export function ColumnMappingFields({
  columns,
  headers,
  errorFor,
}: {
  columns: MappedColumn[];
  headers: string[];
  errorFor: (value: string) => string | null;
}) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${columns.length >= 5 ? "xl:grid-cols-5" : "lg:grid-cols-3"}`}>
      {columns.map((column) => {
        const id = `csv-map-${column.field.toLowerCase()}`;
        const error = errorFor(column.value);
        return (
          <Field
            key={column.field}
            htmlFor={id}
            label={column.field}
            required={!column.optional}
            optional={column.optional}
            error={error}
            hint={column.auto ? "Matched from your file. Change it if needed." : undefined}
            fillRow
          >
            <SelectInput
              id={id}
              required={!column.optional}
              value={column.value}
              onChange={(event) => column.onChange(event.target.value)}
              aria-label={`Which CSV column holds the ${column.field.toLowerCase()}?`}
            >
              <option value="" disabled={!column.optional}>
                {column.optional ? "Do not import this" : "Select a column"}
              </option>
              {headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </SelectInput>
          </Field>
        );
      })}
    </div>
  );
}

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
    return <span className="text-ink-500">Not mapped</span>;
  }

  if (column.field === "Amount") {
    const parsed = parseSignedAmount(value);
    return parsed !== null && value.trim() !== "" ? (
      <Money value={parsed} />
    ) : (
      <span className="text-tone-danger">{value || "Empty"}</span>
    );
  }

  if (isProblem) {
    return <span className="text-tone-danger">{value || "Empty"}</span>;
  }
  return <>{value || <span className="text-ink-500">Empty</span>}</>;
}
