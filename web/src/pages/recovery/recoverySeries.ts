import type {
  DailyCoverageRow,
  RecoveryCheckpoint,
  RecoveryReportingPeriod,
} from "../../lib/types";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

export function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface CumulativePoint {
  date: string;
  /** Running sales total; null for days after the as-of date. */
  sales: number | null;
  /** Running target total. */
  target: number;
  /** True when `target` is interpolated rather than summed from the server's daily allocation. */
  estimated: boolean;
}

/**
 * Running sales and target totals across the selected period.
 *
 * The server's daily rows stop at the as-of date. Past that, the target line
 * is drawn straight between the known anchors: any future weekly checkpoint
 * (an exact server figure) and the period target on its last day. Those days
 * carry `estimated: true` so the tooltip can say so.
 */
export function buildCumulativeSeries(
  daily: DailyCoverageRow[],
  period: Pick<RecoveryReportingPeriod, "start" | "end" | "target" | "isComplete">,
  checkpoints: RecoveryCheckpoint[] = [],
): CumulativePoint[] {
  const rows = daily
    .filter((d) => d.date >= period.start && d.date <= period.end)
    .sort((a, b) => a.date.localeCompare(b.date));

  const points: CumulativePoint[] = [];
  let sales = 0;
  let target = 0;
  for (const row of rows) {
    sales += row.sales;
    target += row.neededTarget ?? 0;
    points.push({ date: row.date, sales, target, estimated: false });
  }

  if (period.isComplete) return points;

  const lastDate = points.at(-1)?.date ?? addDays(period.start, -1);
  const anchors = checkpoints
    .filter((c) => c.endDate > lastDate && c.endDate < period.end)
    .map((c) => ({ date: c.endDate, value: c.cumulativeTarget }));
  anchors.push({ date: period.end, value: Math.max(period.target, target) });

  let from = { date: lastDate, value: target };
  for (const anchor of anchors) {
    const span = daysBetween(from.date, anchor.date);
    for (let step = 1; step <= span; step += 1) {
      points.push({
        date: addDays(from.date, step),
        sales: null,
        target: from.value + ((anchor.value - from.value) * step) / span,
        estimated: true,
      });
    }
    from = anchor;
  }
  return points;
}
