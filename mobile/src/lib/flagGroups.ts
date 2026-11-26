import type { ImportBatchSummary, RecordItem } from "./types";

export interface ImportDuplicateGroup {
  batchId: number;
  /** The import's name and date, when the batch list could be read. */
  batch: ImportBatchSummary | null;
  records: RecordItem[];
}

/**
 * Flagged duplicates that arrived on the same CSV import, for one bulk
 * decision on the Review tab.
 *
 * WHY ONLY IMPORTS. Re-importing a spreadsheet is the case that produces
 * dozens of copies at once, and "this file was imported twice" is answered
 * once for the whole file. Each record belongs to at most one group (its
 * import), so a bulk Keep and a bulk Discard can never reach the same record
 * from two cards. A group needs `minSize` records to be worth a card; a
 * single copy is decided on its own screen like any other flag.
 */
export function importDuplicateGroups(
  records: readonly RecordItem[],
  batches: readonly ImportBatchSummary[],
  minSize = 2,
): ImportDuplicateGroup[] {
  const byBatch = new Map<number, RecordItem[]>();
  for (const record of records) {
    if (record.duplicateStatus !== "Flagged" || !record.importBatchId) continue;
    const list = byBatch.get(record.importBatchId) ?? [];
    list.push(record);
    byBatch.set(record.importBatchId, list);
  }
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  return [...byBatch.entries()]
    .filter(([, list]) => list.length >= minSize)
    .map(([batchId, list]) => ({ batchId, batch: batchById.get(batchId) ?? null, records: list }));
}
