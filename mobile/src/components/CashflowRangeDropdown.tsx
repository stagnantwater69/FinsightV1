import { useRef, useState } from "react";
import { Dimensions, Modal, Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { radius, space, typeScale } from "../theme/tokens";
import { shadowStyle } from "../theme/shadow";
import { TAP_FLOOR } from "./touchTarget";
import type { CashflowGranularity } from "../lib/types";

// "Weekly" is the `daily` series: the last 7 days, one point per day.
const GRANULARITY_OPTIONS: { label: string; value: CashflowGranularity }[] = [
  { label: "Weekly", value: "daily" },
  { label: "Monthly", value: "monthly" },
];

/**
 * The cashflow chart's own range control — a small "Monthly ⌄" chip that opens
 * a two-option picker, rather than a full picker screen. Lives next to the
 * chart's title (via `ChartFrame`'s `action` slot) rather than in the
 * screen's own header, because it belongs to this one chart and nothing else
 * on Home reads differently for it.
 *
 * Anchored, not centred: the menu is measured off the chip itself with
 * `measureInWindow` and appears directly under it, and the backdrop carries
 * no dim tint. `Modal` is used only for the layer it renders on and the
 * outside-tap-to-close it gives for free — visually this reads as a regular
 * dropdown attached to its trigger, not a dialog.
 */
export function GranularityDropdown({
  value,
  onChange,
}: {
  value: CashflowGranularity;
  onChange: (v: CashflowGranularity) => void;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<View>(null);
  const current = GRANULARITY_OPTIONS.find((o) => o.value === value)!;

  return (
    <View ref={anchorRef} collapsable={false}>
      <Pressable
        onPress={() => {
          anchorRef.current?.measureInWindow((x, y, width, height) => {
            setAnchor({ top: y + height + 4, right: Math.max(Dimensions.get("window").width - (x + width), 0) });
            setOpen(true);
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={`${current.label} view. Change cashflow range.`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: space.sm,
          paddingVertical: 6,
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: ink[200],
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <T style={{ fontSize: typeScale.caption, color: ink[700] }}>{current.label}</T>
        <Ionicons name="chevron-down" size={14} color={ink[500]} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1 }}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          {anchor ? (
            <View
              style={{
                position: "absolute",
                top: anchor.top,
                right: anchor.right,
                backgroundColor: paper.DEFAULT,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: paper[200],
                overflow: "hidden",
                minWidth: 130,
                ...shadowStyle({ color: ink[900], offsetY: 2, opacity: 0.12, blurRadius: 8, elevation: 6 }),
              }}
            >
              {GRANULARITY_OPTIONS.map((o) => (
                <Pressable
                  key={o.value}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: o.value === value }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: space.md,
                    paddingHorizontal: space.md,
                    // Full height, not a hitSlop: these rows stack vertically
                    // in a popup that is sized by its contents, so slop on one
                    // row would reach into the row above it and the two-option
                    // menu simply grows eight points instead.
                    minHeight: TAP_FLOOR,
                    backgroundColor: pressed ? paper[100] : "transparent",
                  })}
                >
                  <T style={{ fontSize: typeScale.bodySm, color: ink[900] }}>{o.label}</T>
                  {o.value === value ? <Ionicons name="checkmark" size={16} color={brand[600]} /> : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
