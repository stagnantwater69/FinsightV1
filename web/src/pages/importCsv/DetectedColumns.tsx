import { SelectInput } from "../../components/Field";
import { Card } from "../../components/ui";
import type { ColumnChoice, ExtraField } from "./types";

const EXTRA_LABEL: Record<ExtraField, string> = {
  paymentMethod: "Payment method",
  notes: "Notes",
  reference: "Reference",
  quantity: "Quantity",
  customer: "Customer",
  unitPrice: "Unit price",
};

type Field = keyof ColumnChoice;

const FIELD_LABEL: Record<Field, string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  vendor: "Vendor",
  category: "Category",
};

/**
 * What FinSight read each column as, correctable in place.
 *
 * This replaces the mapping step. The columns are detected on upload
 * (backend lib/csvColumnDetection), so the owner starts on the review with
 * everything filled in, and only touches a field FinSight got wrong or could
 * not find. Columns FinSight has no field for are named, not dropped silently.
 */
export function DetectedColumns({
  headers,
  choice,
  onChange,
  usesExpenseFields,
  unmapped,
  typeColumn,
}: {
  headers: string[];
  choice: ColumnChoice;
  onChange: (field: Field, header: string) => void;
  /** Vendor and category exist on expenses only. */
  usesExpenseFields: boolean;
  unmapped: { header: string; field: ExtraField | null }[];
  /** The mixed-file type column, which is in use but not a field. */
  typeColumn: string;
}) {
  const fields: Field[] = usesExpenseFields
    ? ["date", "description", "amount", "vendor", "category"]
    : ["date", "description", "amount"];
  const required = new Set<Field>(["date", "description", "amount"]);
  const taken = (field: Field) =>
    new Set(fields.filter((other) => other !== field).map((other) => choice[other]).filter(Boolean));

  // Columns not feeding anything: the server's list, plus a vendor or category
  // column a sales import has no field for.
  const notImported = [
    ...unmapped.filter((entry) => entry.header !== typeColumn),
    ...(!usesExpenseFields
      ? (["vendor", "category"] as const)
          .filter((field) => choice[field])
          .map((field) => ({ header: choice[field], field: null }))
      : []),
  ].filter((entry) => !fields.some((field) => choice[field] === entry.header));

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink-900">Detected columns</h2>
      <div className={`mt-4 grid gap-4 sm:grid-cols-2 ${fields.length === 5 ? "xl:grid-cols-5" : "lg:grid-cols-3"}`}>
        {fields.map((field) => {
          const id = `csv-column-${field}`;
          const missing = required.has(field) && !choice[field];
          const clash = choice[field] !== "" && taken(field).has(choice[field]);
          return (
            <div key={field} className="min-w-0">
              <label htmlFor={id} className="block text-xs font-semibold text-ink-700">
                {FIELD_LABEL[field]}
                {required.has(field) ? null : <span className="font-normal text-ink-500"> (optional)</span>}
              </label>
              <SelectInput
                id={id}
                value={choice[field]}
                onChange={(event) => onChange(field, event.target.value)}
                aria-invalid={missing || clash || undefined}
                aria-describedby={missing || clash ? `${id}-error` : undefined}
              >
                <option value="">{required.has(field) ? "Choose a column" : "Not in file"}</option>
                {headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </SelectInput>
              {missing ? (
                <p id={`${id}-error`} className="mt-1 text-xs text-tone-danger">
                  Not found
                </p>
              ) : clash ? (
                <p id={`${id}-error`} className="mt-1 text-xs text-tone-danger">
                  Used twice
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {notImported.length > 0 ? (
        <p className="mt-4 text-xs text-ink-500">
          <span className="font-semibold text-ink-600">Not imported: </span>
          {notImported
            .map((entry) => (entry.field ? `${entry.header} (${EXTRA_LABEL[entry.field]})` : entry.header))
            .join(", ")}
        </p>
      ) : null}
    </Card>
  );
}
