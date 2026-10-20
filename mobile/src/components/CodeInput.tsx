import { forwardRef, useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, TextInput, View, useWindowDimensions, type LayoutRectangle, type TextInputProps } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "../context/ThemeContext";
import { MIN_RECOVERY_CODE_LENGTH, normaliseRecoveryCode } from "../lib/authValidation";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { T } from "./ui";

type CodeInputProps = Omit<TextInputProps, "value" | "onChangeText" | "style" | "multiline"> & {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string | null;
};

export const CodeInput = forwardRef<TextInput, CodeInputProps>(function CodeInput(
  { label, value, onChangeText, error, onFocus, onBlur, onSelectionChange, onTouchStart, onTouchEnd, editable = true, testID, ...rest },
  ref,
) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const [focused, setFocused] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const inputRef = useRef<TextInput | null>(null);
  const cellLayouts = useRef<LayoutRectangle[]>([]);
  const touchStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const setInputRef = useCallback((node: TextInput | null) => {
    inputRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  const characters = Array.from(normaliseRecoveryCode(value));
  const count = Math.max(MIN_RECOVERY_CODE_LENGTH, characters.length);
  const activeIndex = Math.min(Array.from(normaliseRecoveryCode(value.slice(0, selection.start))).length, count - 1);
  const selectedEnd = Array.from(normaliseRecoveryCode(value.slice(0, selection.end))).length;
  const minimumCellWidth = Math.max(32, typeScale.subpageTitle * fontScale * 0.7 + space.md);
  const maxColumns = availableWidth ? Math.max(1, Math.floor((availableWidth + space.sm) / (minimumCellWidth + space.sm))) : 6;
  const columns = Math.ceil(count / Math.ceil(count / maxColumns));
  const cellWidth = Math.max(minimumCellWidth, availableWidth ? Math.min(48, (availableWidth - space.sm * (columns - 1)) / columns) : 40);

  function startTouch(x: number, y: number) {
    touchStart.current = { x, y, time: Date.now() };
  }

  function endTouch(x: number, y: number) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!editable || !start || Date.now() - start.time > 350 || Math.hypot(x - start.x, y - start.y) > 10) return;
    let tappedIndex = -1;
    let nearestDistance = Infinity;
    cellLayouts.current.slice(0, count).forEach((cell, index) => {
      const distance = Math.hypot(x - cell.x - cell.width / 2, y - cell.y - cell.height / 2);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        tappedIndex = index;
      }
    });
    if (tappedIndex < 0) return;
    const offsets: number[] = [];
    let rawOffset = 0;
    for (const character of value) {
      if (normaliseRecoveryCode(character)) offsets.push(rawOffset);
      rawOffset += character.length;
    }
    const nextStart = offsets[tappedIndex] ?? value.length;
    const nextEnd = nextStart + (characters[tappedIndex]?.length ?? 0);
    const input = inputRef.current as (TextInput & { setSelectionRange?: (start: number, end: number) => void }) | null;
    if (typeof input?.setSelection === "function") input.setSelection(nextStart, nextEnd);
    else input?.setSelectionRange?.(nextStart, nextEnd);
    setSelection({ start: nextStart, end: nextEnd });
  }

  const webPointerHandlers = Platform.OS === "web" ? {
    onMouseDown: (event: { nativeEvent: { offsetX: number; offsetY: number; button: number } }) => {
      if (event.nativeEvent.button === 0) startTouch(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    },
    onMouseUp: (event: { nativeEvent: { offsetX: number; offsetY: number; button: number } }) => {
      if (event.nativeEvent.button === 0) endTouch(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    },
  } : {};

  return (
    <View style={{ marginBottom: space.sm }} onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}>
      <T variant="label" style={{ color: t.textSecondary, marginBottom: space.sm, textAlign: "center" }}>
        {label}
      </T>
      <View
        style={{
          alignSelf: "center",
          width: "100%",
          maxWidth: columns * cellWidth + space.sm * (columns - 1),
          minHeight: TAP_FLOOR,
        }}
      >
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm }}
        >
          {Array.from({ length: count }, (_, index) => {
            const active = focused && editable && (index === activeIndex || (index > activeIndex && index < selectedEnd));
            return (
              <View
                key={index}
                testID={`${testID ?? "code-input"}-cell-${index}`}
                onLayout={(event) => { cellLayouts.current[index] = event.nativeEvent.layout; }}
                style={{
                  width: cellWidth,
                  minHeight: Math.max(56, TAP_FLOOR),
                  paddingVertical: space.md,
                  justifyContent: "center",
                  alignItems: "center",
                  borderWidth: active ? 2 : 1,
                  borderRadius: radius.sm,
                  borderColor: error ? t.statusText.critical : active ? t.brandText : t.textMuted,
                  backgroundColor: active ? t.brandSurface : t.surface,
                  opacity: editable ? 1 : 0.6,
                }}
              >
                <T style={{ fontFamily: font.displayBold, fontSize: typeScale.subpageTitle, color: t.textPrimary, textAlign: "center" }}>
                  {characters[index] || " "}
                </T>
              </View>
            );
          })}
        </View>
        <TextInput
          {...rest}
          {...webPointerHandlers}
          ref={setInputRef}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          editable={editable}
          accessibilityLabel={error ? `${label}, ${error}` : label}
          accessibilityState={{ disabled: !editable }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          caretHidden
          selectionColor="transparent"
          underlineColorAndroid="transparent"
          onTouchStart={(event) => {
            if (Platform.OS !== "web") startTouch(event.nativeEvent.locationX, event.nativeEvent.locationY);
            onTouchStart?.(event);
          }}
          onTouchEnd={(event) => {
            if (Platform.OS !== "web") endTouch(event.nativeEvent.locationX, event.nativeEvent.locationY);
            onTouchEnd?.(event);
          }}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          onSelectionChange={(event) => {
            setSelection(event.nativeEvent.selection);
            onSelectionChange?.(event);
          }}
          style={[
            StyleSheet.absoluteFill,
            {
              minHeight: TAP_FLOOR,
              padding: 0,
              color: "transparent",
              backgroundColor: "transparent",
              fontFamily: font.displayBold,
              fontSize: typeScale.subpageTitle,
              letterSpacing: cellWidth - typeScale.subpageTitle * 0.6 + space.sm,
            },
          ]}
        />
      </View>
      {error ? (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xs, marginTop: space.sm }}>
          <Ionicons name="alert-circle-outline" size={16} color={t.statusText.critical} accessibilityElementsHidden importantForAccessibility="no" />
          <T variant="caption" style={{ flex: 1, color: t.statusText.critical }}>{error}</T>
        </View>
      ) : null}
    </View>
  );
});
