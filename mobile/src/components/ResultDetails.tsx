import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";
import { space } from "../theme/tokens";

/** Optional explanations only. Keep required decisions and warnings outside. */
export function ResultDetails({ children, label = "result details" }: { children: ReactNode; label?: string }) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Show less" : "Show more"}, ${label}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start" }}
      >
        <T variant="label" style={{ color: t.brandText }}>{expanded ? "Show less" : "Show more"}</T>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} color={t.brandText} size={16} />
      </Pressable>
      {expanded ? <View style={{ gap: space.sm }}>{children}</View> : null}
    </View>
  );
}
