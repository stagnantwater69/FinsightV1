import { enqueueCsvSourcePurgeIfOrphaned } from "../services/csvSourcePurge.service";
import { enqueueReceiptPurgeIfOrphaned } from "../services/receiptPurge.service";

/**
 * Removes the uploaded file a deleted record came from, once nothing is left
 * that came from it.
 *
 * THE GAP THIS CLOSES. Deleting a record removed it from the owner's books and
 * left its receipt photograph or spreadsheet in Storage forever. Nothing ever
 * removed either, so a business's images accumulated for the life of the
 * account — and the privacy page had to say so, because "delete" that leaves
 * the picture of the receipt on a server is not the deletion an owner thinks
 * they asked for.
 *
 * WHY IT IS NOT SIMPLY "DELETE THE FILE WITH THE RECORD". One upload can
 * produce several records: an itemised receipt splits across categories, and a
 * CSV import creates a whole batch. Deleting one of those must not remove a
 * file the others still came from. So the rule is reference counting — the
 * file goes when the LAST record that came from it goes.
 *
 * Receipt cleanup is called after a record commit. CSV callers that need the
 * delete and enqueue to be atomic use enqueueCsvSourcePurgesIfOrphaned inside
 * their transaction; the wrapper below remains for other callers.
 */

/**
 * Queues durable deletion of a receipt scan once no expense record comes from
 * it. Storage is cleared before the relational row that names each path.
 *
 * A PENDING SCAN IS NEVER TOUCHED, and that exclusion is the important part.
 * A scan that has not been confirmed yet has no expense records by definition
 * — it is an owner part-way through the review screen, not an orphan. Treating
 * "no records" alone as the test would delete the receipt someone is in the
 * middle of checking.
 */
export async function cleanUpReceiptScanIfOrphaned(receiptScanId: number | null | undefined) {
  await enqueueReceiptPurgeIfOrphaned(receiptScanId);
}

/**
 * Queues deletion of an import batch's CSV if no record from it survives.
 *
 * Both record types have to be counted: one spreadsheet can produce expense
 * records, sales reference records, or both, and a batch is only spent when
 * every row it created is gone.
 */
export async function cleanUpImportBatchIfOrphaned(importBatchId: number | null | undefined) {
  await enqueueCsvSourcePurgeIfOrphaned(importBatchId);
}
