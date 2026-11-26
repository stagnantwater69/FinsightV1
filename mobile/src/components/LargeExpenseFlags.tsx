import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, T } from "./ui";
import { SkeletonBox } from "./Skeleton";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { flagReasonText } from "../lib/flagReasons";
import { formatDueDate } from "../lib/recurringAgenda";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { ExpenseCategory, RecordItem } from "../lib/types";

/**
 * The flagged records on this Review page, expenses and sales alike. A row
 * opens that one record (FlagDetailScreen), where it is compared with the
 * record it may copy and decided. Whole re-imported files are decided in bulk
 * by ImportDuplicateCards above this list.
 */
export function LargeExpenseFlags({
  items,
  loading,
  error,
  onRetry,
  profile,
  categories,
  flaggedTotal,
  onOpen,
}: {
  items: RecordItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  profile: { expectedMonthlyExpenses: number; largeExpenseThresholdPercent: number };
  categories: readonly ExpenseCategory[];
  /** Records flagged in total, from /records/flagged/count; null when that count failed. */
  flaggedTotal: number | null;
  onOpen: (record: RecordItem) => void;
}) {
  const t = useTheme();
  const total = flaggedTotal;
  const visible = items;
  const categoryName = (r: RecordItem) => r.type === "sales" ? "Sale" : categories.find((c) => c.id === r.categoryId)?.name ?? "Expense";

  if (!loading && !error && total === 0 && items.length === 0) return null;

  // A later Review page can hold only findings.
  if (!loading && !error && visible.length === 0) return null;

  const allDuplicates = visible.length > 0 && visible.every((r) => r.duplicateStatus === "Flagged" && !r.largeExpenseFlag);
  const reason = (r: RecordItem) => {
    const text = flagReasonText(r, profile);
    return text.charAt(0).toUpperCase() + text.slice(1);
  };

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T accessibilityRole="header" style={{ flex: 1, fontSize: typeScale.subpageTitle, fontFamily: font.sansSemibold, color: t.textPrimary }}>Flagged records</T>
          {total !== null && total > 0 ? (
            <View style={{ borderRadius: radius.full, paddingHorizontal: space.md, paddingVertical: space.xs, backgroundColor: t.statusSurface.warning }}>
              <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.statusText.warning }}>{`${total} to review`}</T>
            </View>
          ) : null}
        </View>
        <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>
          {allDuplicates ? "Check these records for possible duplicates." : "Check these large or repeated records."}
        </T>
      </View>

      {error && items.length === 0 ? (
        <Card>
          <T variant="caption">Flagged records couldn't load.</T>
          <Button title="Try again" accessibilityLabel="Try again, flagged records" variant="ghost" onPress={() => onRetry()} style={{ marginTop: space.sm }} />
        </Card>
      ) : loading ? (
        <Card>
          <View accessible accessibilityLabel="Loading flagged records" style={{ gap: space.sm }}>
            <SkeletonBox height={56} />
            <SkeletonBox height={56} />
          </View>
        </Card>
      ) : (
        <>
          <Card style={{ paddingVertical: space.xs }}>
            {visible.map((r, index) => {
              const duplicate = r.duplicateStatus === "Flagged";
              return (
                <Pressable
                  key={r.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.description}, ${formatMoney(r.amount)}, ${categoryName(r)}, ${r.date.slice(0, 10)}, ${flagReasonText(r, profile)}. Check this record.`}
                  onPress={() => onOpen(r)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    paddingVertical: space.md,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: t.border,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  {/* Coloured because it says why: a copy for a duplicate, a flag for a large expense. */}
                  <Ionicons name={duplicate ? "copy-outline" : "flag-outline"} size={22} color={t.statusText.warning} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                      {/* One line: the full description is on the record's own screen. */}
                      <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>
                        {r.description.split(";")[0].trim() || r.description}
                      </T>
                      <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.body, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(r.amount)}</T>
                    </View>
                    <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }} numberOfLines={1}>{`${categoryName(r)} · ${formatDueDate(r.date) || r.date.slice(0, 10)}`}</T>
                    <T numberOfLines={2} style={{ fontSize: typeScale.bodySm, color: t.statusText.warning }}>{reason(r)}</T>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
                </Pressable>
              );
            })}
          </Card>
        </>
      )}
    </View>
  );
}
