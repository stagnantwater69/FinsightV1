import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { CONTENT_WIDTH } from "../../components/ContentScrollView";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, ErrorNote, SelectChip, T } from "../../components/ui";
import { DateField, DateRangeChips } from "../../components/DateField";
import { useTheme } from "../../context/ThemeContext";
import { TAP_FLOOR } from "../../components/touchTarget";
import { font, radius, space, typeScale } from "../../theme/tokens";
import type { RecordSource } from "../../lib/types";
import type { ImportBatchSummary } from "./shared";
import { SOURCE_TILES } from "./recordSources";

export interface RecordFilterValues {
  categoryId: number | null;
  source: RecordSource | null;
  importBatchId: number | null;
  dateFrom: string;
  dateTo: string;
  rangeLabel: string | null;
}

/**
 * The Records filters, in a sheet behind one button beside the search box.
 *
 * They used to open inline above the list, and with sixteen category chips
 * the panel filled the screen before a single record showed. Here the list
 * stays where it is; every change still applies as it is made, exactly as
 * before, and "Show results" only closes the sheet.
 *
 * CATEGORY IS ONE ROW, not sixteen chips. It opens a searchable list INSIDE
 * this sheet rather than a second sheet on top, because a modal presented
 * from inside another is unreliable on iOS.
 */
export function RecordFilterSheet({
  visible,
  onClose,
  values,
  categories,
  importBatches,
  importSearch = "",
  onImportSearch,
  importLoading = false,
  importError = null,
  hasMoreImports = false,
  onMoreImports,
  onRetryImports,
  onCategory,
  onSource,
  onImportBatch,
  onDates,
  onClear,
  activeCount,
}: {
  visible: boolean;
  onClose: () => void;
  values: RecordFilterValues;
  categories: readonly { id: number; name: string }[];
  importBatches: readonly ImportBatchSummary[];
  importSearch?: string;
  onImportSearch?: (value: string) => void;
  importLoading?: boolean;
  importError?: string | null;
  hasMoreImports?: boolean;
  onMoreImports?: () => void;
  onRetryImports?: () => void;
  onCategory: (id: number | null) => void;
  onSource: (source: RecordSource | null) => void;
  onImportBatch: (id: number | null) => void;
  onDates: (from: string, to: string, label: string | null) => void;
  onClear: () => void;
  activeCount: number;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { fontScale } = useWindowDimensions();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => {
    setPicking(false);
    setQuery("");
    onClose();
  };
  const category = categories.find((c) => c.id === values.categoryId) ?? null;
  const matches = categories.filter((c) => !query.trim() || c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const sectionLabel = (text: string) => (
    <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.textSecondary, marginBottom: space.sm }}>{text}</T>
  );

  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? "none" : "slide"} statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.scrim, justifyContent: "flex-end", paddingTop: insets.top + space.md }}>
        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close filters" style={StyleSheet.absoluteFill} />
        <View
          accessibilityViewIsModal
          onStartShouldSetResponder={() => true}
          style={{
            maxHeight: "88%",
            width: "100%",
            maxWidth: CONTENT_WIDTH,
            alignSelf: "center",
            backgroundColor: t.surfaceRaised,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingTop: space.md,
            paddingBottom: insets.bottom + space.md,
          }}
        >
          <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: t.borderStrong, marginBottom: space.sm }} />

          {picking ? (
            <View style={{ paddingHorizontal: space.lg, gap: space.sm, flexShrink: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to filters"
                  onPress={() => {
                    setPicking(false);
                    setQuery("");
                  }}
                  style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, justifyContent: "center" }}
                >
                  <Ionicons name="chevron-back" size={22} color={t.brandText} />
                </Pressable>
                <T variant="title" accessibilityRole="header">Category</T>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP_FLOOR, paddingHorizontal: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
                <Ionicons name="search" size={16} color={t.textMuted} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search categories"
                  placeholderTextColor={t.textMuted}
                  accessibilityLabel="Search categories"
                  style={{ flex: 1, minHeight: TAP_FLOOR, fontFamily: font.sans, fontSize: typeScale.body, color: t.textPrimary }}
                />
              </View>
              <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
                {[{ id: null as number | null, name: "Any category" }, ...matches].map((c) => {
                  const selected = values.categoryId === c.id;
                  return (
                    <Pressable
                      key={c.id ?? "any"}
                      accessibilityRole="button"
                      accessibilityLabel={c.name}
                      accessibilityState={{ selected }}
                      onPress={() => {
                        onCategory(c.id);
                        setPicking(false);
                        setQuery("");
                      }}
                      style={({ pressed }) => ({
                        minHeight: TAP_FLOOR + 4,
                        flexDirection: "row",
                        alignItems: "center",
                        paddingHorizontal: space.md,
                        borderRadius: radius.md,
                        backgroundColor: selected ? t.brandSurface : pressed ? t.surfaceMuted : "transparent",
                      })}
                    >
                      <T style={{ flex: 1, fontSize: typeScale.body, fontFamily: selected ? font.sansSemibold : font.sans, color: t.textPrimary }}>{c.name}</T>
                      {selected ? <Ionicons name="checkmark-circle" size={20} color={t.brandFill} /> : null}
                    </Pressable>
                  );
                })}
                {query.trim() && matches.length === 0 ? (
                  <T
                    accessibilityLiveRegion="polite"
                    style={{ paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: typeScale.body, fontFamily: font.sans, color: t.textMuted }}
                  >
                    {`No categories match "${query.trim()}".`}
                  </T>
                ) : null}
              </ScrollView>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, marginBottom: space.sm }}>
                <T variant="title" accessibilityRole="header">Filters</T>
                {activeCount > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Clear all filters"
                    onPress={onClear}
                    style={{ minHeight: TAP_FLOOR, justifyContent: "center", paddingHorizontal: space.xs }}
                  >
                    <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.textSecondary }}>Clear</T>
                  </Pressable>
                ) : null}
              </View>

              <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.lg, paddingBottom: space.md }}>
                <View>
                  {sectionLabel("When")}
                  {/*
                    Most filtering is "this week" or "this month" rather than two
                    specific dates, so those cost one tap and the pickers below
                    are only needed for a genuinely custom range.
                  */}
                  <DateRangeChips activeLabel={values.rangeLabel} onPick={(from, to, label) => onDates(from, to, label)} />
                  <View style={{ flexDirection: fontScale > 1.2 ? "column" : "row", gap: space.sm, marginTop: space.sm }}>
                    <View style={{ flex: 1 }}>
                      <DateField
                        label="From"
                        value={values.dateFrom}
                        optional
                        onChange={(v) => onDates(v, values.dateTo, null)}
                        onClear={() => onDates("", values.dateTo, null)}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <DateField
                        label="To"
                        value={values.dateTo}
                        optional
                        onChange={(v) => onDates(values.dateFrom, v, null)}
                        onClear={() => onDates(values.dateFrom, "", null)}
                      />
                    </View>
                  </View>
                </View>

                <View>
                  {sectionLabel("How it was added")}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    {SOURCE_TILES.map((tile) => {
                      const selected = values.source === tile.value;
                      return (
                        <Pressable
                          key={tile.value}
                          accessibilityRole="button"
                          accessibilityLabel={tile.label}
                          accessibilityState={{ selected }}
                          // Tapping the tile that is on turns it off: back to any source.
                          onPress={() => onSource(selected ? null : tile.value)}
                          style={({ pressed }) => ({
                            flex: 1,
                            minWidth: 100,
                            minHeight: 72,
                            alignItems: "center",
                            justifyContent: "center",
                            gap: space.xs,
                            borderRadius: radius.lg,
                            borderWidth: selected ? 1.5 : 1,
                            borderColor: selected ? t.brandBorder : t.border,
                            backgroundColor: selected ? t.brandSurface : pressed ? t.surfaceMuted : t.surface,
                          })}
                        >
                          <Ionicons name={tile.icon} size={22} color={selected ? t.brandText : t.textSecondary} />
                          <T style={{ textAlign: "center", fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: selected ? t.brandText : t.textSecondary }}>{tile.label}</T>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/*
                  Only once CSV file is the chosen source. "Which import" is
                  meaningless for a typed record, and a control that is usually
                  empty is worse than one that appears when it has something to say.
                */}
                {values.source === "CSV_UPLOAD" ? (
                  <View>
                    {sectionLabel("Which import")}
                    {onImportSearch ? <TextInput accessibilityLabel="Search imports" placeholder="Search import titles" placeholderTextColor={t.textMuted} value={importSearch} onChangeText={onImportSearch} style={{ minHeight: TAP_FLOOR, color: t.textPrimary, fontFamily: font.sans, fontSize: typeScale.body, borderWidth: 1, borderColor: t.borderStrong, borderRadius: radius.md, paddingHorizontal: space.md, marginBottom: space.sm }} /> : null}
                    {importLoading ? <T variant="caption">Loading imports…</T> : null}
                    {importError ? <View style={{ gap: space.sm }}><ErrorNote>{importError}</ErrorNote>{onRetryImports ? <Button title="Retry imports" variant="secondary" onPress={onRetryImports} /> : null}</View> : null}
                    {!importLoading && !importError && importBatches.length === 0 ? <T variant="caption">{importSearch.trim() ? "No imports match that title." : "No CSV imports for this business yet."}</T> : null}
                    <View>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                        <SelectChip label="All imports" selected={values.importBatchId === null} onPress={() => onImportBatch(null)} />
                        {values.importBatchId !== null && !importBatches.some((batch) => batch.id === values.importBatchId) ? <SelectChip label={`Selected import ${values.importBatchId}`} selected onPress={() => onImportBatch(null)} /> : null}
                        {importBatches.map((b) => (
                          <SelectChip
                            key={b.id}
                            label={b.title}
                            selected={values.importBatchId === b.id}
                            onPress={() => onImportBatch(values.importBatchId === b.id ? null : b.id)}
                          />
                        ))}
                      </View>
                      {hasMoreImports && onMoreImports ? <Button title="Load older imports" variant="secondary" loading={importLoading} onPress={onMoreImports} style={{ marginTop: space.sm }} /> : null}
                    </View>
                  </View>
                ) : null}

                <View>
                  {sectionLabel("Category")}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Category: ${category ? category.name : "any"}. Change`}
                    onPress={() => setPicking(true)}
                    style={({ pressed }) => ({
                      minHeight: 52,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.sm,
                      paddingHorizontal: space.md,
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderColor: category ? t.brandBorder : t.border,
                      backgroundColor: pressed ? t.surfaceMuted : category ? t.brandSurface : t.surface,
                    })}
                  >
                    <Ionicons name="pricetag-outline" size={18} color={category ? t.brandText : t.textSecondary} />
                    <T style={{ flex: 1, fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>{category ? category.name : "Any category"}</T>
                    <T variant="caption">{`${categories.length} categories`}</T>
                    <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
                  </Pressable>
                </View>
              </ScrollView>

              <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
                <Button title="Show results" variant="brand" onPress={close} />
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
