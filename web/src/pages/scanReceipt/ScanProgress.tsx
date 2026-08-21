import { SkeletonLine } from "../../components/Skeleton";
import { SCAN_STAGES, STAGE_LABELS } from "./constants";
import type { ScanStage } from "./types";

/**
 * The wait, told honestly.
 *
 * A list of named stages with a done/doing/waiting state each, rather than a
 * bar. The owner can see which part is slow, and nothing on screen claims to
 * know how much longer it will take — because nothing here does.
 */
export function ScanProgress({ stage }: { stage: ScanStage }) {
  const current = SCAN_STAGES.indexOf(stage);
  return (
    <div aria-busy="true" className="space-y-3 rounded-xl bg-paper-100 p-4">
      <p aria-live="polite" className="text-xs font-medium text-ink-600">
        {STAGE_LABELS[stage]}…
      </p>
      <ol className="space-y-1.5">
        {SCAN_STAGES.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                  done
                    ? "bg-tint-brand text-tone-brand ring-1 ring-edge-brand"
                    : active
                      ? "bg-brand-600 text-white motion-safe:animate-pulse"
                      : "bg-paper-200 text-ink-400"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={done ? "text-ink-500" : active ? "font-medium text-ink-800" : "text-ink-400"}>
                {STAGE_LABELS[s]}
              </span>
              <span className="sr-only">
                {done ? " — done" : active ? " — in progress" : " — waiting"}
              </span>
            </li>
          );
        })}
      </ol>
      <SkeletonLine className="w-2/3" />
      <SkeletonLine className="w-full" />
    </div>
  );
}
