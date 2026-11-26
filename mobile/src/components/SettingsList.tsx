import { useState } from "react";
import { Platform, Pressable, Switch, View, type ViewStyle } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { TAP, font, space, typeScale } from "../theme/tokens";

/**
 * The list language More and Settings are both written in.
 *
 * WHY IT MOVED HERE. Both components were private to MoreScreen, and Settings
 * is the same screen shape one level down: groups of destinations and
 * switches, each with a medallion and a two-line explanation. Copying them
 * would have made the second copy's spacing, hairline and switch behaviour
 * free to drift from the first — which is the exact failure the chipConsistency
 * test in this project exists because of.
 */

/** A group of rows, under a heading that says what they have in common. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { textMuted } = useTheme();
  return (
    <View>
      <T
        accessibilityRole="header"
        style={{
          color: textMuted,
          fontSize: typeScale.caption,
          fontFamily: font.sansSemibold,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginBottom: space.sm,
          marginLeft: space.xs,
        }}
      >
        {title}
      </T>
      <Card style={{ paddingVertical: space.xs }}>{children}</Card>
    </View>
  );
}

export function Row({
  icon,
  label,
  detail,
  onPress,
  first,
  /**
   * Signing out is the one row that ends something rather than opening
   * something, and it is the only one an accidental tap costs anything.
   */
  destructive,
  /**
   * Turns the row into a setting rather than a destination: the chevron is
   * replaced by a Switch and the row announces itself as a switch.
   *
   * WHY THE SWITCH IS NOT THE CONTROL. It is rendered inside a
   * Non-interactive wrapper, so the whole row — icon, label,
   * explanation and switch — is one 52-point target driven by the row's own
   * `onPress`. Letting the Switch handle its own touches as well would mean
   * two things to tap that do the same job, with a real risk of the press
   * firing twice, and would shrink the reliable target to the switch itself.
   * This keeps one control, one state, and the roomy target a phone wants.
   *
   * Extended here rather than as a second, parallel row component so the
   * spacing, the medallion, the two-line explanation and the hairline stay
   * exactly what every other row in these screens uses.
   */
  toggle,
  expandedDetail = false,
  disabled = false,
  focusRingColor,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail?: string;
  onPress: () => void;
  first?: boolean;
  destructive?: boolean;
  toggle?: { value: boolean };
  /** Give settings explanations their own full-width, wrapping line. */
  expandedDetail?: boolean;
  disabled?: boolean;
  focusRingColor?: string;
}) {
  const [focused, setFocused] = useState(false);
  const focusStyle: ViewStyle = Platform.OS === "web" && focusRingColor && focused
    ? { outlineColor: focusRingColor, outlineWidth: 2, outlineStyle: "solid", outlineOffset: -2 }
    : {};
  const { brand, ink, paper, statusText, textSecondary } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      onFocus={focusRingColor ? () => setFocused(true) : undefined}
      onBlur={focusRingColor ? () => setFocused(false) : undefined}
      disabled={disabled}
      accessibilityRole={toggle ? "switch" : "button"}
      accessibilityState={toggle ? { checked: toggle.value, disabled } : { disabled }}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      style={({ pressed }) => ({
        flexDirection: "row",
        flexWrap: expandedDetail ? "wrap" : "nowrap",
        alignItems: "center",
        gap: space.md,
        rowGap: expandedDetail ? space.sm : space.md,
        minHeight: TAP + 8,
        paddingVertical: expandedDetail ? space.md : space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
        backgroundColor: pressed ? paper[100] : "transparent",
        opacity: disabled ? 0.6 : 1,
        ...focusStyle,
      })}
    >
      {/* Plain glyph in one colour: no tinted backing, no per-row hue. */}
      <Ionicons name={icon} size={22} color={destructive ? statusText.critical : textSecondary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T
          style={{
            fontSize: typeScale.body,
            color: destructive ? statusText.critical : ink[900],
            fontFamily: destructive || expandedDetail ? font.sansSemibold : font.sans,
          }}
        >
          {label}
        </T>
        {/*
          Two lines, not one. These descriptions are the only thing telling a
          first-time owner what sits behind a word like "Privacy", and
          truncating them at one line cut most of them mid-sentence.
        */}
        {detail && !expandedDetail ? (
          <T variant="caption" style={{ marginTop: 1 }}>
            {detail}
          </T>
        ) : null}
      </View>
      {toggle ? (
        <View style={{ pointerEvents: "none" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Switch
            accessible={false}
            value={toggle.value}
            disabled={disabled}
            // Purely a state display — the row handles the press. See above.
            onValueChange={onPress}
            trackColor={{ false: ink[200], true: brand[600] }}
            thumbColor={paper.DEFAULT}
            ios_backgroundColor={ink[200]}
          />
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={ink[300]} />
      )}
      {detail && expandedDetail ? (
        <T style={{ width: "100%", fontSize: typeScale.bodySm, lineHeight: 21 }}>
          {detail}
        </T>
      ) : null}
    </Pressable>
  );
}
