import { memo, useEffect, useRef } from "react";
import { Pressable, TextInput, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Callout, Field, T } from "../../../components/ui";
import { ResultDetails } from "../../../components/ResultDetails";
import { font, radius, space, typeScale } from "../../../theme/tokens";
import { useTheme } from "../../../context/ThemeContext";
import { CORRECTABLE_FIELDS, type AnalysedRow, type CorrectableField, type ImportRowCategory, type RowCorrection, type RowProblem } from "../../../lib/csvImport";
import { FIELD_LIMITS } from "../../../lib/fieldLimits";
import { formatMoney } from "../../../lib/money";
import { parseSignedAmount } from "../../../lib/recordTypeDetection";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { FIELD_LABELS } from "./constants";

interface Props {
  row: AnalysedRow;
  categoryDecision?: ImportRowCategory;
  corrected: RowCorrection;
  editing: boolean;
  draft?: RowCorrection;
  draftError?: RowProblem | null;
  selecting: boolean;
  selected: boolean;
  disabled: boolean;
  duplicate: boolean;
  duplicateStale: boolean;
  signedAmounts: boolean;
  sourceRow: Record<string, string>;
  onEdit: (rowNumber: number) => void;
  onEditorLayout: (rowNumber: number) => void;
  onDraftChange: (field: CorrectableField, value: string) => void;
  onSelect: (rowNumber: number) => void;
  onRestore: (rowNumber: number) => void;
  baselineDate?: string;
  baselineDecision?: boolean | null;
  rowDate: string | null;
  onDraftBaseline: (value: boolean | undefined) => void;
}

export const ReviewRowCard = memo(function ReviewRowCard({
  row, categoryDecision, corrected, editing, draft, draftError, selecting, selected, disabled, duplicate, duplicateStale, signedAmounts,
  sourceRow, onEdit, onEditorLayout, onDraftChange, onSelect, onRestore, baselineDate, baselineDecision,
  rowDate, onDraftBaseline,
}: Props) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stackedSummary = fontScale > 1.2;
  const stackedFields = width < 360 || fontScale > 1.2;
  const inputs = useRef<Partial<Record<CorrectableField, TextInput | null>>>({});
  useEffect(() => {
    if (draftError) inputs.current[draftError.field as CorrectableField]?.focus();
  }, [draftError]);
  const amount = parseSignedAmount(row.values.amount);
  const money = amount === null ? row.values.amount || "No amount" : formatMoney(signedAmounts ? Math.abs(amount) : amount, { decimals: true });
  const edited = CORRECTABLE_FIELDS.some((field) => corrected[field] !== undefined);
  const fields: CorrectableField[] = row.rowType === "sales"
    ? ["date", "description", "amount"]
    : ["date", "description", "amount", "category", "vendor"];
  const category = corrected.category || categoryDecision?.name || row.values.category;
  const categoryEdited = corrected.category !== undefined;
  const categoryStatus = categoryEdited ? "Edited category" : !categoryDecision ? "" : categoryDecision.source === "none" ? "No category" : categoryDecision.isNew ? "New category" : categoryDecision.source === "history" || categoryDecision.source === "suggested" ? categoryDecision.confidence === "low" ? "Suggested category, check" : "Suggested category" : "Category from file";
  const value = (field: CorrectableField) => draft?.[field] ?? (field === "category" ? category : row.values[field]);
  const sourceLabel = row.values.description || "No description";
  const excluded = row.excluded;
  const label = selecting
    ? `Select row ${row.rowNumber}, ${sourceLabel}`
    : excluded
      ? `Restore row ${row.rowNumber}`
      : `Row ${row.rowNumber}, ${sourceLabel}. ${editing ? "Editing this row" : "Edit this row"}`;
  const rowDetails = `${row.values.date || "No date"}, ${money}, ${row.rowType === "sales" ? "Sale" : row.rowType === "expense" ? "Expense" : "Unknown type"}${row.rowType !== "sales" && category ? `, Category: ${category}` : ""}${row.rowType !== "sales" && categoryStatus ? `, ${categoryStatus}${duplicateStale ? ", awaiting check" : ""}` : ""}${row.excluded ? ", excluded from this import" : row.problem ? `, ${row.problem.reason}` : ""}${duplicate && !excluded ? duplicateStale ? ", previously flagged, check again" : ", possible duplicate" : ""}`;
  const renderField = (field: CorrectableField) => (
    <Field
      key={field}
      ref={(node) => { inputs.current[field] = node; }}
      label={FIELD_LABELS[field]}
      value={value(field)}
      onChangeText={(next: string) => onDraftChange(field, next)}
      keyboardType={field === "amount" && !signedAmounts ? "decimal-pad" : "default"}
      autoCapitalize={field === "date" ? "none" : "sentences"}
      accessibilityHint={field === "date" ? "You can use year-month-day, for example 2026-09-01." : undefined}
      error={draftError?.field === field ? draftError.reason : undefined}
      maxLength={field === "description" ? FIELD_LIMITS.recordDescription : field === "category" ? FIELD_LIMITS.categoryName : field === "vendor" ? FIELD_LIMITS.vendor : field === "amount" ? 50 : 100}
    />
  );

  return (
    <View testID={`csv-row-${row.rowNumber}`} style={{
      borderBottomWidth: 1, borderBottomColor: t.border,
      backgroundColor: editing || selected ? t.brand[50] : t.surface,
      paddingHorizontal: space.md,
      borderLeftWidth: editing ? 3 : 0, borderLeftColor: t.brandFill,
    }}>
      <Pressable
        disabled={disabled || selecting && excluded}
        onPress={() => selecting ? onSelect(row.rowNumber) : excluded ? onRestore(row.rowNumber) : onEdit(row.rowNumber)}
        accessibilityRole={selecting ? "checkbox" : "button"}
        accessibilityLabel={`${label}. ${rowDetails}`}
        accessibilityState={selecting ? { checked: selected, disabled: disabled || excluded } : { expanded: editing, disabled }}
        style={{ minHeight: TAP_FLOOR, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm }}
      >
        {selecting ? (
          <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? t.brandText : t.textMuted} accessible={false} />
        ) : null}
        <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
          <View style={{ flexDirection: stackedSummary ? "column" : "row", flexWrap: "wrap", alignItems: stackedSummary ? "flex-start" : "baseline", gap: space.sm }}>
            <T style={{ flex: stackedSummary ? undefined : 1, minWidth: 0, color: t.textPrimary, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }} numberOfLines={editing ? undefined : 2}>
              {sourceLabel}
            </T>
            <T style={{ color: t.textPrimary, fontFamily: font.monoMedium, fontSize: typeScale.label }}>{money}</T>
          </View>
          <T variant="caption">
            {row.values.date || "No date"} · {row.rowType === "sales" ? "Sale" : row.rowType === "expense" ? "Expense" : "Unknown type"} · Row {row.rowNumber}
            {row.rowType !== "sales" && category ? ` · ${category}` : ""}
          </T>
          {row.rowType !== "sales" && categoryDecision && !categoryEdited ? <T variant="caption">
            {categoryDecision.source === "none" ? "No category" : categoryDecision.isNew ? "New category" : categoryDecision.source === "history" || categoryDecision.source === "suggested" ? categoryDecision.confidence === "low" ? "Suggested category · Check" : "Suggested category" : "Category from file"}{duplicateStale ? " · Awaiting check" : ""}
          </T> : null}
          {excluded ? <T variant="caption" style={{ color: t.statusText.warning }}>Excluded from this import · Tap to restore</T>
            : row.problem ? <View style={{ flexDirection: "row", gap: space.xs, alignItems: "flex-start" }}><Ionicons name="alert-circle" size={16} color={t.statusText.warning} accessible={false} /><T variant="caption" style={{ flex: 1, color: t.statusText.warning }}>{row.problem.reason}</T></View>
            : edited ? <T variant="caption" style={{ color: t.brandText }}>Edited · {duplicateStale ? "Awaiting check" : "Checked"}</T> : null}
          {duplicate && !excluded ? <View style={{ flexDirection: "row", gap: space.xs, alignItems: "flex-start" }}><Ionicons name="alert-circle" size={16} color={t.statusText.warning} accessible={false} /><T variant="caption" style={{ flex: 1, color: t.statusText.warning }}>{duplicateStale ? "Previously flagged · Check again" : "Possible duplicate · Flagged if imported"}</T></View> : null}
        </View>
        {!selecting ? <Ionicons name={excluded ? "arrow-undo-outline" : editing ? "chevron-up" : "chevron-down"} size={18} color={t.textMuted} accessible={false} /> : null}
      </Pressable>
      {editing ? (
        <View onLayout={() => onEditorLayout(row.rowNumber)} style={{ paddingBottom: space.md }}>
          <T variant="caption" style={{ marginBottom: space.md }}>Editing row {row.rowNumber}. Your original file stays the same.</T>
          {signedAmounts ? <Callout tone="info">Positive amounts are sales. Negative amounts are expenses. Keep the minus sign for an expense.</Callout> : null}
          <View style={{ flexDirection: stackedFields ? "column" : "row", gap: stackedFields ? 0 : space.sm }}>
            <View style={{ flex: stackedFields ? undefined : 1, minWidth: 0 }}>{renderField("date")}</View>
            <View style={{ flex: stackedFields ? undefined : 1, minWidth: 0 }}>{renderField("amount")}</View>
          </View>
          <T variant="caption" style={{ marginBottom: space.md }}>Date example: 2026-09-01 (year-month-day).</T>
          {fields.filter((field) => field !== "date" && field !== "amount").map(renderField)}
          {row.problem?.field === "recordType" ? <Callout tone="warn">Change the sale/expense column in Detected columns, or exclude this row from the import.</Callout> : null}
          {baselineDate && rowDate === baselineDate && baselineDecision !== null && baselineDecision !== undefined ? (
            <View style={{ gap: space.sm, marginBottom: space.md }}>
              <T variant="label">Recorded balance</T>
              <T variant="caption">Override the import answer only when this row happened on the other side of the recorded balance.</T>
              {([[undefined, `Use import answer (${baselineDecision ? "already included" : "after balance"})`], [true, "Already included"], [false, "After the balance"]] as const).map(([answer, title]) => (
                <Pressable
                  key={title}
                  accessibilityRole="radio"
                  accessibilityLabel={`${title}, row ${row.rowNumber}`}
                  accessibilityState={{ checked: draft?.includedInAvailableFundsBaseline === answer }}
                  onPress={() => onDraftBaseline(answer)}
                  style={{ minHeight: TAP_FLOOR, justifyContent: "center", borderWidth: 1, borderColor: draft?.includedInAvailableFundsBaseline === answer ? t.brandFill : t.border, borderRadius: radius.md, padding: space.md }}
                ><T>{title}</T></Pressable>
              ))}
            </View>
          ) : null}
          <ResultDetails label={`source columns for row ${row.rowNumber}`}>
            {Object.entries(sourceRow).map(([key, cell]) => <T key={key} variant="caption" selectable>{key}: {cell || "(empty)"}</T>)}
            <T variant="caption">Unmapped columns are shown for reference and are not imported.</T>
          </ResultDetails>
        </View>
      ) : null}
    </View>
  );
});
