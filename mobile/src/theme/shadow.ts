import { Platform, processColor, type ViewStyle } from "react-native";

type ShadowOptions = {
  color: string;
  opacity: number;
  offsetY: number;
  blurRadius: number;
  elevation: number;
  offsetX?: number;
};

export function shadowStyle({ color, opacity, offsetX = 0, offsetY, blurRadius, elevation }: ShadowOptions): ViewStyle {
  if (Platform.OS === "web") {
    const normalized = processColor(color);
    const rgba = typeof normalized === "number"
      ? `rgba(${(normalized >>> 16) & 255}, ${(normalized >>> 8) & 255}, ${normalized & 255}, ${((normalized >>> 24) / 255) * opacity})`
      : color;
    return { boxShadow: `${offsetX}px ${offsetY}px ${blurRadius}px ${rgba}` };
  }

  return {
    shadowColor: color,
    shadowOpacity: opacity,
    shadowOffset: { width: offsetX, height: offsetY },
    shadowRadius: blurRadius,
    elevation,
  };
}
