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

// A plain decimal, optionally with correct thousands commas: "1250.5", "1,250.50", ".5", "-5". Not "1e3", "0x10" or "12,50".
const AMOUNT_SHAPE = /^-?(?=[\d.]*\d)(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d*)?$/;

/**
 * What the owner typed in an amount box, as a number, or null when it is blank
 * or not a plain decimal. `Number()` alone read "1e3" as 1000 and "0x10" as 16,
 * and refused "1,250.50" as if it were zero.
 */
export function parseAmountInput(raw: string): number | null {
  const cleaned = raw.trim();
  return AMOUNT_SHAPE.test(cleaned) ? Number(cleaned.replace(/,/g, "")) : null;
}

/** The message a manual amount box shows before saving, or null when the amount is usable (above zero). */
export function amountInputError(raw: string): string | null {
  const value = parseAmountInput(raw);
  if (value === null && raw.trim() !== "") return "Enter the amount in numbers, like 1250.50.";
  return value === null || value <= 0 ? "Enter an amount greater than zero." : null;
}

/** A short figure for tight spots (calendar cells, slider ends): 4.1k, 1.2M. The full amount is always shown nearby. */
export function compactAmount(value: number): string {
  const abs = Math.abs(value);
  const short = (n: number, unit: string) => `${n.toFixed(1).replace(/\.0$/, "")}${unit}`;
  // Thresholds sit where rounding would print 1000k or 1000, so those step up a unit.
  if (abs >= 999_950) return short(value / 1_000_000, "M");
  if (abs >= 999.5) return short(value / 1_000, "k");
  return String(Math.round(value));
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
