import type { ReactNode } from "react";
import { IconTile } from "../../components/IconTile";
import type { LucideIcon } from "lucide-react";
import type { DailyExpenseTotal } from "../../lib/types";
export { PairBars, ShareBar } from "../../components/MiniCharts";

/**
 * Small, text-free pictures for the Expense Insight page. Each one draws a
 * figure that is already printed beside it, so none of them carries
 * information that is reachable by colour or shape alone.
 */

/**
 * Spending across the period as a single filled line. Plain SVG stretched to
 * its box: it is a shape to glance at inside the hero, not a chart to read
 * values off (the full chart with axes and a table lives further down).
 */
export function Sparkline({
  points,
  label,
}: {
  points: DailyExpenseTotal[];
  label: string;
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.total), 1);
  const w = 100;
  const h = 32;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => [i * step, h - (p.total / max) * (h - 2) - 1] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-14 w-full overflow-visible"
    >
      <defs>
        <linearGradient id="expenseSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.35} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#expenseSparkFill)" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const TILE_TONES = {
  brand: { wash: "from-tint-brand", ring: "ring-edge-brand", mark: "text-tone-brand" },
  info: { wash: "from-tint-info", ring: "ring-edge-info", mark: "text-tone-info" },
  danger: { wash: "from-tint-danger", ring: "ring-edge-danger", mark: "text-tone-danger" },
  neutral: { wash: "from-tint-neutral", ring: "ring-paper-200", mark: "text-tone-neutral" },
} as const;

export type KpiTileTone = keyof typeof TILE_TONES;

/**
 * One headline figure with its own picture underneath. The label is a direct
 * child of the tile root on purpose: the figure and its explanation are read
 * as one unit (and found that way by tests and assistive tech).
 */
export function KpiTile({
  icon: Icon,
  tone,
  label,
  children,
  visual,
  order = 0,
}: {
  icon: LucideIcon;
  tone: KpiTileTone;
  label: string;
  children: ReactNode;
  visual?: ReactNode;
  order?: number;
}) {
  const t = TILE_TONES[tone];
  return (
    <div
      className={`relative isolate flex min-w-0 flex-col overflow-hidden rounded-2xl bg-gradient-to-br ${t.wash} to-paper p-4 pr-16 shadow-sm ring-1 ${t.ring} motion-safe:animate-fade-up sm:p-5 sm:pr-16`}
      style={{ animationDelay: `${order * 70}ms` }}
    >
      <Icon
        aria-hidden
        className={`pointer-events-none absolute -bottom-6 -right-6 -z-10 size-28 -rotate-12 opacity-[0.07] ${t.mark}`}
      />
      <IconTile icon={Icon} className="absolute right-4 top-4 sm:right-5 sm:top-5" />
      <p className="text-xs font-semibold text-ink-600">{label}</p>
      {children}
      {visual ? <div className="mt-auto -mr-12 pt-3">{visual}</div> : null}
    </div>
  );
}

/**
 * One expense against its category's usual amount: the bar is the expense,
 * the tick is the usual. How far past the tick the bar runs is the point.
 */
export function UsualBar({ amount, usual }: { amount: number; usual: number }) {
  const max = Math.max(amount, usual, 1);
  const usualAt = (usual / max) * 100;
  return (
    <div aria-hidden className="relative mt-2 h-2 w-full rounded-full bg-paper-200">
      <div
        className="h-full rounded-full"
        style={{ width: `${(amount / max) * 100}%`, backgroundColor: "rgb(var(--sev-serious-ink))" }}
      />
      <span
        className="absolute -top-1 h-4 w-0.5 rounded-full bg-ink-700"
        style={{ left: `calc(${usualAt}% - 1px)` }}
      />
    </div>
  );
}
