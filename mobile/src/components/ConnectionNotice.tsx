import { View, type ViewStyle } from "react-native";
import { Button, T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";
import { lastUpdatedLine, type LoadNotice } from "../lib/connectionState";

/**
 * The one banner the whole app uses when a request did not come back.
 *
 * WHY THIS IS A COMPONENT AND NOT SIX COPIES. Before it, a failed load was an
 * `ErrorNote` on Home, an `ErrorNote` on Records, nothing at all on the
 * cashflow card, and a raw sentence elsewhere — none of which offered a retry,
 * and none of which said whether the figures underneath were still worth
 * reading. The words come from `lib/connectionState.ts`, which is where the
 * honesty constraint lives; this file only paints them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It has no opinion about connectivity in
 * general — it is not a "you are offline" chrome bar that sits at the top of
 * the app watching a radio. It reports the outcome of a request a screen
 * actually made. See the header of `lib/connectionState.ts` for why that is
 * the narrower and more truthful claim.
 *
 * SEVERITY IS NEVER COLOUR ALONE: every notice carries a glyph, a written
 * title and a sentence, per the plan's rule for financial states.
 */
export function ConnectionNotice({
  notice,
  onRetry,
  busy,
  style,
}: {
  notice: LoadNotice | null;
  /** Omitted where the screen has no retry to offer — the words still stand. */
  onRetry?: () => void;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const t = useTheme();
  if (!notice) return null;

  const family = notice.tone === "error" ? "critical" : "warning";
  const surface = t.statusSurface[family];
  const border = t.statusBorder[family];
  const ink = t.statusText[family];

  return (
    <View
      style={[
        {
          backgroundColor: surface,
          borderColor: border,
          borderWidth: 1,
          borderRadius: radius.md,
          padding: space.md,
          gap: space.sm,
        },
        style,
      ]}
      /*
       * `assertive` only when the screen has nothing to show. A stale-data
       * warning that interrupts whatever a reader is part-way through is worse
       * than the staleness it reports; a blank screen with no explanation is
       * the case worth interrupting for.
       */
      accessibilityLiveRegion={notice.kind === "cannot-load" ? "assertive" : "polite"}
      /*
       * NOT `accessible`, unlike ui.tsx's ErrorNote and the progress bars.
       * The rule is that a View's role only surfaces once it is an
       * accessibility element — but making THIS one an element would fold the
       * retry Button below into the container's label and take the only way
       * out of the error state away from a screen-reader user. The live region
       * is what does the announcing here; the role is left as the honest
       * description of the container for platforms that read it.
       */
      accessibilityRole="alert"
    >
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {/*
          Decorative: the title says the same thing in words, and a reader
          announcing "warning sign" before it is noise rather than information.
        */}
        <T
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: ink, fontSize: typeScale.label, fontFamily: font.sansSemibold }}
        >
          {notice.tone === "error" ? "✕" : "⚠"}
        </T>
        <View style={{ flex: 1, gap: 2 }}>
          <T style={{ color: ink, fontSize: typeScale.label, fontFamily: font.sansSemibold }}>{notice.title}</T>
          <T style={{ color: ink, fontSize: typeScale.label, lineHeight: 19 }}>{notice.body}</T>
        </View>
      </View>
      {onRetry ? (
        <Button title={notice.retryLabel} variant="secondary" onPress={onRetry} loading={busy} />
      ) : null}
    </View>
  );
}

/**
 * "Updated 5 minutes ago", in one wording across every screen that shows it.
 *
 * WHY IT IS SHOWN AT ALL rather than only when something is wrong: a figure
 * with no timestamp is trusted as current, and on a phone that has been in a
 * pocket since breakfast it may not be. The plan asks for stale data to be
 * treated visibly; a permanent, quiet caption is the version of that which
 * does not cry wolf.
 *
 * `now` is passed in rather than read here so the caller controls how often
 * the phrase re-renders — this component does not tick on its own, and a
 * caption that silently stops at "just now" for an hour would be worse than
 * none. Callers pass a value that changes when they refetch.
 */
export function LastUpdated({ at, now, style }: { at: number | null | undefined; now: number; style?: ViewStyle }) {
  const line = lastUpdatedLine(at, now);
  if (!line) return null;
  return (
    <View style={style}>
      <T variant="caption">{line}</T>
    </View>
  );
}
