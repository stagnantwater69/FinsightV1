import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../context/ThemeContext";
import type { ReceiptFilterMode } from "../../lib/receiptFilters";
import { font, typeScale } from "../../theme/tokens";
import { TAP_FLOOR } from "../touchTarget";

const FILTERS: ReadonlyArray<{ mode: ReceiptFilterMode; label: string; detail: string }> = [
  { mode: "original", label: "Original", detail: "The cropped photo with no enhancement" },
  { mode: "enhanced", label: "Enhanced", detail: "Evens out lighting and keeps color" },
  { mode: "grayscale", label: "Grayscale", detail: "Removes color" },
  { mode: "black-white", label: "B&W", detail: "High contrast black and white for faint print" },
];

/**
 * One row of filters that replaces the page navigation while open, so the
 * receipt stays large and the result of each choice is visible above it.
 */
export function ReceiptFilterSheet({
  value,
  busy,
  onSelect,
  onClose,
}: {
  value: ReceiptFilterMode;
  busy: boolean;
  onSelect: (mode: ReceiptFilterMode) => void;
  onClose: () => void;
}) {
  const t = useTheme();

  return (
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" style={[styles.heading, { color: t.onCamera }]}>Filter</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close filters"
          disabled={busy}
          onPress={onClose}
          style={({ pressed }) => [styles.close, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: busy ? 0.45 : pressed ? 0.65 : 1 }]}
        >
          <Text style={[styles.closeText, { color: t.brand[400] }]}>Done</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.options}>
        {FILTERS.map((filter) => {
          const checked = value === filter.mode;
          return (
            <Pressable
              key={filter.mode}
              accessibilityRole="radio"
              accessibilityLabel={filter.label === "B&W" ? "Black and white" : filter.label}
              accessibilityHint={filter.detail}
              accessibilityState={{ checked, disabled: busy }}
              disabled={busy}
              onPress={() => onSelect(filter.mode)}
              style={({ pressed }) => [
                styles.option,
                {
                  minWidth: TAP_FLOOR,
                  minHeight: TAP_FLOOR,
                  backgroundColor: checked ? t.brandFill : "rgba(255,255,255,0.08)",
                  borderColor: checked ? t.brand[400] : "rgba(255,255,255,0.22)",
                  opacity: busy ? 0.45 : pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text style={[styles.optionLabel, { color: t.onCamera }]}>{filter.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 4, paddingHorizontal: 12, paddingVertical: 6 },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { fontFamily: font.sansSemibold, fontSize: typeScale.bodySm },
  close: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  closeText: { fontFamily: font.sansSemibold, fontSize: typeScale.bodySm },
  options: { flexGrow: 1, flexDirection: "row", gap: 8, justifyContent: "center" },
  option: {
    minWidth: 76,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  optionLabel: { fontFamily: font.sansSemibold, fontSize: typeScale.bodySm },
});
