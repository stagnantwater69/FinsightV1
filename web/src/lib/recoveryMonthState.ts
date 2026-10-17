import {
  AlertTriangle,
  Check,
  CircleHelp,
  Info,
  type LucideIcon,
} from "lucide-react";
import type { RecoveryStatus } from "./types";

/**
 * One of the month-status tones the meter can render — a fifth reading beyond
 * the amber/green/red triad the boolean-only contract could express. `info`
 * covers month states that are neither a warning nor a pass/fail verdict
 * (no sales yet this month; data still settling) — reusing the themed
 * `--sev-info-*` variables Alert.tsx's `info` kind already draws from, rather
 * than inventing a new palette entry.
 */
export type MonthTone = "setup" | "info" | "good" | "critical";

/** Maps the server's discriminated `status` (plan §8.1) to this meter's tone
 *  and copy. Falls back to the boolean-derived tone when `status` is absent —
 *  a cached/older response won't carry it, though the real server always
 *  does now. */
export function monthToneAndCopy(
  status: RecoveryStatus | undefined,
  onTrack: boolean,
  needsSetup: boolean | undefined,
): { tone: MonthTone; label: string; icon: LucideIcon; helper?: string } {
  switch (status) {
    case "needs_setup":
      return {
        tone: "setup",
        label: "Recovery Target isn't ready yet",
        icon: CircleHelp,
      };
    case "no_current_month_data":
      return {
        tone: "info",
        label: "No sales recorded yet this month",
        icon: Info,
      };
    // Not sent by the server yet (Phase 2+) — given the same informational
    // treatment as no_current_month_data until it is.
    case "data_incomplete":
      return {
        tone: "info",
        label: "No sales recorded yet this month",
        icon: Info,
      };
    case "covered":
      return {
        tone: "good",
        label: "Sales coverage target reached",
        icon: Check,
      };
    case "ahead":
      return { tone: "good", label: "Ahead of pace", icon: Check };
    case "on_pace":
      return { tone: "good", label: "On pace for the month", icon: Check };
    case "behind":
      return {
        tone: "critical",
        label: "Behind pace for the month",
        icon: AlertTriangle,
      };
    default:
      return needsSetup
        ? {
            tone: "setup",
            label: "Recovery Target isn't ready yet",
            icon: CircleHelp,
          }
        : onTrack
          ? { tone: "good", label: "On pace for the month", icon: Check }
          : {
              tone: "critical",
              label: "Behind pace for the month",
              icon: AlertTriangle,
            };
  }
}
