import type { RecordSource } from "../../lib/types";

export interface Filters {
  type: "all" | "expense" | "sales";
  categoryId: string;
  dateFrom: string;
  dateTo: string;
  keyword: string;
  source: "" | RecordSource;
  /** Only meaningful alongside source === "CSV_UPLOAD" — see the Source select. */
  importBatchId: string;
}

export const emptyFilters: Filters = {
  type: "all",
  categoryId: "",
  dateFrom: "",
  dateTo: "",
  keyword: "",
  source: "",
  importBatchId: "",
};

/**
 * True when the owner has narrowed the list at all.
 *
 * Compared field by field rather than by stringifying both objects: the two
 * places a Filters value is built (`emptyFilters` and `filtersFromParams`)
 * declare their keys in a different order, and `JSON.stringify` preserves
 * insertion order — so the stringified forms never matched even when every
 * value was equal, leaving this permanently true. The visible symptom was an
 * owner with no records seeing "No records match these filters" instead of the
 * "You haven't added any records yet" onboarding state.
 */
export function filtersAreActive(f: Filters) {
  return (
    f.type !== emptyFilters.type ||
    Boolean(f.categoryId) ||
    Boolean(f.dateFrom) ||
    Boolean(f.dateTo) ||
    Boolean(f.keyword) ||
    Boolean(f.source) ||
    Boolean(f.importBatchId)
  );
}

/** Which filters count as "advanced" for Hick's Law progressive disclosure. */
export function activeAdvancedCount(f: Filters) {
  return [f.categoryId, f.dateFrom, f.dateTo, f.source, f.importBatchId].filter(Boolean).length;
}
