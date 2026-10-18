import { SkeletonLine } from "../../components/Skeleton";
import { Money } from "../../components/Money";
import { IconCheck } from "../../components/icons";
import { SCAN_STAGES, STAGE_LABELS } from "./constants";
import type { ReceiptLocalPreview, ScanStage } from "./types";

/**
 * The wait, told honestly.
 *
 * A list of named stages with a done/doing/waiting state each, rather than a
 * bar. The owner can see which part is slow, and nothing on screen claims to
 * know how much longer it will take — because nothing here does.
 *
 * Once the photo itself has been read, its headline fields appear below the
 * stages while the second check runs. They are labelled as provisional and
 * carry no actions: nothing can be saved until the read has finished.
 */
export function ScanProgress({ stage, earlyReading = null }: { stage: ScanStage; earlyReading?: ReceiptLocalPreview | null }) {
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
                {done ? <IconCheck className="h-3 w-3" /> : i + 1}
              </span>
              <span className={done ? "text-ink-600" : active ? "font-medium text-ink-800" : "text-ink-600"}>
                {STAGE_LABELS[s]}
              </span>
              <span className="sr-only">
                {done ? ", done" : active ? ", in progress" : ", waiting"}
              </span>
            </li>
          );
        })}
      </ol>
      {earlyReading ? (
        <section aria-label="Early reading" className="rounded-lg border border-paper-200 bg-paper p-3">
          <p className="text-xs font-semibold text-ink-700">Read from your photo so far</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-500">Store</dt>
            <dd className="min-w-0 truncate text-ink-800">{earlyReading.vendor ?? "Not read yet"}</dd>
            <dt className="text-ink-500">Date</dt>
            <dd className="text-ink-800">
              {earlyReading.date ? <time dateTime={earlyReading.date}>{earlyReading.date}</time> : "Not read yet"}
            </dd>
            <dt className="text-ink-500">Total</dt>
            <dd className="text-ink-800">{earlyReading.amount !== null ? <Money value={earlyReading.amount} decimals /> : "Not read yet"}</dd>
          </dl>
          <p className="mt-2 text-xs text-ink-500">Still being checked. These can change before you review them.</p>
        </section>
      ) : (
        <>
          <SkeletonLine className="w-2/3" />
          <SkeletonLine className="w-full" />
        </>
      )}
    </div>
  );
}
