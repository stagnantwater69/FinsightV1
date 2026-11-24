import { isAxiosError } from "axios";

/**
 * Runs one SUPPLEMENTARY fetch in a way that cannot take the page down with it.
 *
 * This page draws from several endpoints, and it used to await them in a
 * single `Promise.all`. `Promise.all` is all-or-nothing: one rejection
 * discarded the four responses that had already arrived, so a disabled
 * `/insights/recurring-schedules` — an optional panel at the very bottom —
 * replaced the KPI row, every chart, the category table and the flags with an
 * error banner. A transient 500 on `/insights/findings` would have done exactly
 * the same thing, which is why the fix is structural rather than a check for
 * status 404: nothing here asks WHY a supplement failed, only that its failure
 * stays inside its own panel. Status-sniffing would have left the identical
 * defect in place for every other failure mode.
 *
 * The composite expense-overview read deliberately does NOT go through this.
 * Without its behavior panel there is no page to degrade, so that panel's
 * failure is still the page's error.
 */
export async function loadPanel<T>(
  request: Promise<{ data: T }>,
  apply: (value: T) => void,
  onUnavailable: (error: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const value = (await request).data;
    // A superseded request must not write anything: the panel belongs to the
    // business profile that is on screen NOW, not the one this was asked for.
    if (signal?.aborted) return;
    apply(value);
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") return;
    // Swallowed on purpose. The panel's own state now says "unavailable", and
    // an error banner for a secondary panel over a page that rendered fine
    // would be telling the owner their numbers are suspect when they are not.
    onUnavailable(error);
  }
}

export type SupplementState = "loading" | "ready" | "stale" | "unavailable";

export function failedSupplementState(current: SupplementState): SupplementState {
  return current === "ready" || current === "stale" ? "stale" : "unavailable";
}

export function combinedSupplementState(states: readonly SupplementState[]): SupplementState {
  if (states.some((state) => state === "unavailable")) return "unavailable";
  if (states.some((state) => state === "stale")) return "stale";
  if (states.some((state) => state === "loading")) return "loading";
  return "ready";
}

export function isDefinitiveScheduleUnavailable(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}
