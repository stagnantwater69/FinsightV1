import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type PointerEvent, type StyleProp, type ViewStyle } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useReportingPeriod } from "../context/ReportingPeriodContext";
import { useTheme } from "../context/ThemeContext";
import { chartIndexAtX, type ChartHitPoint } from "../lib/chartInteraction";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { T } from "./ui";

export type { ChartHitPoint } from "../lib/chartInteraction";

export interface ChartDatum {
  key: string;
  label: string;
  values: { label: string; value: number | null; display?: string; unavailableLabel?: string; color?: string }[];
  note?: string;
}

export interface ChartSelection {
  selectedIndex: number | null;
  selected: ChartDatum | null;
  select: (index: number) => void;
  hover: (index: number) => void;
  clearHover: (index?: number) => void;
  clear: () => void;
  previous: () => void;
  next: () => void;
  bind: (index: number) => {
    onPress: () => void;
    onHoverIn: () => void;
    onHoverOut: () => void;
    onFocus: () => void;
    onBlur: () => void;
    accessibilityState: { selected: boolean };
  };
}

export function useChartSelection(data: readonly ChartDatum[], scopeKey?: string | number | null, initialIndex: number | null = null): ChartSelection {
  const business = useBusinessProfiles(true);
  const period = useReportingPeriod(true);
  const fingerprint = JSON.stringify([business?.selected?.id ?? null, period?.selection, scopeKey, data.map((datum) => ({ ...datum, values: datum.values.map(({ color: _color, ...value }) => value) }))]);
  const scope = useRef({ fingerprint, revision: 0 });
  if (scope.current.fingerprint !== fingerprint) scope.current = { fingerprint, revision: scope.current.revision + 1 };
  const revision = scope.current.revision;
  const initial = initialIndex !== null && initialIndex >= 0 && initialIndex < data.length ? initialIndex : null;
  const [state, setState] = useState<{ revision: number; pinned: number | null; hovered: number | null }>({ revision, pinned: initial, hovered: null });
  const current = state.revision === revision ? state : { revision, pinned: initial, hovered: null };
  const stateRef = useRef(current);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  stateRef.current = current;
  const selectedIndex = current.hovered ?? current.pinned;

  const update = useCallback((patch: { pinned?: number | null; hovered?: number | null }) => {
    if (!mounted.current || scope.current.revision !== revision) return;
    const next = { ...stateRef.current, ...patch, revision };
    if (next.pinned === stateRef.current.pinned && next.hovered === stateRef.current.hovered && next.revision === stateRef.current.revision) return;
    stateRef.current = next;
    setState(next);
  }, [revision]);
  const select = (index: number) => {
    if (Number.isInteger(index) && index >= 0 && index < data.length) update({ pinned: index, hovered: null });
  };
  const hover = (index: number) => {
    if (Number.isInteger(index) && index >= 0 && index < data.length) update({ hovered: index });
  };
  const clearHover = (index?: number) => {
    if (index === undefined || stateRef.current.hovered === index) update({ hovered: null });
  };
  const clear = useCallback(() => update({ pinned: null, hovered: null }), [update]);
  const previous = () => select(Math.max(0, (stateRef.current.hovered ?? stateRef.current.pinned ?? 1) - 1));
  const next = () => select(Math.min(data.length - 1, (stateRef.current.hovered ?? stateRef.current.pinned ?? -1) + 1));

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [clear]);

  return {
    selectedIndex,
    selected: selectedIndex === null ? null : data[selectedIndex] ?? null,
    select, hover, clearHover, clear, previous, next,
    bind: (index) => ({
      onPress: () => select(index), onHoverIn: () => hover(index), onHoverOut: () => clearHover(index),
      onFocus: () => hover(index), onBlur: () => clearHover(index), accessibilityState: { selected: selectedIndex === index },
    }),
  };
}

export function ChartPlotPressArea({ selection, count, chartLabel, children, indexAtPoint, mode = "points", style, accessiblePlot = false }: {
  selection: ChartSelection;
  count: number;
  chartLabel: string;
  children: ReactNode;
  indexAtPoint?: (point: ChartHitPoint) => number | null;
  mode?: "points" | "bands";
  style?: StyleProp<ViewStyle>;
  accessiblePlot?: boolean;
}) {
  const theme = useTheme();
  const [plotFocused, setPlotFocused] = useState(false);
  const layout = useRef({ width: 0, height: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    layout.current = { width: Number.isFinite(width) ? width : layout.current.width, height: Number.isFinite(height) ? height : layout.current.height };
  };
  const read = (event: GestureResponderEvent | PointerEvent, hover: boolean) => {
    type Coordinates = { pointerType?: string; buttons?: number; offsetX?: number; offsetY?: number; locationX?: number; locationY?: number; clientX?: number; clientY?: number };
    const input = event as unknown as Coordinates & { nativeEvent?: Coordinates; currentTarget?: { getBoundingClientRect?: () => { left: number; top: number } } };
    const native = input.nativeEvent ?? input;
    if (hover && (native.pointerType === "touch" || (native.buttons ?? 0) > 0)) return false;
    const bounds = Platform.OS === "web" ? input.currentTarget?.getBoundingClientRect?.() : undefined;
    const x = bounds && native.clientX !== undefined ? native.clientX - bounds.left : native.offsetX ?? native.locationX ?? Number.NaN;
    const y = bounds && native.clientY !== undefined ? native.clientY - bounds.top : native.offsetY ?? native.locationY ?? Number.NaN;
    const point = { x, y, ...layout.current };
    const index = indexAtPoint ? indexAtPoint(point) : chartIndexAtX(x, point.width, count, mode);
    if (index !== null && Number.isInteger(index) && index >= 0 && index < count) {
      (hover ? selection.hover : selection.select)(index);
      return true;
    }
    else if (hover) selection.clearHover();
    return false;
  };
  return (
    <View style={[{ minHeight: TAP_FLOOR, justifyContent: "center" }, style]} onLayout={onLayout}>
      {children}
      <Pressable
        accessible={accessiblePlot}
        focusable={accessiblePlot}
        importantForAccessibility={accessiblePlot ? "yes" : "no"}
        accessibilityRole={accessiblePlot ? "button" : undefined}
        accessibilityLabel={accessiblePlot ? chartLabel : `${chartLabel} plot`}
        testID={`chart-plot-${chartLabel}`}
        style={[StyleSheet.absoluteFill, Platform.OS === "web" && accessiblePlot && plotFocused ? { outlineColor: theme.brandText, outlineWidth: 2, outlineStyle: "solid", outlineOffset: 2 } : undefined]}
        onLayout={onLayout}
        onFocus={() => setPlotFocused(true)}
        onBlur={() => setPlotFocused(false)}
        onPress={(event) => {
          event?.stopPropagation?.();
          const selected = event ? read(event, false) : false;
          if (accessiblePlot && !selected) selection.select(selection.selectedIndex ?? 0);
        }}
        onHoverIn={(event) => read(event as unknown as GestureResponderEvent, true)}
        onHoverOut={() => selection.clearHover()}
        onPointerMove={(event) => {
          if ((event.nativeEvent.pointerType === "mouse" || event.nativeEvent.pointerType === "pen") && !(event.nativeEvent.buttons > 0)) read(event, true);
        }}
      />
    </View>
  );
}

export function ChartValueReadout({ data, selection, chartLabel }: { data: readonly ChartDatum[]; selection: ChartSelection; chartLabel: string }) {
  const t = useTheme();
  const root = useRef<View | null>(null);
  const [exploreFocused, setExploreFocused] = useState(false);
  const current = useRef(selection);
  current.current = selection;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const explore = (event: KeyboardEvent) => {
      const element = root.current as (View & { contains?: (node: Node | null) => boolean }) | null;
      if (!element?.contains?.(event.target as Node | null)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault(); current.current.previous();
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault(); current.current.next();
      }
    };
    document.addEventListener("keydown", explore);
    return () => document.removeEventListener("keydown", explore);
  }, []);
  if (data.length === 0) return null;
  const active = selection.selected;
  const valueText = (row: ChartDatum["values"][number]) => row.value === null || !Number.isFinite(row.value)
    ? row.unavailableLabel ?? "Not recorded"
    : row.display ?? formatMoney(row.value, { decimals: true });
  return (
    <View ref={root} style={{ marginTop: space.md, gap: space.sm }}>
      {active ? (
        <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={`${chartLabel} selected value. ${active.label}. ${active.values.map((row) => `${row.label}: ${valueText(row)}`).join(". ")}${active.note ? `. ${active.note}` : ""}`} style={{ padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, backgroundColor: t.surfaceRaised, gap: space.sm }}>
          <T style={{ fontFamily: font.sansSemibold, color: t.textPrimary, maxWidth: "100%", flexShrink: 1 }}>{active.label}</T>
          {active.values.map((row, index) => (
            <View key={`${row.label}-${index}`} style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: space.md, rowGap: space.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1, maxWidth: "100%" }}>
                {row.color ? <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: row.color }} /> : null}
                <T variant="caption" style={{ color: t.textSecondary, flexShrink: 1, maxWidth: "100%" }}>{row.label}</T>
              </View>
              <T style={{ fontFamily: font.monoMedium, fontSize: typeScale.bodySm, color: t.textPrimary, maxWidth: "100%", flexShrink: 1 }}>
                {valueText(row)}
              </T>
            </View>
          ))}
          {active.note ? <T variant="caption" style={{ maxWidth: "100%", flexShrink: 1 }}>{active.note}</T> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Explore ${chartLabel} values`} onPress={() => selection.select(0)} onFocus={() => setExploreFocused(true)} onBlur={() => setExploreFocused(false)} style={({ pressed }) => ({ minHeight: TAP_FLOOR, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: pressed ? t.brandSurface : t.surfaceMuted, ...(Platform.OS === "web" && exploreFocused ? { outlineColor: t.brandText, outlineWidth: 2, outlineStyle: "solid", outlineOffset: 2 } : {}) })}>
            <T variant="label" style={{ color: t.brandText }}>Explore values</T>
          </Pressable>
        {active ? (
          <>
            <ValueControl label={`Previous value in ${chartLabel}`} icon="chevron-back" onPress={selection.previous} disabled={selection.selectedIndex === 0} />
            <T variant="caption">{(selection.selectedIndex ?? 0) + 1} of {data.length}</T>
            <ValueControl label={`Next value in ${chartLabel}`} icon="chevron-forward" onPress={selection.next} disabled={selection.selectedIndex === data.length - 1} />
            <View style={{ flex: 1 }} />
            <ValueControl label={`Clear ${chartLabel} value`} icon="close" onPress={selection.clear} />
          </>
        ) : null}
      </View>
    </View>
  );
}

function ValueControl({ label, icon, onPress, disabled = false }: { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => ({ width: TAP_FLOOR, height: TAP_FLOOR, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: pressed ? t.brandSurface : t.surfaceMuted, opacity: disabled ? 0.5 : 1, ...(Platform.OS === "web" && focused ? { outlineColor: t.brandText, outlineWidth: 2, outlineStyle: "solid", outlineOffset: 2 } : {}) })}>
      <Ionicons name={icon} size={18} color={t.textSecondary} />
    </Pressable>
  );
}
