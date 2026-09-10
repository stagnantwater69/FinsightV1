import { Pressable, View } from "react-native";
import { T } from "./ui";
import { PERIOD_OPTIONS, periodLabel } from "../lib/dashboardPeriod";
import { font, radius } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";

/**
 * Which window Home's figures cover — a segmented control, always on screen.
 *
 * "Always on screen" is the point. The all-time view used to be reachable only
 * from the empty-period callout, which meant an owner who took the way out of
 * an empty Home could not get back: the callout disappears once the figures
 * are non-empty, and it held the only setter. The way in and the way out are
 * the same control now, so every window is one tap from every other.
 *
 * Controlled: the days value belongs to the screen, which refetches on it.
 */
export function PeriodSelector({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  const t = useTheme();
  return (
    /*
     * No group role on this wrapper. A `radiogroup` here would have to be an
     * accessibility element to be announced at all, and that collapses the
     * four radios inside it into one unreachable blob — the trade
     * tests/accessibleElements.test.ts exists to stop. Each option already
     * announces its own full window name and checked state, which is the part
     * an owner needs.
     */
    <View
      style={{
        flexDirection: "row",
        padding: 4,
        borderRadius: radius.md,
        backgroundColor: t.surfaceMuted,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      {PERIOD_OPTIONS.map((option) => {
        const selected = value === option.days;
        return (
          <Pressable
            key={option.days}
            accessibilityRole="radio"
            accessibilityLabel={periodLabel(option.days)}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.days)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: TAP_FLOOR,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.sm,
              backgroundColor: selected ? t.surface : pressed ? t.surfaceStrong : "transparent",
            })}
          >
            <T
              variant="caption"
              style={{
                color: selected ? t.brandHeading : t.textMuted,
                fontFamily: selected ? font.sansSemibold : font.sans,
              }}
            >
              {option.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}
