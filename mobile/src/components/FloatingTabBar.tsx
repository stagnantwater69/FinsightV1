import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";
import { shadowStyle } from "../theme/shadow";
import { BAR_GAP, BAR_LIFT, BAR_MAX_WIDTH, BAR_SIDE, barHeightForScale } from "./floatingTabBarLayout";

/**
 * The main navigation as a floating pill, with "+" as its own circle beside it.
 *
 * WHY SPLIT. The four destinations and the one action used to share a bar,
 * with the action raised out of the middle. As its own circle at the right,
 * "+" reads as "add something" rather than as a fifth place, sits under the
 * right thumb, and its speed dial (QuickActionMenu) can rise straight up from
 * it with every option labelled.
 *
 * OVER THE CONTENT. The bar has no strip of its own: the pill floats over
 * the bottom of the screen, which scrolls under it. Scroll views end with
 * FAB_CLEARANCE padding so their last card can scroll clear of the pill.
 *
 * Tab presses go through `navigation.emit("tabPress")` exactly as the stock
 * bar does, so the Records tab's own listener (recordsTabPressAction) still
 * gets to intercept them.
 */
export function FloatingTabBar({
  state,
  descriptors,
  navigation,
  hiddenRoutes,
  addButton,
  mutedRoute,
}: BottomTabBarProps & {
  /** Routes that are not destinations (the "+" placeholder). */
  hiddenRoutes: readonly string[];
  /** The "+" circle, drawn by the caller because it owns the menu state. */
  addButton: ReactNode;
  /** A focused route to draw as unfocused — Records while a quick-add screen is up. */
  mutedRoute?: string;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const barHeight = barHeightForScale(fontScale);
  const compactLabels = width / fontScale < 300;
  const currentRoute = state.routes[state.index];
  const hasFocusedTab = currentRoute !== undefined && currentRoute.name !== mutedRoute && !hiddenRoutes.includes(currentRoute.name);
  const keyboardOpen = useKeyboardOpen();
  // The stock bar hides itself over the Android keyboard; this one has to as well.
  if (keyboardOpen) return null;

  return (
    <View
      // Floats over the screen with no strip behind it; taps beside the pill reach the content.
      style={{
        pointerEvents: "box-none",
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: space.sm,
        paddingBottom: Math.max(insets.bottom, space.sm) + BAR_LIFT,
        // The page colour at ~80%: the strip is back, but content scrolling under it shows through.
        backgroundColor: /^#[0-9a-f]{6}$/i.test(t.surfaceSunken) ? `${t.surfaceSunken}CC` : t.surfaceSunken,
      }}
    >
      <View style={{ width: "100%", maxWidth: BAR_MAX_WIDTH, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: BAR_GAP, paddingHorizontal: BAR_SIDE }}>
      <View
        style={{
          flex: 1,
          minHeight: barHeight,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: compactLabels ? 2 : 6,
          borderRadius: barHeight / 2,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          ...shadowStyle({ color: t.shadow, offsetY: 8, opacity: 0.14 * t.shadowStrength, blurRadius: 18, elevation: 8 }),
        }}
      >
        {state.routes.map((route, index) => {
          if (hiddenRoutes.includes(route.name)) return null;
          const { options } = descriptors[route.key]!;
          const focused = state.index === index && route.name !== mutedRoute;
          const color = focused ? t.brandText : t.textMuted;
          const label = typeof options.tabBarLabel === "string" ? options.tabBarLabel : options.title ?? route.name;
          const onPress = () => {
            const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
            if (state.index !== index && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: focused }}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
              style={({ pressed }) => ({
                flex: compactLabels && hasFocusedTab && !focused ? 0 : 1,
                width: compactLabels && hasFocusedTab && !focused ? 48 : undefined,
                minHeight: barHeight - 12,
                minWidth: 48,
                paddingVertical: space.xs,
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                borderRadius: radius.full,
                backgroundColor: focused ? t.brandSurface : pressed ? t.surfaceMuted : "transparent",
              })}
            >
              {options.tabBarIcon?.({ focused, color, size: 22 })}
              {(!compactLabels || (focused && fontScale <= 1.4)) ? (
                <T numberOfLines={1} style={{ flexShrink: 1, textAlign: "center", fontSize: typeScale.micro, fontFamily: focused ? font.sansSemibold : font.sansMedium, color }}>{label}</T>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {addButton}
      </View>
    </View>
  );
}

function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // iOS keeps the bar under the keyboard anyway; Android pushes it up over the field.
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", () => setOpen(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}
