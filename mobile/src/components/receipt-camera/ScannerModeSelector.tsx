import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../context/ThemeContext";
import { font, typeScale } from "../../theme/tokens";
import { TAP_FLOOR } from "../touchTarget";
import type { ScannerSessionMode } from "./scannerSession";

/**
 * Text tabs under the viewfinder, the selected one marked by the on-dark brand
 * step and a short underline. The mode is a quiet setting next to the
 * shutter, so it reads as a label rather than a second button row.
 */
export function ScannerModeSelector({
  value,
  disabled,
  onChange,
}: {
  value: ScannerSessionMode;
  disabled?: boolean;
  onChange: (mode: ScannerSessionMode) => void;
}) {
  const t = useTheme();
  const accent = t.brand[400];

  return (
    <View style={styles.track}>
      {(["standard", "batch"] as const).map((mode) => {
        const selected = value === mode;
        const label = mode === "standard" ? "Standard" : "Batch";
        return (
          <Pressable
            key={mode}
            accessibilityRole="tab"
            accessibilityLabel={`${label} scan mode`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(mode)}
            style={({ pressed }) => [
              styles.option,
              { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: disabled ? 0.45 : pressed ? 0.72 : 1 },
            ]}
          >
            <View style={[styles.underline, { backgroundColor: selected ? accent : "transparent" }]} />
            <Text style={[styles.label, { color: selected ? accent : t.onCamera }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    alignSelf: "center",
    flexDirection: "row",
    gap: 8,
  },
  option: {
    minWidth: 88,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: 12,
    gap: 8,
  },
  underline: {
    width: 28,
    height: 3,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  label: {
    fontFamily: font.sansSemibold,
    fontSize: typeScale.body,
  },
});
