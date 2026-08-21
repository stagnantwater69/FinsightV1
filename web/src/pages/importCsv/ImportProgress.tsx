import { SkeletonLine } from "../../components/Skeleton";
import type { CsvImportStatus } from "../../lib/types";

/**
 * A running import, as the owner sees it.
 *
 * Two states, and the difference between them matters: before the first status
 * response there is no measurement, so there is no bar. Drawing an empty one
 * and calling it 0% would be the same lie as an indeterminate bar that fills
 * on a timer.
 */
export function ImportProgress({
  progress,
  totalRows,
}: {
  progress: CsvImportStatus | null;
  totalRows: number;
}) {
  const total = progress?.totalRows || totalRows;
  const processed = progress?.processedRows ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  if (!progress) {
    return (
      <div aria-busy="true" className="space-y-3 rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm">
        <p aria-live="polite" className="text-sm font-medium text-ink-700">
          Importing your records…
        </p>
        <p className="text-xs text-ink-500">
          FinSight is validating every row before it writes any of them.
        </p>
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-2/3" />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p aria-live="polite" className="text-sm font-medium text-ink-700">
          Importing your records…
        </p>
        <p className="figure text-sm text-ink-600">
          {processed.toLocaleString()} of {total.toLocaleString()} rows
        </p>
      </div>
      {/*
        `motion-safe:` on the width transition, not on the bar itself — the bar
        must still move for someone who asked for reduced motion, it just
        should not glide.
      */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
        aria-valuetext={`${processed} of ${total} rows imported`}
        className="h-2 w-full overflow-hidden rounded-full bg-paper-200"
      >
        <div
          className="h-full rounded-full bg-brand-600 motion-safe:transition-[width] motion-safe:duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-ink-500">
        This file is large enough that FinSight is importing it in the background. You can leave this
        page — the import finishes either way.
      </p>
    </div>
  );
}
