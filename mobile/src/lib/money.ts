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
export type AlertKind = "duplicate" | "large-expense" | "needs-review" | "info";

export function alertKindFromType(type: string): AlertKind {
  const t = type.toLowerCase();
  if (t.includes("duplicate")) return "duplicate";
  if (t.includes("large")) return "large-expense";
  if (t.includes("review")) return "needs-review";
  return "info";
}
