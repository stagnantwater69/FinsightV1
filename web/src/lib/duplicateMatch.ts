import type { RecordItem } from "./types";

const same = (a?: string | null, b?: string | null) =>
  !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What two flagged expenses share, in the duplicate rule's own terms: the same
 * date and amount, plus the same vendor or the same description (see
 * backend/src/lib/expenseDuplicateIdentity.ts). Saying "description" when only
 * the vendor matched sent owners looking for a match that wasn't there.
 */
export function sharedFields(a: RecordItem, b: RecordItem): string {
  const vendor = same(a.vendor, b.vendor);
  const description = same(a.description, b.description);
  if (vendor && description) return "date, amount, vendor and description";
  if (vendor) return "date, amount and vendor";
  if (description) return "date, amount and description";
  return "date and amount";
}
