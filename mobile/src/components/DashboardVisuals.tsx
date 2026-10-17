import { Pressable, ScrollView, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import { SectionTitle as CoachSectionTitle } from "./CoachKit";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { RecordItem, RecurringSchedule } from "../lib/types";

/*
 * Home, drawn as figures and shapes first and words second.
 *
 * Every picture here also says its numbers: each chart is one accessible
 * element whose label states the figures it draws, so nothing is only a
 * shape. Money always wears the mono figure face.
 */

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Date-only values arrive at midnight UTC; read their parts in UTC so no zone shifts the day. */
function dateParts(value: string) {
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return { day: d.getUTCDate(), month: MONTH_ABBR[d.getUTCMonth()] ?? "", weekday: DAY_ABBR[d.getUTCDay()] ?? "" };
}

// ---------------------------------------------------------------- section heading

/** A card heading in the shared question style, with an optional text link on the right. */
export function SectionTitle({
  title,
  action,
  onAction,
  icon = "repeat-outline",
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: space.sm }}>
      <CoachSectionTitle
        question={title}
        icon={icon}
        right={
          action && onAction ? (
            <Pressable accessibilityRole="link" onPress={onAction} hitSlop={8} style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: 2 }}>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.label, color: t.brandText }}>{action}</T>
              <Ionicons name="chevron-forward" size={14} color={t.brandText} />
            </Pressable>
          ) : undefined
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------- compact records

/** One card, one line per record: what, when, how much. Signed so in and out read at a glance. */
export function CompactRecords({
  records,
  categoryName,
  onOpen,
}: {
  records: RecordItem[];
  categoryName: (id: number | undefined) => string;
  onOpen: (record: RecordItem) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ borderRadius: radius.lg, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, overflow: "hidden" }}>
      {records.map((r, i) => {
        const sale = r.type === "sales";
        const parts = dateParts(r.date);
        const flagged = r.reviewStatus === "Needs Review" || r.duplicateStatus === "Flagged";
        const meta = `${parts.month} ${parts.day} · ${sale ? "Sales" : categoryName(r.categoryId)}`;
        return (
          <Pressable
            key={`${r.type}-${r.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${r.description}, ${sale ? "sale" : "expense"} ${formatMoney(r.amount)}, ${meta}${flagged ? ", needs review" : ""}`}
            onPress={() => onOpen(r)}
            style={({ pressed }) => ({
              minHeight: 60,
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              backgroundColor: pressed ? t.surfaceMuted : "transparent",
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: t.border,
            })}
          >
            <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: sale ? t.brandSurface : t.surfaceMuted }}>
              <Ionicons name={sale ? "arrow-down" : "arrow-up"} size={16} color={sale ? t.brandText : t.textSecondary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T numberOfLines={1} style={{ fontFamily: font.sansMedium, fontSize: typeScale.bodySm, color: t.textPrimary }}>{r.description}</T>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                {flagged ? <Ionicons name="flag" size={11} color={t.statusText.serious} /> : null}
                <T numberOfLines={1} variant="caption" style={{ flexShrink: 1 }}>{meta}</T>
              </View>
            </View>
            <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, color: sale ? t.brandText : t.textPrimary }}>
              {`${sale ? "+" : "−"}${formatMoney(r.amount, { bare: true })}`}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- upcoming strip

/** Repeating payments as date tiles: the day is the biggest thing on each. */
export function UpcomingStrip({ schedules, onOpen }: { schedules: RecurringSchedule[]; onOpen: (s: RecurringSchedule) => void }) {
  const t = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
      {schedules.map((s) => {
        const parts = dateParts(s.nextDueDate.slice(0, 10));
        const overdue = s.dueState === "OVERDUE";
        const soon = s.dueState === "DUE_SOON";
        const state = overdue ? "Overdue" : soon ? "Due soon" : "Scheduled";
        return (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityLabel={`${s.label}, ${formatMoney(s.expectedAmount)}, ${state}, ${parts.month} ${parts.day}`}
            onPress={() => onOpen(s)}
            style={({ pressed }) => ({
              width: 128,
              padding: space.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: overdue ? t.statusBorder.critical : t.border,
              backgroundColor: pressed ? t.surfaceMuted : overdue ? t.statusSurface.critical : t.surface,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
              <T style={{ fontFamily: font.displayBold, fontSize: typeScale.titleLg, color: overdue ? t.statusText.critical : t.textPrimary }}>{parts.day}</T>
              <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textMuted }}>{parts.month}</T>
            </View>
            <T numberOfLines={1} style={{ marginTop: 2, fontFamily: font.sansMedium, fontSize: typeScale.label, color: t.textPrimary }}>{s.label}</T>
            <T style={{ marginTop: 2, fontFamily: font.mono, fontSize: typeScale.caption, color: t.textSecondary }}>{formatMoney(s.expectedAmount)}</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: space.sm }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: overdue ? t.status.critical : soon ? t.status.warning : t.status.good }} />
              <T style={{ fontSize: typeScale.micro, color: overdue ? t.statusText.critical : t.textMuted }}>{state}</T>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
