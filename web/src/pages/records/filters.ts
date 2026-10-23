import type { RecordSort, RecordSource } from "../../lib/types";

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

/**
 * The records list request, as the page makes it and as the nav warms it.
 * One builder for both: a warm-up that differs from the page in any field the
 * cache keys on fetches something the page never reads.
 */
export function recordsListRequest(
  businessProfileId: number,
  filters: Filters,
  sort: RecordSort,
  cursor?: string,
) {
  return {
    url: "/records/search",
    params: {
      businessProfileId,
      type: filters.type,
      categoryId: filters.categoryId || undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
      keyword: filters.keyword || undefined,
      source: filters.source || undefined,
      importBatchId: filters.importBatchId || undefined,
      limit: 100,
      sort,
      cursor,
    },
    scope: {
      businessProfileId,
      filters,
      sort,
      pagination: { cursor: cursor ?? null, limit: 100 },
      tags: ["records", "financial"],
    },
  };
}

/** The flagged-records badge count on the records page. */
export function flaggedCountRequest(businessProfileId: number) {
  return {
    url: "/records/flagged/count",
    params: { businessProfileId },
    scope: { businessProfileId, tags: ["records", "financial"] },
  };
}

/** What the table starts on, and what the server returns when `sort` is omitted. */
export const DEFAULT_RECORD_SORT: RecordSort = "date_desc";
