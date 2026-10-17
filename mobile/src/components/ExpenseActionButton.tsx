import { Pressable, type ViewStyle } from "react-native";
import { T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";

export function ExpenseActionButton({ title, onPress, variant = "brand", accessibilityLabel = title, style }: {
  title: string;
  onPress: () => void;
  variant?: "brand" | "primary" | "secondary" | "danger";
  accessibilityLabel?: string;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const backgroundColor = variant === "danger" ? t.statusSolid.critical : variant === "primary" ? t.ACCENT.fill : variant === "brand" ? t.brandFill : t.surface;
  const color = variant === "danger" ? t.textOnFill : variant === "primary" ? t.ACCENT.onFill : variant === "brand" ? t.onBrandFill : t.brandText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => { haptics.pressed(); onPress(); }}
      style={({ pressed }) => [{
        minHeight: TAP_FLOOR,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        justifyContent: "center",
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: variant === "secondary" ? t.brandText : "transparent",
        backgroundColor,
        opacity: pressed ? 0.8 : 1,
      }, style]}
    >
      <T style={{ textAlign: "center", fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, lineHeight: 20, color }}>{title}</T>
    </Pressable>
  );
}
