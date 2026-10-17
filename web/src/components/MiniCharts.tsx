import { formatMoney } from "./Money";

/**
 * Small, text-free charts shared by the insight pages and the dashboard. Each
 * one draws a figure that is printed beside it, so none is the only place a
 * value appears.
 */

/** A horizontal share bar. `color` is a CSS colour; the track follows the theme. */
export function ShareBar({
  percent,
  color,
  className = "h-2",
  trackClassName = "bg-paper-200",
}: {
  percent: number;
  color: string;
  className?: string;
  trackClassName?: string;
}) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <div aria-hidden className={`w-full overflow-hidden rounded-full ${trackClassName} ${className}`}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
        style={{ width: `${clamped > 0 ? Math.max(clamped, 2) : 0}%`, backgroundColor: color }}
      />
    </div>
  );
}

/** Two figures on one scale, e.g. this period against the one before. */
export function PairBars({
  rows,
}: {
  rows: { label: string; value: number; color: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <dt className="truncate text-ink-500">{row.label}</dt>
            <dd className="figure shrink-0 font-semibold text-ink-700">{formatMoney(row.value)}</dd>
          </div>
          <ShareBar percent={(row.value / max) * 100} color={row.color} className="mt-0.5 h-1.5" />
        </div>
      ))}
    </dl>
  );
}

/**
 * A progress ring. Plain SVG rather than a chart library: it is one value
 * against a ceiling, and it has to render in tests and on first paint.
 */
export function ProgressRing({
  percent,
  size = 112,
  stroke = 12,
  color = "rgb(var(--chart-emphasis))",
  label,
}: {
  percent: number;
  size?: number;
  stroke?: number;
  color?: string;
  label: string;
}) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgb(var(--chart-muted))"
          strokeWidth={stroke}
        />
        {clamped > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
            className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
          />
        ) : null}
      </svg>
      <span
        aria-hidden
        className="figure absolute inset-0 flex items-center justify-center text-lg font-semibold text-ink-900"
      >
        {Math.round(percent)}%
      </span>
    </div>
  );
}

