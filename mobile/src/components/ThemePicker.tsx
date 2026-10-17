import { Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import * as haptics from "../lib/haptics";
import { useTheme } from "../context/ThemeContext";
import { darkPalette, lightPalette, type ThemePreference } from "../theme/palette";
import { font, radius, space, typeScale } from "../theme/tokens";

/*
 * Light, Dark and Auto as three small previews of the app itself, so the
 * choice is seen rather than read. Each preview is drawn from the real
 * palettes (page, card, brand bar), never from colours picked for the picker.
 */

function Preview({ mode }: { mode: "light" | "dark" }) {
  const p = mode === "dark" ? darkPalette : lightPalette;
  return (
    <View style={{ flex: 1, backgroundColor: p.surfaceSunken, padding: 5, gap: 5 }}>
      <View style={{ width: 16, height: 4, borderRadius: 3, alignSelf: "center", backgroundColor: p.borderStrong, marginBottom: 15 }} />
      <View style={{ height: 12, borderRadius: 3, backgroundColor: p.surface }} />
      <View style={{ height: 12, borderRadius: 3, backgroundColor: p.surface }} />
      <View style={{ height: 10, borderRadius: 3, backgroundColor: p.brandSurface }} />
    </View>
  );
}

export function ThemePicker({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: ThemePreference }[];
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 340 || fontScale >= 1.5;
  return (
    <View style={{ flexDirection: stacked ? "column" : "row", gap: space.sm }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={`Appearance, ${option.label}`}
            accessibilityState={{ selected }}
            aria-pressed={selected}
            onPress={() => {
              haptics.tapped();
              onChange(option.value);
            }}
            style={({ pressed }) => ({
              flex: stacked ? undefined : 1,
              minHeight: 48,
              padding: space.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: selected ? t.brandText : "transparent",
              backgroundColor: selected ? t.brandSurface : pressed ? t.surfaceMuted : t.surfaceSunken,
              gap: space.sm,
              alignItems: "center",
            })}
          >
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 52, height: 90, borderRadius: radius.sm, overflow: "hidden", flexDirection: "row", borderWidth: 2, borderColor: option.value === "dark" ? darkPalette.borderStrong : lightPalette.textPrimary }}>
              {option.value === "system" ? (
                <>
                  <Preview mode="light" />
                  <Preview mode="dark" />
                </>
              ) : (
                <Preview mode={option.value} />
              )}
            </View>
            {selected ? <View style={{ position: "absolute", top: space.xs, right: space.xs, borderRadius: radius.full, backgroundColor: t.brandFill, padding: 3 }}><Ionicons name="checkmark" size={16} color={t.onBrandFill} accessibilityElementsHidden importantForAccessibility="no" /></View> : null}
            <T
              style={{
                textAlign: "center",
                fontSize: typeScale.label,
                fontFamily: font.sansSemibold,
                color: selected ? t.brandText : t.textSecondary,
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
