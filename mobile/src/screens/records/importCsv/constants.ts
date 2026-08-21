import type { MappedField } from "../../../lib/csvImport";

/** How often, and for how long, to ask a large import how far it has got. */
export const IMPORT_POLL_INTERVAL_MS = 1500;
export const IMPORT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** The worker's failure stages, in words an owner can act on. */
export const IMPORT_STAGE_WORDS: Record<string, string> = {
  download: "fetching the file back",
  parse: "reading the file",
  validate: "checking the rows",
  insert: "saving the rows",
};

export const FIELD_LABELS: Record<MappedField, string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  category: "Category",
  vendor: "Vendor",
  recordType: "Sale or expense column",
};
