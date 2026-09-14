import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { space, typeScale } from "../../../theme/tokens";

/**
 * Stands in for a page whose bytes live on the server, not on this phone.
 * Resumed receipts carry no local uri, and an `Image` with an empty source
 * renders a blank box plus a React Native warning. Same receipt glyph as the
 * review card's "Open stored image" tile so the two read as one thing.
 */
export function StoredPagePlaceholder({ label, compact = false }: { label: string; compact?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.xs }}>
      <Ionicons name="receipt-outline" size={compact ? 20 : 32} color={t.ink[500]} />
      <T variant="caption" style={compact ? { fontSize: typeScale.micro, color: t.ink[600] } : { color: t.ink[600] }} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}
