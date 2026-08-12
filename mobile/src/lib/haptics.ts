import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/**
 * Physical feedback, given meaning.
 *
 * The point is not that taps buzz — it is that DIFFERENT OUTCOMES FEEL
 * DIFFERENT. An owner recording a sale one-handed at a counter, without
 * looking down, should be able to tell "saved" from "that was flagged" by
 * feel alone. Buzzing identically on everything would throw that away and
 * leave only the annoyance.
 *
 * So this exposes intents, not intensities. Call sites say what happened;
 * this file decides how it feels, which keeps the vocabulary consistent
 * across screens instead of every button picking its own.
 *
 * Every call is fire-and-forget and swallows its own errors. Haptics are
 * unavailable on web, absent on some Android hardware, and disabled outright
 * by a system setting on both platforms — none of which is a reason for a
 * save to fail.
 */

const supported = Platform.OS === "ios" || Platform.OS === "android";

function safely(run: () => Promise<void>): void {
  if (!supported) return;
  void run().catch(() => {
    // A phone with no haptic motor, or a user who turned them off. Neither is
    // an error, and neither should ever surface to the caller.
  });
}

/** A control was touched: a filter chip, a segmented option, a tab. */
export function tapped(): void {
  safely(() => Haptics.selectionAsync());
}

/** A real action was committed — a button press that does something. */
export function pressed(): void {
  safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** Something was saved, sent, or completed. */
export function succeeded(): void {
  safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/**
 * Something needs a second look — a flagged duplicate, a large expense, a
 * total that no longer reconciles. Distinct from `failed`: the action worked,
 * but the result deserves attention.
 */
export function warned(): void {
  safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** The action did not go through. */
export function failed(): void {
  safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

/** A destructive or irreversible step — the shutter, a delete confirmation. */
export function committed(): void {
  safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}
