import type { RecoveryTargets } from "./types";

/**
 * Resolves the month status pill's tone, glyph and copy from the backend's
 * `status` field (Improvement Plan §8.1/§9.7), falling back to the older
 * `needsSetup`/`onTrack` booleans only when an older/cached response has no
 * `status` at all. `data_incomplete` isn't sent yet (Phase 2+) but is mapped
 * here so the switch stays exhaustive when it starts arriving.
 *
 * There is no "info" entry in this theme's status palette (`StatusKey` is
 * just good/warning/serious/critical) — states that are informational rather
 * than a warning or a success still use `status.warning`/`statusText.warning`
 * rather than inventing a new palette entry.
 */
export function resolveMonthStatus(
  data: RecoveryTargets,
): { tone: "warning" | "good" | "critical"; glyph: string; copy: string } {
  const status = data.status;
  if (status) {
    switch (status) {
      case "needs_setup":
        return { tone: "warning", glyph: "?", copy: "Recovery Target isn't ready yet" };
      case "no_current_month_data":
      case "data_incomplete":
        return { tone: "warning", glyph: "i", copy: "No sales recorded yet this month" };
      case "covered":
        return { tone: "good", glyph: "✓", copy: "Sales coverage target reached" };
      case "ahead":
        return { tone: "good", glyph: "✓", copy: "Ahead of pace" };
      case "on_pace":
        return { tone: "good", glyph: "✓", copy: "On pace for the month" };
      case "behind":
        return { tone: "critical", glyph: "!", copy: "Behind pace for the month" };
    }
  }
  // Back-compat: older/cached responses with no `status` field at all.
  if (data.needsSetup) return { tone: "warning", glyph: "?", copy: "Recovery Target isn't ready yet" };
  if (data.onTrack) return { tone: "good", glyph: "✓", copy: "On pace for the month" };
  return { tone: "critical", glyph: "!", copy: "Behind pace for the month" };
}
