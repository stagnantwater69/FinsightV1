import type { ImpactBand } from "../../lib/types";
import { formatMoney } from "../../components/Money";
import { useLayoutEffect, useRef, useState } from "react";
import { BAND_COLOR, placeZoneLabels } from "./impactBand";

/**
 * Pictures for the Spending Impact page. Every figure they draw is also
 * printed as text beside them, so each one is aria-hidden or carries a full
 * text alternative, and none of them is the only place a number appears.
 */


const ZONES = [
  { key: "low", label: "Low", fill: "bg-tone-brand/35", ink: "text-tone-brand" },
  { key: "noticeable", label: "Noticeable", fill: "bg-tone-accent/40", ink: "text-tone-accent" },
  { key: "high", label: "High", fill: "bg-tone-danger/40", ink: "text-tone-danger" },
] as const;

/**
 * The impact zones laid under the amount slider, in pesos. The owner can see
 * where "noticeable" and "high" begin before dragging into them. Padded by
 * half a thumb on each side so the zone edges line up with the slider's own
 * travel, not with the edges of its box.
 */
export function ZoneBand({
  max,
  noticeableAmount,
  highAmount,
}: {
  max: number;
  noticeableAmount: number;
  highAmount: number;
}) {
  const at = (v: number) => Math.min(100, Math.max(0, (v / Math.max(max, 1)) * 100));
  const widths = [at(noticeableAmount), at(highAmount) - at(noticeableAmount), 100 - at(highAmount)];
  const labels = [
    { text: ZONES[0].label, at: 0, ink: ZONES[0].ink, figure: false },
    { text: formatMoney(noticeableAmount), at: at(noticeableAmount), ink: ZONES[1].ink, figure: true },
    { text: formatMoney(highAmount), at: at(highAmount), ink: ZONES[2].ink, figure: true },
  ];

  /*
   * The labels are placed by their measured widths: when the zones start close
   * together ("PHP 3,880" and "PHP 9,700" on a PHP 61,000 slider) percentage
   * positions alone print one figure over the other.
   */
  const bandRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [lefts, setLefts] = useState<(number | null)[] | null>(null);
  useLayoutEffect(() => {
    const band = bandRef.current;
    if (!band) return;
    const measure = () => {
      const bandWidth = band.clientWidth;
      // Nothing to measure (hidden, or a test DOM): keep the percentage layout.
      if (bandWidth === 0) return setLefts(null);
      setLefts(placeZoneLabels(bandWidth, labels.map((label, index) => {
        const width = labelRefs.current[index]?.offsetWidth ?? 0;
        return { center: index === 0 ? width / 2 : (label.at / 100) * bandWidth, width };
      })));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(band);
    return () => observer?.disconnect();
    // labels is rebuilt each render from these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [max, noticeableAmount, highAmount]);

  return (
    <div aria-hidden className="px-3">
      <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {ZONES.map((zone, i) =>
          widths[i]! > 0 ? (
            <div key={zone.key} className={`h-full ${zone.fill}`} style={{ width: `${widths[i]}%` }} />
          ) : null,
        )}
      </div>
      <div ref={bandRef} className="relative mt-1 h-4 text-[10.5px] font-semibold">
        {labels.map((label, index) => {
          // A zone that starts past the slider's end has nothing to label.
          if (index > 0 && label.at >= 100) return null;
          const left = lefts?.[index];
          // A label with no room stays in the DOM, invisible, so it can be measured again on resize.
          return (
            <span
              key={index}
              ref={(node) => { labelRefs.current[index] = node; }}
              className={`absolute whitespace-nowrap ${label.figure ? "figure" : ""} ${label.ink} ${
                lefts || index === 0 ? "" : "-translate-x-1/2"} ${lefts && left === null ? "invisible" : ""}`}
              style={{ left: lefts ? `${left ?? 0}px` : `${label.at}%` }}
            >
              {label.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The slip's measure: the whole bar is the available funds, the filled part
 * is this purchase, and the two ticks mark where noticeable and high impact
 * start. A purchase larger than the funds fills the bar and runs off its end.
 */
export function SlipMeter({
  percent,
  noticeableAt,
  highAt,
  band,
}: {
  percent: number;
  noticeableAt: number;
  highAt: number;
  band: ImpactBand;
}) {
  const fill = Math.min(Math.max(percent, 0), 100);
  const tick = (v: number) => Math.min(100, Math.max(0, v));
  return (
    <div aria-hidden className="relative pt-4">
      {[noticeableAt, highAt].map((v, i) => (
        <span
          key={i}
          className={`figure absolute top-0 -translate-x-1/2 text-[10px] font-semibold ${i === 0 ? "text-tone-accent" : "text-tone-danger"}`}
          style={{ left: `${tick(v)}%` }}
        >
          {Math.round(v)}%
        </span>
      ))}
      <div className="relative h-3 rounded-sm bg-paper-200">
        <div
          className={`h-full rounded-sm transition-[width] duration-300 ease-out ${percent > 100 ? "rounded-r-none" : ""}`}
          style={{
            width: `${fill > 0 ? Math.max(fill, 1.5) : 0}%`,
            backgroundColor: BAND_COLOR[band],
            backgroundImage:
              "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.18) 0 4px, transparent 4px 8px)",
          }}
        />
        {[noticeableAt, highAt].map((v, i) => (
          <span
            key={i}
            className="absolute -top-1 h-5 w-px bg-ink-700"
            style={{ left: `${tick(v)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Where the planned amount sits among what this owner has actually paid:
 * the band is their smallest-to-largest range, the tick is what they usually
 * pay, the dot is this purchase. Drawn on its own scale so a far-above amount
 * visibly leaves the band.
 */
export function PriceRangeStrip({
  smallest,
  largest,
  typical,
  planned,
}: {
  smallest: number;
  largest: number;
  typical: number;
  planned: number | null;
}) {
  const lo = Math.min(smallest, planned ?? smallest) * 0.9;
  const hi = Math.max(largest, planned ?? largest) * 1.05;
  const span = Math.max(hi - lo, 1);
  const at = (v: number) => ((v - lo) / span) * 100;

  return (
    <div aria-hidden className="pt-6">
      <div className="relative h-2.5 rounded-full bg-paper-200">
        <div
          className="absolute inset-y-0 rounded-full bg-tone-info/35"
          style={{ left: `${at(smallest)}%`, width: `${Math.max(at(largest) - at(smallest), 1)}%` }}
        />
        <span
          className="absolute -top-1.5 h-[1.375rem] w-0.5 rounded-full bg-ink-700"
          style={{ left: `calc(${at(typical)}% - 1px)` }}
        />
        <span
          className="figure absolute -top-6 -translate-x-1/2 whitespace-nowrap text-[10.5px] font-semibold text-ink-600"
          style={{ left: `${at(typical)}%` }}
        >
          usual
        </span>
        {planned !== null ? (
          <span
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tone-accent ring-[3px] ring-paper"
            style={{ left: `${at(planned)}%` }}
          />
        ) : null}
      </div>
      {/* Each label sits under the point it names, so a purchase far beyond
          the range is visibly far beyond it. A label that would collide with
          the purchase's is dropped; its value is in the sentence below. */}
      <div className="relative mt-2 h-4 text-[11px] text-ink-500">
        <span className="figure absolute whitespace-nowrap" style={{ left: `${at(smallest)}%` }}>
          {formatMoney(smallest)}
        </span>
        {planned === null || Math.abs(at(planned) - at(largest)) > 18 ? (
          <span
            className="figure absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${Math.min(at(largest), 92)}%` }}
          >
            {formatMoney(largest)}
          </span>
        ) : null}
        {planned !== null ? (
          <span
            className={`absolute whitespace-nowrap font-semibold text-tone-accent ${at(planned) > 80 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${at(planned)}%` }}
          >
            this purchase
          </span>
        ) : null}
      </div>
    </div>
  );
}
