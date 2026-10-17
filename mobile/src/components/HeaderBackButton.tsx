import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable } from "react-native";

export function HeaderBackButton({ tintColor, onPress }: { tintColor?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name="arrow-back" size={24} color={tintColor} />
    </Pressable>
  );
}
