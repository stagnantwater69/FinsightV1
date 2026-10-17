import type { ReactNode } from "react";

/**
 * The one tooltip every chart uses: a dark card with a title and one row per
 * series, each row led by its series' colour so the reading matches the mark
 * without relying on colour alone (the row is also named).
 */
export function ChartTooltip({
  title,
  rows,
  footer,
}: {
  title: ReactNode;
  rows: { label: ReactNode; value: ReactNode; color?: string; strong?: boolean }[];
  footer?: ReactNode;
}) {
  return (
    <div className="min-w-[11rem] rounded-xl bg-ink-900 px-3.5 py-2.5 text-paper shadow-lg ring-1 ring-black/5">
      <p className="text-[11.5px] font-semibold text-paper/80">{title}</p>
      <dl className="mt-1.5 space-y-1 text-[12.5px]">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center justify-between gap-5">
            <dt className="flex items-center gap-1.5 text-paper/75">
              {row.color ? (
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
              ) : null}
              {row.label}
            </dt>
            <dd className={`figure ${row.strong ? "font-bold" : "font-semibold"} text-paper`}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {footer ? <div className="mt-1.5 border-t border-paper/15 pt-1.5 text-[11.5px] text-paper/75">{footer}</div> : null}
    </div>
  );
}
