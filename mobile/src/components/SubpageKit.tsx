import { useState, type ReactNode } from "react";
import { Platform, Pressable, StatusBar, View, type ViewStyle } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { CONTENT_WIDTH } from "./ContentScrollView";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";

type IconName = keyof typeof Ionicons.glyphMap;

export function SubpageHeader({ title, onBack, disabled = false, right }: {
  title: string;
  onBack: () => void;
  disabled?: boolean;
  right?: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [backFocused, setBackFocused] = useState(false);
  const focusStyle: ViewStyle = Platform.OS === "web" && backFocused
    ? { outlineColor: t.brandText, outlineWidth: 2, outlineStyle: "solid", outlineOffset: -2 }
    : {};
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: t.surfaceSunken }}>
      {focused ? <StatusBar barStyle={t.statusBarStyle === "dark" ? "dark-content" : "light-content"} backgroundColor={t.surfaceSunken} /> : null}
      <View style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onBack}
          onFocus={() => setBackFocused(true)}
          onBlur={() => setBackFocused(false)}
          style={({ pressed }) => ({ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: pressed ? t.brandSurface : "transparent", opacity: disabled ? 0.5 : 1, ...focusStyle })}
        >
          <Ionicons name="arrow-back" size={24} color={t.brandHeading} accessibilityElementsHidden importantForAccessibility="no" />
        </Pressable>
        <T accessibilityRole="header" variant="title" style={{ flex: 1, minWidth: 0, fontFamily: font.displayBold, fontSize: typeScale.subpageTitle, lineHeight: 29 }}>{title}</T>
        {right}
      </View>
    </View>
  );
}

export function SubpageIcon({ name, tone = "default" }: { name: IconName; tone?: "default" | "danger" }) {
  const t = useTheme();
  return (
    <View style={{ width: 44, height: 44, flexShrink: 0, borderRadius: radius.full, backgroundColor: tone === "danger" ? t.statusSurface.critical : t.brandBorder, alignItems: "center", justifyContent: "center" }}>
      <Ionicons name={name} size={24} color={tone === "danger" ? t.statusText.critical : t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
    </View>
  );
}

export function SubpageCard({ title, icon, tone = "default", children, style }: {
  title?: string;
  icon?: IconName;
  tone?: "default" | "mint" | "danger";
  children: ReactNode;
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <Card style={{ backgroundColor: tone === "mint" ? t.brandSurface : t.surface, borderColor: tone === "mint" ? t.brandBorder : t.border, ...style }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.md }}>
          {icon ? <SubpageIcon name={icon} tone={tone === "danger" ? "danger" : "default"} /> : null}
          <T accessibilityRole="header" variant="title" style={{ flex: 1, minWidth: 0, color: t.textPrimary }}>{title}</T>
        </View>
      ) : null}
      {children}
    </Card>
  );
}
