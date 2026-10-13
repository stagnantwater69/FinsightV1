import { ORIGIN_CHIP } from "./constants";
import type { Origin } from "./types";

export function OriginChip({ origin }: { origin: Origin }) {
  const spec = ORIGIN_CHIP[origin];
  if (!spec) return null;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${spec.tone}`}
    >
      <span aria-hidden className="shrink-0">{origin === "missing" ? "⚠" : "✦"}</span>
      <span className="min-w-0 break-words">{spec.label}</span>
    </span>
  );
}
