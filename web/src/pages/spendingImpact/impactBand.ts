import type { ImpactBand } from "../../lib/types";

/** Each impact band's colour, from the themed status tones. */
export const BAND_COLOR: Record<ImpactBand, string> = {
  "Low Impact": "rgb(var(--tone-brand))",
  "Noticeable Impact": "rgb(var(--tone-accent))",
  "High Impact": "rgb(var(--tone-danger))",
};

/** Space kept between two zone labels, in pixels. */
export const ZONE_LABEL_GAP = 8;

/**
 * Left edges, in pixels, for labels laid along a band of `bandWidth`. Each
 * label is centred on its point where there is room, pushed right past the
 * one before it where there is not, and kept inside the band. A label that
 * still cannot fit is hidden (null). When labels collide the last one, which
 * marks the highest zone, wins over the ones before it, except the first.
 */
export function placeZoneLabels(
  bandWidth: number,
  labels: readonly { center: number; width: number }[],
): (number | null)[] {
  const place = (shown: readonly boolean[]) => {
    let right = -ZONE_LABEL_GAP;
    return labels.map((label, index) => {
      if (!shown[index]) return null;
      const min = right + ZONE_LABEL_GAP;
      const left = Math.min(Math.max(label.center - label.width / 2, min, 0), bandWidth - label.width);
      if (left < min) return null;
      right = left + label.width;
      return left;
    });
  };
  const all = labels.map(() => true);
  let placed = place(all);
  // Drop middle labels, nearest the end first, until the last one fits.
  for (let drop = labels.length - 2; drop > 0 && placed.at(-1) === null; drop--) {
    all[drop] = false;
    placed = place(all);
  }
  return placed;
}

