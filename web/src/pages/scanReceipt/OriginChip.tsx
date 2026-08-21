import { ORIGIN_CHIP } from "./constants";
import type { Origin } from "./types";

export function OriginChip({ origin }: { origin: Origin }) {
  const spec = ORIGIN_CHIP[origin];
  if (!spec) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${spec.tone}`}
    >
      <span aria-hidden>{origin === "missing" ? "⚠" : "✦"}</span>
      {spec.label}
    </span>
  );
}
