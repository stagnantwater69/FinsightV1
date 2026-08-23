import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../lib/haptics";
import { Card, Money, SegmentedControl, T } from "./ui";
import { agendaGroupOf, formatDueDate, type AgendaGroupKey } from "../lib/recurringAgenda";
import { formatMoney } from "../lib/money";
import { TAP, font, radius, space, typeScale } from "../theme/tokens";
import type { Palette } from "../theme/palette";
import { useTheme } from "../context/ThemeContext";
import type { RecurringSchedule } from "../lib/types";

/*
 * The soft surfaces a status pill sits on used to be four literals declared
 * here and re-declared in RecordCard, because tokens.ts carried the status
 * FILLS and the darkened TEXT steps but no tinted backgrounds. They are
 * `statusSurface` in theme/palette.ts now — one name, resolved per theme, so
 * a status wash is a deep tint on a dark card instead of a pale one that
 * glows.
 */

/*
 * The tab values are screen names. Selection here is derived from the route
 * rather than from state, so the route↔value mapping stays at this call site
 * and SegmentedControl remains a plain controlled component.
 */
const INSIGHT_TABS = [
  { label: "Expenses", value: "ExpenseBehavior", icon: "wallet-outline" },
  { label: "Spending", value: "SpendingImpact", icon: "bar-chart-outline" },
  { label: "Recovery", value: "RecoveryTarget", icon: "refresh-circle-outline" },
] as const;

/**
 * The header every insight screen shares: where you are, and the three places
 * you can go.
 *
 * "Insights" above the section name rather than the section name alone. The
 * three screens are one destination with three views of it, and titling them
 * "Expense insight" / "Spending impact" / "Recovery target" with no common
 * line made each read as a separate place the tab bar happened to reach.
 *
 * Icons on the segments because these are returned to repeatedly — an owner
 * learns the shape of the one they want and stops reading the words. The
 * period switcher below keeps plain labels, which is why the icon is optional
 * on SegmentedControl rather than required.
 */
export function InsightHeader({
  navigation,
  active,
  title,
}: {
  navigation: any;
  active: string;
  title: string;
}) {
  const t = useTheme();
  const { ink } = t;
  return (
    <View style={{ marginBottom: space.lg }}>
      {/*
        "Insights" names the tab; the line under it names which of the three
        views is showing.

        That order, and not the reverse, because the big word should be the
        one true of all three screens — an owner arriving from the tab bar
        wants confirmation they landed where they meant to, and the segmented
        control below already says which view they are on. The native stack
        header that used to carry this word, above a back arrow with nowhere
        to go, is gone; see InsightsStack.

        No size override on it: `variant="title"` is what ScreenHeader gives
        the Records tab, and two tab roots whose names are set in different
        sizes read as two different levels of the app.
      */}
      <T variant="title" accessibilityRole="header">
        Insights
      </T>
      <T variant="heading" style={{ color: ink[600], marginTop: 2, marginBottom: space.md }}>
        {title}
      </T>
      <SegmentedControl
        options={INSIGHT_TABS}
        value={active}
        onChange={(key) => navigation.navigate(key)}
        accessibilityLabel="Insight sections"
      />
    </View>
  );
}

/**
 * A round tinted glyph, used wherever a list row needs to be identifiable at
 * a glance rather than read.
 *
 * The insight screens are dense lists of near-identical rows — nine
 * categories, six findings, fourteen days — and in that setting a medallion
 * is not decoration: it is the thing that lets someone find the row they were
 * looking at before they scrolled.
 */
export function Medallion({
  icon,
  tint,
  surface,
  size = 34,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  surface: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={tint} />
    </View>
  );
}

/**
 * A change against the previous period, as a pill.
 *
 * Direction is carried by an arrow and a sign as well as by colour — the same
 * rule the rest of the app follows, and it matters most here because up is
 * not universally bad: an owner reading a rise in Inventory may be pleased.
 */
export function DeltaPill({ percentChange, direction }: { percentChange: number | null; direction: string }) {
  const t = useTheme();
  const { ink, paper, statusText } = t;
  if (percentChange === null) {
    return (
      <View style={{ paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.full, backgroundColor: paper[100] }}>
        <T style={{ fontSize: typeScale.micro, color: ink[500] }}>new</T>
      </View>
    );
  }

  const up = direction === "up";
  const flat = direction !== "up" && direction !== "down";
  const tone = flat ? ink[500] : up ? statusText.serious : statusText.good;
  const surface = flat ? t.surfaceMuted : up ? t.statusSurface.serious : t.statusSurface.good;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: radius.full,
        backgroundColor: surface,
      }}
    >
      <T style={{ fontSize: typeScale.micro, color: tone }}>{flat ? "—" : up ? "▲" : "▼"}</T>
      <T style={{ fontSize: typeScale.micro, color: tone }}>{Math.abs(percentChange).toFixed(0)}%</T>
    </View>
  );
}

/**
 * The sub-sections of one insight screen.
 *
 * WHY THESE ARE UNDERLINE TABS AND THE ROW ABOVE IS A PILL CONTROL. They are
 * different KINDS of move and should not look alike. The pills switch between
 * three separate screens — a change of subject. These switch views of the one
 * screen you are already on, and the underline is the convention for that
 * everywhere else a phone does it.
 *
 * The counts are the point of splitting at all. Expenses had grown to seven
 * stacked cards, and the two that ask the owner to DECIDE something —
 * findings and recurring candidates — sat at the bottom under four they only
 * read. A number on the tab says there is work here without making anyone
 * scroll to find out.
 */
/** Height of a sub-tab's count badge; its radius follows from it. */
const BADGE_HEIGHT = 17;

export function SubTabs<Value extends string>({
  tabs,
  value,
  onChange,
  accessibilityLabel,
}: {
  tabs: readonly { label: string; value: Value; count?: number }[];
  value: Value;
  onChange: (v: Value) => void;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={{
        flexDirection: "row",
        // One hairline under the whole row, with the active tab's own rule
        // drawn over it — so the tabs read as a set rather than as three
        // separate underlined words.
        borderBottomWidth: 1,
        borderBottomColor: paper[200],
        marginBottom: space.lg,
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              tab.count ? `${tab.label}, ${tab.count} needing review` : tab.label
            }
            onPress={() => {
              haptics.tapped();
              onChange(tab.value);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              flex: 1,
              minHeight: TAP,
              paddingHorizontal: space.xs,
              borderBottomWidth: 2,
              borderBottomColor: selected ? brand[600] : "transparent",
              // Sits on the row's own hairline rather than beside it.
              marginBottom: -1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <T
              style={{
                fontSize: 13.5,
                color: selected ? brand[700] : ink[500],
                fontFamily: selected ? font.sansSemibold : font.sans,
              }}
            >
              {tab.label}
            </T>
            {/*
              Only when there is something to count. A zero badge is a badge
              that trains people to ignore badges.
            */}
            {/*
              A soft counter, not an alarm.

              It was a filled red disc, which is the badge language for "an
              error is waiting" — and what it actually counts is how many
              things are ready for a routine yes/no. Two recurring payments to
              confirm is housekeeping, not a fault, and painting it as one
              teaches people to dread the tab. It also sat taller than the
              label it followed, so the row's baseline moved as counts
              appeared and vanished.

              Tinted in the tab's own colour instead: present when selected,
              recessive when not, and never louder than the word it belongs to.
            */}
            {tab.count ? (
              <View
                style={{
                  minWidth: BADGE_HEIGHT + 1,
                  height: BADGE_HEIGHT,
                  paddingHorizontal: 5,
                  // Radius derived from the height rather than the pill token
                  // — a brand-filled pill with that token is the marker
                  // chipConsistency looks for, and this is a counter, not a
                  // chip. (The check reads source text, so naming the token
                  // in this comment would trip it too.)
                  borderRadius: BADGE_HEIGHT / 2,
                  backgroundColor: selected ? brand[600] : paper[200],
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <T
                  style={{
                    fontSize: 10.5,
                    lineHeight: 14,
                    color: selected ? t.onBrandFill : ink[600],
                    fontFamily: font.sansSemibold,
                  }}
                >
                  {tab.count}
                </T>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One declared repeating payment, as a row in the agenda.
 *
 * Same shape as a record row in RecordsScreens — Pressable wrapping a Card,
 * medallion on the left, the figure in `Money` on the right, one caption line
 * of meta joined with " · ". Two lists of money-with-a-date should not be two
 * different objects, and the owner has already learnt this one.
 *
 * The medallion carries the group: an overdue payment is not read, it is
 * spotted. Colour is never the only signal — the row sits under a written
 * "Overdue" heading, and a paused one says so in words.
 */
const agendaLook = (
  t: Palette,
): Record<AgendaGroupKey, { icon: keyof typeof Ionicons.glyphMap; tint: string; surface: string }> => ({
  OVERDUE: { icon: "alert-circle-outline", tint: t.statusText.critical, surface: t.statusSurface.critical },
  DUE_SOON: { icon: "time-outline", tint: t.statusText.warning, surface: t.statusSurface.warning },
  SCHEDULED: { icon: "repeat-outline", tint: t.brandText, surface: t.brandSurface },
  PAUSED: { icon: "pause-outline", tint: t.textMuted, surface: t.surfaceMuted },
});

export function ScheduleRow({ schedule, onPress }: { schedule: RecurringSchedule; onPress: () => void }) {
  const t = useTheme();
  const look = agendaLook(t)[agendaGroupOf(schedule)];
  const due = formatDueDate(schedule.nextDueDate);
  const meta = [
    schedule.categoryName,
    schedule.vendor,
    `Every ${schedule.intervalDays} days`,
    `Due ${due}`,
  ]
    .filter(Boolean)
    .join(" · ");

  /*
   * Composed rather than left to the layout, for the same reason the record
   * card composes its own: read in layout order this announces the label, then
   * a caption full of middle dots, then the amount. What matters is what it is,
   * what it costs, and when — in that order, without the separators.
   */
  const spoken = [
    schedule.label,
    formatMoney(schedule.expectedAmount),
    `due ${due}`,
    schedule.categoryName,
    schedule.isActive ? null : "paused",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${spoken}. Edit this payment.`}>
      <Card style={{ marginBottom: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
          <Medallion icon={look.icon} tint={look.tint} surface={look.surface} size={38} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <T style={{ flex: 1, fontFamily: font.sansMedium, color: t.textPrimary }} numberOfLines={2}>
                {schedule.label}
              </T>
              <Money value={schedule.expectedAmount} size={15} weight="semibold" decimals />
            </View>
            <T variant="caption" style={{ marginTop: 2 }}>
              {meta}
            </T>
            {schedule.isActive ? null : (
              <View
                style={{
                  alignSelf: "flex-start",
                  marginTop: space.sm,
                  paddingHorizontal: space.sm,
                  paddingVertical: 2,
                  borderRadius: radius.full,
                  backgroundColor: t.surfaceMuted,
                }}
              >
                <T style={{ fontSize: typeScale.micro, color: t.textMuted }}>Paused</T>
              </View>
            )}
          </View>
          <Ionicons name="chevron-forward" size={16} color={t.ink[300]} style={{ alignSelf: "center" }} />
        </View>
      </Card>
    </Pressable>
  );
}
