import { Pressable, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
  const { brand } = useTheme();
  return (
    <View>
      <T
        variant="heading"
        accessibilityRole="header"
        style={{ color: brand[900], marginBottom: space.sm }}
      >
        {title}
      </T>
      <Card>{children}</Card>
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
   * `pointerEvents="none"` wrapper, so the whole row — icon, label,
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
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail?: string;
  onPress: () => void;
  first?: boolean;
  destructive?: boolean;
  toggle?: { value: boolean };
}) {
  const { brand, ink, paper, statusText, statusSurface, brandSurface } = useTheme();
  const tint = destructive ? statusText.critical : brand[700];
  /*
   * THE DESTRUCTIVE MEDALLION'S WASH, from the palette rather than a literal.
   *
   * `#fdecec` was a third independent red surface beside the two that
   * ui.tsx already consolidated into `statusSurface.critical` — a percent
   * apart in Light, and in Dark a near-white plate under near-white ink,
   * because a hard-coded hex cannot invert. It is the same wash the app uses
   * behind every other critical thing, and now it says so.
   */
  const surface = destructive ? statusSurface.critical : brandSurface;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={toggle ? "switch" : "button"}
      accessibilityState={toggle ? { checked: toggle.value } : undefined}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: TAP + 8,
        paddingVertical: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
        backgroundColor: pressed ? paper[100] : "transparent",
      })}
    >
      {/*
        Circular rather than the rounded square it was. A squircle reads as an
        app icon — a thing you launch — and every one of these opens a screen
        inside FinSight.
      */}
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          backgroundColor: surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={19} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <T
          style={{
            fontSize: typeScale.body,
            color: destructive ? statusText.critical : ink[900],
            fontFamily: destructive ? font.sansSemibold : font.sans,
          }}
        >
          {label}
        </T>
        {/*
          Two lines, not one. These descriptions are the only thing telling a
          first-time owner what sits behind a word like "Privacy", and
          truncating them at one line cut most of them mid-sentence.
        */}
        {detail ? (
          <T variant="caption" numberOfLines={2} style={{ marginTop: 1, lineHeight: 16 }}>
            {detail}
          </T>
        ) : null}
      </View>
      {toggle ? (
        <View pointerEvents="none">
          <Switch
            value={toggle.value}
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
    </Pressable>
  );
}
