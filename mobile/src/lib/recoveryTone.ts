import type { DailyCoverageStatus, DayStatus } from "./types";

/**
 * The single below/at/above(+closed) → tone mapping shared by RecoveryMeter's
 * "Today" panel and RecoveryTargetScreen's day-by-day rows. Both used to
 * re-derive this ternary chain independently (`RecoveryMeter.tsx` for
 * `todaysStatus`, `RecoveryTargetScreen.tsx`'s `DailyCoverageRows` for each
 * `DailyCoverageRow.status`), which meant a change to one could silently
 * drift from the other. Returns a tone KEY, not a colour — callers still pick
 * their own colour set (`statusText`, `status` fill, or `statusSurface`)
 * since those differ by call site.
 */
export function dayStatusTone(status: DailyCoverageStatus | DayStatus): "good" | "warning" | "critical" | "muted" {
  switch (status) {
    case "closed":
      return "muted";
    case "below":
      return "critical";
    case "at":
      return "warning";
    case "above":
    default:
      return "good";
  }
}
