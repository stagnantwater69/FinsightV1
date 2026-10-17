import { useState, type ReactNode, type Ref } from "react";
import { Platform, Pressable, ScrollView, View, type PressableProps, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Screen, T } from "../../components/ui";
import { ContentScrollView } from "../../components/ContentScrollView";
import { SubpageCard, SubpageHeader, SubpageIcon } from "../../components/SubpageKit";
import { TAP_FLOOR } from "../../components/touchTarget";
import { useTheme } from "../../context/ThemeContext";
import { font, radius, space, typeScale } from "../../theme/tokens";

export type HelpNavigation = {
  navigate: (screen: string) => void;
  canGoBack?: () => boolean;
  goBack?: () => void;
};

function useHelpFocus(color: string) {
  const [focused, setFocused] = useState(false);
  const style: ViewStyle = Platform.OS === "web" && focused
    ? { outlineColor: color, outlineWidth: 2, outlineStyle: "solid", outlineOffset: -2 }
    : {};
  return { style, onFocus: () => setFocused(true), onBlur: () => setFocused(false) };
}

export function HelpAction({ style, ...props }: PressableProps) {
  const t = useTheme();
  const focus = useHelpFocus(t.brandText);
  return (
    <Pressable accessibilityRole="button" {...props} onFocus={focus.onFocus} onBlur={focus.onBlur}
      style={(state) => [typeof style === "function" ? style(state) : style, focus.style]} />
  );
}

export function HelpPage({ title, intro, navigation, children, scrollRef, showScrollIndicator = false }: {
  title: string;
  intro?: string;
  navigation?: HelpNavigation;
  children: ReactNode;
  scrollRef?: Ref<ScrollView>;
  showScrollIndicator?: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <SubpageHeader title={title} disabled={!navigation} onBack={() => {
        if (navigation?.canGoBack?.() && navigation.goBack) navigation.goBack();
        else navigation?.navigate("MoreHome");
      }} />
      <ContentScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={showScrollIndicator}
        contentContainerStyle={{
          padding: space.lg,
          paddingTop: space.sm,
          paddingBottom: Math.max(insets.bottom, space.lg) + space.xxl,
          gap: space.lg,
        }}
      >
        {intro ? <T style={{ color: t.textSecondary, fontSize: typeScale.body, lineHeight: 24 }}>{intro}</T> : null}
        {children}
      </ContentScrollView>
    </Screen>
  );
}

export function HelpGroup({ title, icon, children }: { title: string; icon?: keyof typeof Ionicons.glyphMap; children: ReactNode }) {
  return <SubpageCard title={title} icon={icon}>{children}</SubpageCard>;
}

export function HelpDisclosure({ title, label = title, number, expanded, first, onPress, children, kind }: {
  title: string;
  label?: string;
  number?: number;
  expanded: boolean;
  first?: boolean;
  onPress: () => void;
  children: ReactNode;
  kind: "answer" | "guide";
}) {
  const t = useTheme();
  const focus = useHelpFocus(t.brandText);
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: t.border, backgroundColor: expanded && kind === "guide" ? t.brandSurface : undefined, borderRadius: expanded && kind === "guide" ? radius.sm : 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} aria-expanded={expanded}
        onFocus={focus.onFocus} onBlur={focus.onBlur}
        accessibilityHint={`${expanded ? "Hides" : "Shows"} the ${kind}`} onPress={onPress}
        style={({ pressed }) => ({ minHeight: Math.max(56, TAP_FLOOR), paddingVertical: space.md, paddingHorizontal: space.xs, flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.sm, backgroundColor: pressed ? t.brandSurface : "transparent", ...focus.style })}>
        {number !== undefined ? <HelpNumber value={number} /> : null}
        <T style={{ flex: 1, minWidth: 0, color: t.textPrimary, fontFamily: expanded ? font.sansSemibold : font.sansMedium }}>{title}</T>
        <Ionicons name={expanded ? "chevron-up-outline" : "chevron-down-outline"} size={20} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
      </Pressable>
      {expanded ? <View style={{ paddingHorizontal: space.xs, paddingBottom: space.md }}>{children}</View> : null}
    </View>
  );
}

export function HelpIcon({ name }: { name: keyof typeof Ionicons.glyphMap }) {
  return <SubpageIcon name={name} />;
}

export function HelpNumber({ value, padded = true }: { value: number; padded?: boolean }) {
  const t = useTheme();
  return (
    <View accessible={false} importantForAccessibility="no" style={{ minWidth: 36, minHeight: 36, paddingHorizontal: space.sm, paddingVertical: space.xs, flexShrink: 0, borderRadius: radius.full, backgroundColor: t.brandSurface, alignItems: "center", justifyContent: "center" }}>
      <T accessible={false} importantForAccessibility="no" style={{ fontFamily: font.sansSemibold, color: t.brandText }}>{padded ? String(value).padStart(2, "0") : value}</T>
    </View>
  );
}

export function HelpLink({ title, detail, icon, first, onPress }: {
  title: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  first?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const focus = useHelpFocus(t.brandText);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`} onPress={onPress}
      onFocus={focus.onFocus} onBlur={focus.onBlur}
      style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingVertical: space.md, paddingHorizontal: space.xs, flexDirection: "row", alignItems: "center", gap: space.md, borderTopWidth: first ? 0 : 1, borderTopColor: t.border, backgroundColor: pressed ? t.brandSurface : "transparent", ...focus.style })}>
      <HelpIcon name={icon} />
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        <T style={{ color: t.textPrimary, fontFamily: font.sansSemibold }}>{title}</T>
        <T style={{ fontSize: typeScale.bodySm }}>{detail}</T>
      </View>
      <Ionicons name="chevron-forward-outline" size={20} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
    </Pressable>
  );
}
