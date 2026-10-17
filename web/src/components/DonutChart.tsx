import { useState } from "react";
import { OTHER_COLOR } from "../lib/chartPalette";
import { useCategoricalPalette } from "../lib/useChartPalette";
import { formatMoney } from "./Money";

/**
 * Expense distribution as a donut with a value legend — the mockup's
 * signature dashboard visual (`.donut-wrap`).
 *
 * Form: part-to-whole across a handful of categories, so a donut is a
 * defensible choice. It stops being one past ~6 slices, which is why
 * everything below `TOP_N` folds into a single "Other" rather than becoming
 * an unreadable fan of thin wedges.
 *
 * Colour: fixed-order assignment from the validated categorical palette,
 * never cycled — a category keeps its colour when the period changes and the
 * set shrinks. "Other" is deliberately a neutral grey, outside the palette,
 * so it never reads as just another category.
 *
 * Identity is never carried by colour alone: every slice is named AND valued
 * in the legend beside it, which is also what makes this readable for anyone
 * with a colour-vision deficiency and in print.
 */

const TOP_N = 6;
const SIZE = 200;
const RADIUS = 76;
const STROKE = 26;

/**
 * The clear space inside the ring — the only room the centre total has.
 *
 * Derived from the ring rather than written as a number, so it stays correct
 * if RADIUS or STROKE is ever adjusted. The 12px comes off so the figure has
 * breathing room instead of touching the segments.
 */
const HOLE_WIDTH = 2 * (RADIUS - STROKE / 2) - 12;

/**
 * Approximate advance width of one character in the mono figure face, in em.
 *
 * Used to size the centre total to fit rather than picking a fixed class and
 * hoping. `text-lg` was the fixed class, and at 18px a ten-character
 * "PHP 96,917" needs ~108px against a 102px hole — so it overflowed the ring
 * on any business past five figures. Amounts only get longer from there.
 */
const MONO_ADVANCE_EM = 0.6;
const MAX_LABEL_PX = 18;
const MIN_LABEL_PX = 10;

/** The largest size at which the whole figure still fits inside the ring.
 *  Exported for tests: it is pure geometry, and it is what broke visibly when
 *  a five-figure total overflowed the ring. */
export function fitLabelSize(label: string): number {
  const ideal = HOLE_WIDTH / (label.length * MONO_ADVANCE_EM);
  return Math.max(MIN_LABEL_PX, Math.min(MAX_LABEL_PX, Math.floor(ideal)));
}

export interface DonutSlice {
  name: string;
  total: number;
  color: string;
}

/**
 * Turns a category breakdown into the wedges the chart draws.
 *
 * Exported so what an owner actually sees can be checked. Three rules matter
 * and none of them are obvious from the drawing code:
 *
 *   - Largest first, so the eye lands on the category that dominates.
 *   - Only the top TOP_N get their own wedge. Past about six slices a donut
 *     stops being readable and becomes a fan of slivers, so the remainder is
 *     folded into one "Other".
 *   - Colours are assigned by RANK, from a fixed palette, never cycled — a
 *     category keeps its colour as the period changes and the set shrinks.
 *     "Other" is a neutral grey from outside the palette so it never reads as
 *     just another category.
 */
export function toSlices(
  breakdown: { categoryName: string; total: number }[],
  palette: readonly string[],
): DonutSlice[] {
  const sorted = [...breakdown].filter((b) => b.total > 0).sort((a, b) => b.total - a.total);
  if (sorted.length === 0) return [];

  const head = sorted.slice(0, TOP_N);
  const tail = sorted.slice(TOP_N);
  return [
    ...head.map((b, i) => ({ name: b.categoryName, total: b.total, color: palette[i]! })),
    ...(tail.length
      ? [{ name: `Other (${tail.length})`, total: tail.reduce((s, b) => s + b.total, 0), color: OTHER_COLOR }]
      : []),
  ];
}

export function DonutChart({ breakdown }: { breakdown: { categoryName: string; total: number }[] }) {
  const palette = useCategoricalPalette();
  const [active, setActive] = useState<string | null>(null);
  const slices = toSlices(breakdown, palette);
  if (slices.length === 0) return null;

  const total = slices.reduce((s, d) => s + d.total, 0);
  const focus = slices.find((d) => d.name === active) ?? null;
  // The centre names whichever slice is being pointed at, and the total
  // otherwise; the figure is fitted to the ring either way.
  const centerValue = formatMoney(focus ? focus.total : total);
  const circumference = 2 * Math.PI * RADIUS;
  const center = SIZE / 2;
  // No track behind the ring: the cuts between segments show the card itself,
  // which reads cleaner than a grey ring peeking through.
  const gap = slices.length > 1 ? 2.5 : 0;

  let offset = 0;

  return (
    <div
      className="grid items-center gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-8"
      onMouseLeave={() => setActive(null)}
    >
      <div className="relative mx-auto shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`-8 -8 ${SIZE + 16} ${SIZE + 16}`}
          role="presentation"
          className="overflow-visible"
        >
          {slices.map((d) => {
            const len = (d.total / total) * circumference;
            const drawn = Math.max(len - gap, 0.001);
            const isActive = active === d.name;
            const seg = (
              <circle
                key={d.name}
                cx={center}
                cy={center}
                r={RADIUS}
                fill="none"
                stroke={d.color}
                strokeWidth={isActive ? STROKE + 8 : STROKE}
                strokeDasharray={`${drawn} ${circumference - drawn}`}
                strokeDashoffset={-(offset + gap / 2)}
                transform={`rotate(-90 ${center} ${center})`}
                opacity={active && !isActive ? 0.25 : 1}
                className="cursor-pointer transition-[stroke-width,opacity] duration-200 ease-out motion-reduce:transition-none"
                onMouseEnter={() => setActive(d.name)}
              />
            );
            offset += len;
            return seg;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-content-center px-8 text-center">
          <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">
            {focus ? `${((focus.total / total) * 100).toFixed(1)}%` : "Total spent"}
          </span>
          <span
            className="figure mt-1 block font-bold leading-none text-ink-900"
            style={{ fontSize: fitLabelSize(centerValue), maxWidth: HOLE_WIDTH }}
          >
            {centerValue}
          </span>
          <span className="mx-auto mt-1.5 block max-w-[7.5rem] truncate text-xs text-ink-600">
            {focus ? focus.name : `${slices.length} ${slices.length === 1 ? "category" : "categories"}`}
          </span>
        </div>
      </div>

      {/* The legend is the accessible reading of the chart, and doubles as the
          data table: name, share and value for every slice. Each row also
          points at its slice, by pointer or keyboard focus. */}
      <ul className="w-full min-w-0 divide-y divide-paper-200">
        {slices.map((d) => {
          const share = (d.total / total) * 100;
          const isActive = active === d.name;
          return (
            <li
              key={d.name}
              tabIndex={0}
              onMouseEnter={() => setActive(d.name)}
              onFocus={() => setActive(d.name)}
              onBlur={() => setActive(null)}
              className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md px-2 py-2.5 text-[13px] outline-none transition-[background-color,opacity] focus-visible:ring-2 focus-visible:ring-brand-500 ${
                isActive ? "bg-paper-100" : ""
              } ${active && !isActive ? "opacity-50" : ""}`}
            >
              <span aria-hidden className="h-3 w-3 rounded-[4px]" style={{ background: d.color }} />
              <span className="truncate font-medium text-ink-800">{d.name}</span>
              <span className="figure w-14 text-right font-semibold text-ink-900">{share.toFixed(1)}%</span>
              <span className="figure w-24 text-right text-ink-500">{formatMoney(d.total)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
