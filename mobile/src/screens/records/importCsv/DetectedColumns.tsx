import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "../../../components/ui";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { useTheme } from "../../../context/ThemeContext";
import { offeredFields, requiredFields, type ColumnMapping, type ImportRecordType, type MappingCheck, type MappedField, type MixedStrategy } from "../../../lib/csvImport";
import { radius, space } from "../../../theme/tokens";
import { FIELD_LABELS } from "./constants";

export type ExtraField = "paymentMethod" | "notes" | "reference" | "quantity" | "customer" | "unitPrice";
export interface UnmappedColumn { header: string; field: ExtraField | null }

const EXTRA_LABELS: Record<ExtraField, string> = {
  paymentMethod: "Payment method",
  notes: "Notes",
  reference: "Reference",
  quantity: "Quantity",
  customer: "Customer",
  unitPrice: "Unit price",
};

export function DetectedColumns({ mapping, recordType, mixedStrategy, check, previewRows, unmapped, disabled, onChoose }: {
  mapping: ColumnMapping;
  recordType: ImportRecordType;
  mixedStrategy: MixedStrategy;
  check: MappingCheck;
  previewRows: Record<string, string>[];
  unmapped: UnmappedColumn[];
  disabled: boolean;
  onChoose: (field: MappedField) => void;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(!check.ready);
  useEffect(() => { if (!check.ready) setExpanded(true); }, [check.ready]);
  const fields = offeredFields(recordType, mixedStrategy);
  const required = requiredFields(recordType, mixedStrategy);
  const used = new Set(fields.map((field) => mapping[field]).filter(Boolean));
  const notImported = [
    ...unmapped,
    ...(recordType === "sales" ? [mapping.category, mapping.vendor].filter(Boolean).map((header) => ({ header, field: null })) : []),
  ].filter((entry, index, entries) => !used.has(entry.header) && entries.findIndex((other) => other.header === entry.header) === index);

  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Show less" : "Show more"}, detected columns`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}
      >
        <T variant="heading">Detected columns</T>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} color={t.brandText} size={18} accessible={false} />
      </Pressable>
      {expanded ? fields.map((field) => {
        const column = mapping[field];
        const missing = required.includes(field) && !column;
        const clash = column && check.duplicated.includes(column);
        return (
          <View key={field} style={{ gap: space.xs }}>
            <T variant="label">{FIELD_LABELS[field]}{required.includes(field) ? "" : " (optional)"}</T>
            <Pressable
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Choose column for ${FIELD_LABELS[field]}, ${column || "not found"}`}
              accessibilityState={{ disabled }}
              onPress={() => onChoose(field)}
              style={{ minHeight: TAP_FLOOR, borderWidth: 1, borderColor: missing || clash ? t.statusText.critical : t.borderStrong, borderRadius: radius.md, padding: space.md, backgroundColor: t.surface, flexDirection: "row", alignItems: "center", gap: space.sm }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                <T>{column || (required.includes(field) ? "Choose a column" : "Not in file")}</T>
                {column ? <T variant="caption">Example: {previewRows.find((row) => row[column]?.trim())?.[column] || "(empty)"}</T> : null}
              </View>
              <Ionicons name="chevron-down" color={t.textMuted} size={16} accessible={false} />
            </Pressable>
            {missing ? <T variant="caption" style={{ color: t.statusText.critical }}>Not found. Choose the column above.</T> : clash ? <T variant="caption" style={{ color: t.statusText.critical }}>This column is used twice. Choose a different column.</T> : null}
          </View>
        );
      }) : <T variant="caption">Columns matched automatically. Open to change a match.</T>}
      {notImported.length > 0 ? <T variant="caption">Not imported: {notImported.map((entry) => entry.field ? `${entry.header} (${EXTRA_LABELS[entry.field]})` : entry.header).join(", ")}.</T> : null}
    </View>
  );
}
