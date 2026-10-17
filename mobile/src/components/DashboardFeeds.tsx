import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, T } from "./ui";
import { CompactRecords } from "./DashboardVisuals";
import { DateTile, SectionTitle } from "./CoachKit";
import { formatMoney } from "../lib/money";
import { SkeletonBox } from "./Skeleton";
import { useTheme } from "../context/ThemeContext";
import { useInsight } from "../lib/useInsight";
import { recurringAvailability } from "../lib/recurringAgenda";
import { upcomingSchedules } from "../lib/dashboardFigures";
import { font, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import type { ExpenseCategory, RecordItem, RecurringSchedule } from "../lib/types";

function SectionHead({
  title,
  icon,
  actionLabel,
  onAction,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: space.sm }}>
      <SectionTitle
        question={title}
        icon={icon}
        right={actionLabel && onAction ? (
        <Pressable
          accessibilityRole="link"
          onPress={onAction}
          hitSlop={8}
          style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: 2 }}
        >
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.label, color: t.brandText }}>{actionLabel}</T>
          <Ionicons name="chevron-forward" size={14} color={t.brandText} />
        </Pressable>
      ) : undefined}
      />
    </View>
  );
}

/** Repeating payments as a dated list: the due date is the first thing on each row. */
function UpcomingList({ schedules, onOpen }: { schedules: RecurringSchedule[]; onOpen: (s: RecurringSchedule) => void }) {
  const t = useTheme();
  return (
    <Card>
      {schedules.map((s, i) => {
        const overdue = s.dueState === "OVERDUE";
        const soon = s.dueState === "DUE_SOON";
        const state = overdue ? "Overdue" : soon ? "Due soon" : "Scheduled";
        return (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityLabel={`${s.label}, ${formatMoney(s.expectedAmount)}, ${state}, due ${s.nextDueDate.slice(0, 10)}`}
            onPress={() => onOpen(s)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              minHeight: TAP_FLOOR + 12,
              paddingVertical: space.sm,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: t.border,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <DateTile iso={s.nextDueDate} />
            <View style={{ flex: 1 }}>
              <T numberOfLines={1} style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>{s.label}</T>
              <T variant="caption" style={{ color: overdue ? t.statusText.critical : soon ? t.statusText.warning : t.textMuted }}>{state}</T>
            </View>
            <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>{formatMoney(s.expectedAmount)}</T>
          </Pressable>
        );
      })}
    </Card>
  );
}

function FeedFailure({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <Card>
      <T variant="caption">{`${label} couldn't load.`}</T>
      <Button title="Try again" variant="ghost" onPress={onRetry} style={{ marginTop: space.sm }} />
    </Card>
  );
}

interface RecordPage {
  items: RecordItem[];
  nextCursor: string | null;
}

/** The newest records in the selected period, in the same cards as the Records tab. */
export function RecentRecords({
  businessProfileId,
  range,
  periodText,
  categories,
  onOpen,
  onViewAll,
}: {
  businessProfileId: number;
  /** Null for All time. */
  range: { dateFrom: string; dateTo: string } | null;
  /** "this week", "in August". */
  periodText: string;
  categories: readonly ExpenseCategory[];
  onOpen: (record: RecordItem) => void;
  onViewAll: () => void;
}) {
  const feed = useInsight<RecordPage>(
    "/records/search",
    { businessProfileId, type: "all", limit: 5, sort: "date_desc", ...(range ?? {}) },
    [businessProfileId, range?.dateFrom, range?.dateTo],
  );
  const items = feed.data?.items;
  return (
    <View>
      <SectionHead title="Recent records" icon="list-outline" actionLabel="View all" onAction={onViewAll} />
      {feed.rawError && !items ? (
        <FeedFailure label="Recent records" onRetry={() => void feed.load()} />
      ) : !items ? (
        <View accessible accessibilityLabel="Loading recent records" style={{ gap: space.sm }}>
          <SkeletonBox height={72} />
          <SkeletonBox height={72} />
        </View>
      ) : items.length === 0 ? (
        <Card>
          <T variant="caption">{`No records ${periodText}.`}</T>
        </Card>
      ) : (
        <CompactRecords
          records={items}
          categoryName={(id) => categories.find((c) => c.id === id)?.name ?? "Expense"}
          onOpen={onOpen}
        />
      )}
    </View>
  );
}

/**
 * The next few repeating payments. Hidden entirely where the server gates the
 * feature off (404): a card saying "not available" on Home is noise.
 */
export function UpcomingExpenses({
  businessProfileId,
  onOpen,
  onManage,
  onAdd,
}: {
  businessProfileId: number;
  onOpen: (schedule: RecurringSchedule) => void;
  onManage: () => void;
  onAdd: () => void;
}) {
  const feed = useInsight<RecurringSchedule[]>(
    "/insights/recurring-schedules",
    { businessProfileId },
    [businessProfileId],
  );
  const availability = recurringAvailability({ data: feed.data, error: feed.rawError });
  if (feed.rawError && availability.schedules === null && availability.failure === null) return null;
  const schedules = availability.schedules ? upcomingSchedules(availability.schedules) : null;
  return (
    <View>
      <SectionHead title="Bills coming up" icon="calendar-outline" actionLabel="Manage" onAction={onManage} />
      {availability.failure === "initial" ? (
        <FeedFailure label="Upcoming expenses" onRetry={() => void feed.load()} />
      ) : !schedules ? (
        <SkeletonBox height={72} />
      ) : schedules.length === 0 ? (
        <Card>
          <T style={{ fontFamily: font.sansMedium }}>No active repeating payments</T>
          <T variant="caption" style={{ marginTop: 2 }}>
            Add rent, bills or other repeat expenses to see what is coming up.
          </T>
          <Button title="Add a repeating payment" variant="ghost" onPress={onAdd} style={{ marginTop: space.sm }} />
        </Card>
      ) : (
        <UpcomingList schedules={schedules} onOpen={onOpen} />
      )}
    </View>
  );
}

