import type { ImpactBand } from "../../lib/types";

/** Each impact band's colour, from the themed status tones. */
export const BAND_COLOR: Record<ImpactBand, string> = {
  "Low Impact": "rgb(var(--tone-brand))",
  "Noticeable Impact": "rgb(var(--tone-accent))",
  "High Impact": "rgb(var(--tone-danger))",
};

