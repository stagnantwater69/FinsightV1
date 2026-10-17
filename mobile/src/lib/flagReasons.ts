import { formatMoney } from "./money";
import type { RecordItem } from "./types";

/** Why a record is flagged, from its own fields and the business's threshold. Mirrors web's flagReasons. */
export function flagReasonText(
  record: RecordItem,
  profile: { expectedMonthlyExpenses: number; largeExpenseThresholdPercent: number },
): string {
  const reasons: string[] = [];
  if (record.largeExpenseFlag) {
    const threshold = profile.expectedMonthlyExpenses * (profile.largeExpenseThresholdPercent / 100);
    reasons.push(`over your ${formatMoney(threshold)} large-expense limit`);
  }
  if (record.duplicateStatus === "Flagged") {
    reasons.push(record.duplicateOfRecordId ? `possible duplicate of #${record.duplicateOfRecordId}` : "possible duplicate");
  }
  return reasons.length > 0 ? reasons.join(" · ") : "flagged for a second look";
}
