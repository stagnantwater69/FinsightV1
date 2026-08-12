import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, T } from "./ui";
import { brand, ink, radius, space, typeScale } from "../theme/tokens";
import * as haptics from "../lib/haptics";

export interface QuickAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}

/**
 * The daily-task shortcuts, four to a row.
 *
 * Scan already has the bottom bar's raised button, but repeating it here is
 * deliberate rather than redundant: that button is easy to miss on a first
 * open, and grouping it with the rest of the day's actions is how an owner
 * discovers that Add expense and Add sale exist at all without having to
 * find the Records tab first.
 */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {actions.map((a) => (
          <Pressable
            key={a.key}
            onPress={() => {
              haptics.tapped();
              a.onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            style={({ pressed }) => ({
              width: "25%",
              alignItems: "center",
              gap: 6,
              paddingVertical: space.sm,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: radius.md,
                backgroundColor: brand[50],
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name={a.icon} size={20} color={brand[700]} />
            </View>
            <T style={{ fontSize: typeScale.micro, color: ink[700], textAlign: "center" }} numberOfLines={2}>
              {a.label}
            </T>
          </Pressable>
        ))}
      </View>
    </Card>
  );
}
