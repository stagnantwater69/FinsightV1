import { StyleSheet, View, type ViewStyle } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "../context/ThemeContext";
import { radius } from "../theme/tokens";

export type KpiWatermarkIcon = keyof typeof Ionicons.glyphMap;

export function KpiWatermark({ name, size = 112, borderRadius = radius.lg, color, opacity }: {
  name: KpiWatermarkIcon;
  size?: number;
  borderRadius?: ViewStyle["borderRadius"];
  color?: string;
  opacity?: number;
}) {
  const t = useTheme();
  return (
    <View
      accessible={false}
      aria-hidden={true}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`kpi-watermark-${name}`}
      style={[StyleSheet.absoluteFill, { borderRadius, overflow: "hidden", pointerEvents: "none" }]}
    >
      <View style={{ position: "absolute", right: -size * 0.12, bottom: -size * 0.16, width: size, height: size, alignItems: "center", justifyContent: "center", opacity: opacity ?? (t.mode === "dark" ? 0.055 : 0.045), transform: [{ rotate: "-12deg" }] }}>
        <Ionicons name={name} size={size} color={color ?? t.brandHeading} allowFontScaling={false} accessible={false} />
      </View>
    </View>
  );
}
