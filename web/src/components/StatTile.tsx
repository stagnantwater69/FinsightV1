/**
 * A single headline figure.
 *
 * `value` is pre-formatted by `formatMoney`, and rendered with the `.figure`
 * treatment so every stat on a row shares one digit width and the numbers line
 * up vertically instead of drifting.
 *
 * `emphasis` is for the primacy slot on the dashboard (available funds) — a
 * slightly heavier surface so the eye lands there first, without resorting to
 * the accent colour, which is reserved.
 */
export function StatTile({
  label,
  value,
  sublabel,
  emphasis = false,
}: {
  label: string;
  value: string;
  sublabel?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-2xl p-5 shadow-sm ring-1 ${
        emphasis ? "bg-tint-brand ring-edge-brand" : "bg-paper ring-paper-200"
      }`}
    >
      <p className={`text-xs font-medium uppercase tracking-wide ${emphasis ? "text-brand-700" : "text-ink-500"}`}>
        {label}
      </p>
      <p
        className={`figure mt-1 break-words text-2xl font-semibold ${emphasis ? "text-ink-900" : "text-ink-900"}`}
      >
        {value}
      </p>
      {sublabel ? <p className="mt-1 text-xs text-ink-400">{sublabel}</p> : null}
    </div>
  );
}
