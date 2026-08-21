import { useState } from "react";
import { Pressable, View } from "react-native";
import { Card, Callout, Field, T } from "../../../components/ui";
import { Ionicons } from "@expo/vector-icons";
import { font, ink, paper, space, status, statusText, TAP, typeScale } from "../../../theme/tokens";
import type { AnalysedRow, CorrectableField } from "../../../lib/csvImport";
import { FIELD_LIMITS } from "../../../lib/fieldLimits";
import { FIELD_LABELS } from "./constants";

/**
 * One row of the file, as FinSight will read it.
 *
 * A CARD PER ROW, not a copy of the web table. A phone cannot show five
 * columns of a spreadsheet legibly, and the thing the owner is actually doing
 * here is answering "is this row right, and if not, what should it say" —
 * which is a form, not a grid.
 *
 * Only the four correctable fields get inputs, because those are the four the
 * server's `corrections` schema accepts. A problem with the vendor or the
 * sale/expense column is reported and sent back to the mapping step instead of
 * offering an edit the server would ignore.
 */
export function ReviewRowCard({
  row,
  corrected,
  onCorrect,
}: {
  row: AnalysedRow;
  corrected: Partial<Record<CorrectableField, string>>;
  onCorrect: (field: CorrectableField, value: string) => void;
}) {
  const [open, setOpen] = useState(row.problem !== null);
  const broken = row.problem !== null;

  return (
    <Card style={{ borderColor: broken ? status.warning : paper[200] }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={
          broken
            ? `Row ${row.rowNumber}, ${row.problem!.reason}. ${open ? "Hide" : "Show"} the fields to fix it`
            : `Row ${row.rowNumber}, ${row.values.description || "no description"}. ${open ? "Hide" : "Show"} its values`
        }
        style={{ minHeight: TAP, justifyContent: "center" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T style={{ fontSize: typeScale.micro, fontFamily: font.monoMedium, color: ink[500] }}>
            Row {row.rowNumber}
          </T>
          {/* Words and a glyph, never colour alone. */}
          {broken ? (
            <T style={{ fontSize: typeScale.micro, color: statusText.warning, fontFamily: font.sansSemibold }}>
              ⚠ Needs fixing
            </T>
          ) : Object.keys(corrected).length > 0 ? (
            <T style={{ fontSize: typeScale.micro, color: statusText.good, fontFamily: font.sansSemibold }}>
              ✓ Fixed
            </T>
          ) : null}
          {row.rowType ? (
            <T style={{ fontSize: typeScale.micro, color: ink[500] }}>
              {row.rowType === "sales" ? "Sale" : "Expense"}
            </T>
          ) : null}
          <View style={{ flex: 1 }} />
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={ink[400]} />
        </View>
        <T style={{ fontSize: typeScale.bodySm, color: ink[900], marginTop: 2 }} numberOfLines={1}>
          {row.values.description || "(no description)"}
        </T>
        {broken ? (
          <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
            {row.problem!.reason}
          </T>
        ) : (
          <T variant="caption" style={{ marginTop: 2 }}>
            {row.values.date} · {row.values.amount}
            {row.values.category ? ` · ${row.values.category}` : ""}
          </T>
        )}
      </Pressable>

      {open ? (
        <View style={{ marginTop: space.sm }}>
          {(["date", "description", "amount", "category"] as CorrectableField[]).map((field) => (
            <Field
              key={field}
              label={FIELD_LABELS[field]}
              value={row.values[field]}
              onChangeText={(v: string) => onCorrect(field, v)}
              keyboardType={field === "amount" ? "decimal-pad" : "default"}
              error={row.problem?.field === field ? row.problem.reason : undefined}
              maxLength={
                field === "description"
                  ? FIELD_LIMITS.recordDescription
                  : field === "category"
                    ? FIELD_LIMITS.categoryName
                    : undefined
              }
            />
          ))}
          {row.values.vendor ? (
            <T variant="caption">Vendor: {row.values.vendor}</T>
          ) : null}
          {row.problem && !(["date", "description", "amount", "category"] as string[]).includes(row.problem.field) ? (
            <Callout tone="warn">
              This one can't be fixed here — it comes from the {FIELD_LABELS[row.problem.field]} column. Go
              back to the columns, or leave the row to be skipped.
            </Callout>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
