import type { ReactNode } from "react";
import { Platform } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import Svg, { Circle, Path } from "react-native-svg";

type QuickActionKey = "categories" | "csv" | "scan" | "sales" | "expense";

const shapes: Record<QuickActionKey, ReactNode> = {
  categories: (
    <>
      <Path d="M3 3h6l8 8a2 2 0 0 1 0 2.8L11.8 19a2 2 0 0 1-2.8 0l-6-6V3Z" />
      <Path d="m13 3 8 8a2 2 0 0 1 0 2.8L15.8 19" />
      <Circle cx={6.5} cy={6.5} r={0.75} />
    </>
  ),
  csv: (
    <>
      <Path d="M18 9V6l-4-4H4v20h14v-3M13 2v5h5" />
      <Path d="M7 11h4M7 15h2M7 18h2M21 14H13m3-3-3 3 3 3" />
    </>
  ),
  scan: (
    <>
      <Path d="M6 2H2v4m16-4h4v4M2 18v4h4m16-4v4h-4" />
      <Path d="M8 5h8v14l-2-1.5-2 1.5-2-1.5L8 19V5ZM10.5 9h3M10.5 12h3" />
    </>
  ),
  sales: (
    <>
      <Path d="M7 7H3v14h18V7h-4M12 2v7m-3-3 3 3 3-3" />
      <Circle cx={12} cy={15} r={2.5} />
      <Path d="M6 14v2m12-2v2" />
    </>
  ),
  expense: (
    <>
      <Path d="M14 3H4v18l2.5-1.5L9 21l2.5-1.5L14 21l2.5-1.5L19 21V12" />
      <Path d="M7.5 8h3M7.5 12h6M7.5 16h6M15 9l6-6m-5 0h5v5" />
    </>
  ),
};

export function QuickActionIcon({
  actionKey,
  fallback,
  color,
}: {
  actionKey: string;
  fallback: keyof typeof Ionicons.glyphMap;
  color: string;
}) {
  if (!Object.prototype.hasOwnProperty.call(shapes, actionKey)) {
    return <Ionicons name={fallback} size={22} color={color} />;
  }

  return (
    <Svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(Platform.OS === "web" ? { "aria-hidden": true, focusable: false } : { accessible: false })}
    >
      {shapes[actionKey as QuickActionKey]}
    </Svg>
  );
}
