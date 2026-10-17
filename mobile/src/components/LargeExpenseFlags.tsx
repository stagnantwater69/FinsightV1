import { View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, T } from "./ui";
import { SectionTitle } from "./CoachKit";
import { SkeletonBox } from "./Skeleton";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { flagReasonText } from "../lib/flagReasons";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { ExpenseCategory, RecordItem } from "../lib/types";

export function LargeExpenseFlags({
  items,
  loading,
  error,
  onRetry,
  profile,
  categories,
  flaggedTotal,
  onReviewAll,
}: {
  items: RecordItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  profile: { expectedMonthlyExpenses: number; largeExpenseThresholdPercent: number };
  categories: readonly ExpenseCategory[];
  /** Expenses flagged in total, from /records/flagged/count; null when that count failed. */
  flaggedTotal: number | null;
  onReviewAll: () => void;
}) {
  const t = useTheme();
  const total = flaggedTotal;
  const visible = items;
  const categoryName = (id: number | undefined) => categories.find((c) => c.id === id)?.name ?? "Expense";

  if (!loading && !error && total === 0 && items.length === 0) return null;

  return (
    <Card>
      {visible.length > 0 || loading || error ? <SectionTitle
        question="Large expense flags"
        icon="flag-outline"
        tone="critical"
        right={
          total !== null && total > 0 ? (
            <View style={{ borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 3, backgroundColor: t.statusSurface.critical }}>
              <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: t.statusText.critical }}>{`${total} flagged`}</T>
            </View>
          ) : undefined
        }
      /> : null}
      {error && items.length === 0 ? (
        <View style={{ marginTop: space.md }}>
          <T variant="caption">Flagged records couldn't load.</T>
          <Button title="Try again" accessibilityLabel="Try again, flagged records" variant="ghost" onPress={() => onRetry()} style={{ marginTop: space.sm }} />
        </View>
      ) : loading ? (
        <View accessible accessibilityLabel="Loading flagged records" style={{ gap: space.sm, marginTop: space.md }}>
          <SkeletonBox height={56} />
          <SkeletonBox height={56} />
        </View>
      ) : (
        <View style={{ marginTop: space.md, gap: space.sm }}>
          {visible.map((r) => (
            <View
              key={r.id}
              accessible
              accessibilityLabel={`${r.description}, ${formatMoney(r.amount)}, ${categoryName(r.categoryId)}, ${r.date.slice(0, 10)}, ${flagReasonText(r, profile)}`}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: space.md,
                padding: space.md,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.surfaceSunken,
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: t.statusSurface.critical, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="flag" size={15} color={t.statusText.critical} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                  <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.textPrimary }}>
                    {r.description}
                  </T>
                  <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, color: t.statusText.critical }}>{formatMoney(r.amount)}</T>
                </View>
                <T variant="caption" numberOfLines={2} style={{ marginTop: 2 }}>
                  {`${categoryName(r.categoryId)} · ${r.date.slice(0, 10)} · ${flagReasonText(r, profile)}`}
                </T>
              </View>
            </View>
          ))}
          <Button title={total === null ? "Review all flagged records" : `Review all ${total} flagged`} variant="secondary" onPress={onReviewAll} />
        </View>
      )}
    </Card>
  );
}
