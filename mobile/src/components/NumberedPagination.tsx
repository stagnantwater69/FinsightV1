import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";

export function NumberedPagination({ page, totalPages, reachablePages, busy, available, hasNext, onPage, onNext }: {
  page: number; totalPages?: number; reachablePages: number; busy: boolean; available: boolean; hasNext: boolean;
  onPage: (page: number) => void; onNext: () => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const numbersRef = useRef<ScrollView>(null);
  const count = Math.max(1, totalPages ?? reachablePages);
  const availableWidth = measuredWidth ?? width - space.lg * 2;
  const arrowCount = 4;
  const middleWidth = Math.max(0, availableWidth - arrowCount * (TAP_FLOOR + space.xs));
  const buttonWidth = Math.max(TAP_FLOOR, Math.ceil(String(count).length * typeScale.bodySm * fontScale * 0.7 + space.sm * 2));
  const estimatedWidth = (values: number[]) => values.length * buttonWidth + Math.max(0, values.length - 1) * space.xs
    + values.filter((value, index) => index > 0 && value - values[index - 1] > 1).length * (space.lg + space.xs);
  let pages = count <= 5 ? Array.from({ length: count }, (_, index) => index)
    : [...new Set([0, ...(page <= 1 ? [1, 2] : [page - 1, page, page + 1]), count - 1].filter((value) => value >= 0 && value < count))].sort((a, b) => a - b);
  while (estimatedWidth(pages) > middleWidth) {
    const removable = pages.filter((value) => value !== 0 && value !== page && value !== count - 1);
    if (!removable.length) break;
    const furthest = removable.sort((a, b) => Math.abs(b - page) - Math.abs(a - page))[0];
    pages = pages.filter((value) => value !== furthest);
  }
  if (estimatedWidth(pages) > middleWidth) {
    const capacity = Math.max(1, Math.min(count, Math.floor((middleWidth + space.xs) / (buttonWidth + space.xs))));
    const start = Math.max(0, Math.min(page - Math.floor(capacity / 2), count - capacity));
    pages = Array.from({ length: capacity }, (_, index) => start + index);
  }
  const selectedIndex = pages.indexOf(page);
  const selectedOffset = pages.slice(0, selectedIndex).reduce((offset, value, index) => offset + buttonWidth + space.xs + (index > 0 && value - pages[index - 1] > 1 ? space.lg + space.xs : 0), 0)
    + (selectedIndex > 0 && pages[selectedIndex] - pages[selectedIndex - 1] > 1 ? space.lg + space.xs : 0);
  const numbersWidth = Math.min(contentWidth ?? estimatedWidth(pages), middleWidth);
  useEffect(() => {
    numbersRef.current?.scrollTo({ x: selectedOffset, animated: false });
  }, [selectedOffset, numbersWidth, fontScale]);
  const arrow = (label: string, icon: React.ComponentProps<typeof Ionicons>["name"], disabled: boolean, action: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={({ pressed }) => ({ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.border, borderRadius: radius.sm, backgroundColor: pressed ? t.brandSurface : t.surface, opacity: disabled ? 0.45 : 1 })}>
      <Ionicons name={icon} size={20} color={t.brandText} />
    </Pressable>
  );
  const blocked = busy || !available;
  return (
    <View onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs }}>
      {arrow("First page", "play-skip-back-outline", blocked || page === 0, () => onPage(0))}
      {arrow("Previous page", "chevron-back", blocked || page === 0, () => onPage(page - 1))}
      <ScrollView ref={numbersRef} horizontal showsHorizontalScrollIndicator={false} style={{ width: numbersWidth, flexGrow: 0, flexShrink: 1, alignSelf: "stretch" }} contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexGrow: 0 }} onContentSizeChange={(nextWidth) => { setContentWidth(nextWidth); numbersRef.current?.scrollTo({ x: selectedOffset, animated: false }); }}>
      {pages.map((value, index) => (
        <View key={value} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          {index > 0 && value - pages[index - 1] > 1 ? <T accessible={false} style={{ width: space.lg, textAlign: "center", color: t.textMuted }}>…</T> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={`Go to page ${value + 1}`} accessibilityState={{ selected: value === page, disabled: blocked }} disabled={blocked} onPress={() => onPage(value)} style={({ pressed }) => ({ width: buttonWidth, minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, paddingHorizontal: space.sm, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: value === page ? t.brandSolid : t.border, borderRadius: radius.sm, backgroundColor: value === page ? t.brandSolid : pressed ? t.brandSurface : t.surface })}>
            <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: value === page ? t.onBrandSolid : t.brandText }}>{value + 1}</T>
          </Pressable>
        </View>
      ))}
      </ScrollView>
      {arrow("Next page", "chevron-forward", blocked || !hasNext, onNext)}
      {arrow("Last page", "play-skip-forward-outline", blocked || totalPages === undefined || page === count - 1, () => onPage(count - 1))}
    </View>
  );
}
