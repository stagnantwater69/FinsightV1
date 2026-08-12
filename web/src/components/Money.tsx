/**
 * The single way a peso amount is rendered anywhere in FinSight.
 *
 * Two reasons it's a component rather than a helper that returns a string:
 *
 *  1. Tabular figures need a class on an element. Routing every amount through
 *     here guarantees the mono/tabular treatment is never forgotten, so columns
 *     of figures always align.
 *  2. Formatting stays in one place. Amounts were previously rendered with a
 *     mix of `toLocaleString()` calls with different options, so the same value
 *     could appear as "5,000", "5000" or "5,000.00" on different screens.
 */
interface Props {
  value: number;
  /** Show centavos. Off by default — whole pesos read faster in summaries. */
  decimals?: boolean;
  /** Drop the "PHP" prefix, for tables where the column header carries it. */
  bare?: boolean;
  /** Always show a leading + or -, for deltas and gaps. */
  signed?: boolean;
  className?: string;
}

export function formatMoney(value: number, { decimals = false, bare = false, signed = false } = {}): string {
  const digits = decimals ? 2 : 0;
  const abs = Math.abs(value).toLocaleString("en-PH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = signed ? (value < 0 ? "−" : "+") : value < 0 ? "−" : "";
  return `${sign}${bare ? "" : "PHP "}${abs}`;
}

export function Money({ value, decimals = false, bare = false, signed = false, className = "" }: Props) {
  // A very large capped value (the API sends 999999 where a percentage was
  // Infinity) would otherwise print as a real figure.
  const display = formatMoney(value, { decimals, bare, signed });

  return (
    <span className={`figure ${className}`.trim()} title={formatMoney(value, { decimals: true, bare })}>
      {display}
    </span>
  );
}

/** Percentages get the same tabular treatment so they align in columns too. */
export function Percent({ value, decimals = 1, className = "" }: { value: number; decimals?: number; className?: string }) {
  return <span className={`figure ${className}`.trim()}>{value.toFixed(decimals)}%</span>;
}
