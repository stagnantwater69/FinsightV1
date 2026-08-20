/**
 * Peso formatting — the single place an amount becomes a string.
 *
 * Identical output rules to web/src/components/Money.tsx so the same record
 * reads the same on both platforms. Pure and dependency-free, which is also
 * what makes it the one piece of mobile logic worth unit-testing.
 */
export function formatMoney(
  value: number,
  { decimals = false, bare = false, signed = false }: { decimals?: boolean; bare?: boolean; signed?: boolean } = {}
): string {
  const digits = decimals ? 2 : 0;
  const abs = Math.abs(value).toLocaleString("en-PH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = signed ? (value < 0 ? "−" : "+") : value < 0 ? "−" : "";
  return `${sign}${bare ? "" : "PHP "}${abs}`;
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/** Maps a backend Notification.type onto the shared alert family. */
export type AlertKind = "duplicate" | "large-expense" | "needs-review" | "recurring" | "info";

export function alertKindFromType(type: string): AlertKind {
  const t = type.toLowerCase();
  if (t.includes("duplicate")) return "duplicate";
  if (t.includes("large")) return "large-expense";
  if (t.includes("review")) return "needs-review";
  // NOTIFICATION_TYPES.RECURRING_SCHEDULE — "Recurring Schedule". Kept in step
  // with web/src/components/Alert.tsx: a watched payment that is late or off
  // its expected amount is the whole reason the owner set up the schedule, so
  // it must not fall through to the informational treatment.
  if (t.includes("recurring")) return "recurring";
  return "info";
}
