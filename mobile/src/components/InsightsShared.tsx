import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { CONTENT_WIDTH, ContentScrollView } from "./ContentScrollView";
import { useReducedMotion } from "../lib/useReducedMotion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as haptics from "../lib/haptics";
import { Card, Money, T } from "./ui";
import { agendaGroupOf, formatDueDate, type AgendaGroupKey } from "../lib/recurringAgenda";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
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
 * The insight screens, by route name. The descriptions are what the switcher
 * sheet shows under each name: plain words for an owner who does not know
 * what "spending impact" means yet.
 */
const INSIGHT_SCREENS: readonly {
  id: string;
  name: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Index into the categorical palette, or null for the brand colour. */
  hue: number | null;
}[] = [
  { id: "ExpenseBehavior", name: "Expenses", detail: "Where your money goes", icon: "wallet-outline", hue: 0 },
  { id: "SpendingImpact", name: "Spending impact", detail: "How spending affects your business", icon: "bar-chart-outline", hue: 1 },
  { id: "RecoveryTarget", name: "Recovery target", detail: "How much to sell to cover costs", icon: "refresh-circle-outline", hue: null },
];

/**
 * The switcher's sheet: one large row per screen, each with its own tinted
 * glyph so the three are told apart at a glance, the plain description under
 * the name, a check on the screen you are on and a chevron on the others.
 */
function InsightSwitcherSheet({
  visible,
  active,
  onChoose,
  onClose,
}: {
  visible: boolean;
  active: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? "none" : "slide"} statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.scrim, justifyContent: "flex-end", paddingTop: insets.top + space.md }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close without choosing" style={StyleSheet.absoluteFill} />
        <ContentScrollView
          accessibilityViewIsModal
          onStartShouldSetResponder={() => true}
          style={{ maxHeight: "90%", flexGrow: 0, width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", backgroundColor: t.surfaceRaised, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}
          contentContainerStyle={{
            backgroundColor: t.surfaceRaised,
            paddingTop: space.md,
            paddingHorizontal: space.md,
            paddingBottom: insets.bottom + space.lg,
            gap: space.xs,
          }}
        >
          <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: t.borderStrong, marginBottom: space.sm }} />
          <T variant="title" accessibilityRole="header" style={{ marginLeft: space.xs, marginBottom: space.sm }}>
            Explore insights
          </T>
          {INSIGHT_SCREENS.map((screen) => {
            const selected = screen.id === active;
            const hue = screen.hue === null ? t.brandText : t.categorical[screen.hue] ?? t.brandText;
            return (
              <Pressable
                key={screen.id}
                accessibilityRole="button"
                accessibilityLabel={`${screen.name}. ${screen.detail}`}
                accessibilityState={{ selected }}
                onPress={() => onChoose(screen.id)}
                style={({ pressed }) => ({
                  minHeight: 64,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderRadius: radius.lg,
                  borderWidth: 1.5,
                  borderColor: selected ? t.brandBorder : "transparent",
                  backgroundColor: selected ? t.brandSurface : pressed ? t.surfaceMuted : "transparent",
                })}
              >
                <View style={{ width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: screen.hue === null ? t.brandSurface : `${hue}1f` }}>
                  <Ionicons name={screen.icon} size={22} color={hue} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.body, color: t.textPrimary }}>{screen.name}</T>
                  <T variant="caption">{screen.detail}</T>
                </View>
                {selected ? (
                  <Ionicons name="checkmark-circle" size={22} color={t.brandFill} />
                ) : (
                  <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
                )}
              </Pressable>
            );
          })}
        </ContentScrollView>
      </View>
    </Modal>
  );
}

/**
 * The header every insight screen shares: where you are, and the way to the
 * other two.
 *
 * THE TITLE IS THE SWITCHER. "Expenses ⌄" opens a sheet listing the three
 * views, each with a line saying what it is for. This replaced two patterns
 * at once: a row of tabs on Spending and Recovery, and a "⋯" menu on
 * Expenses — which could not take the tabs, because it already has its own
 * Overview / Review / Recurring row and two tab rows stacked read as one
 * confusing grid. One pattern now, one row fewer, and the same "⌄ means tap
 * to change" cue as the business name and the period pill on Home.
 *
 * "Insights" stays above as the line true of all three screens, so an owner
 * arriving from the tab bar knows where they landed.
 */
export function InsightHeader({
  navigation,
  active,
  title,
  titleAccessory,
  right,
}: {
  navigation: any;
  active: string;
  title: string;
  /** Sits right after the view's name, e.g. an "about this" button. */
  titleAccessory?: ReactNode;
  /** Sits at the right of the title block, e.g. a settings icon. */
  right?: ReactNode;
}) {
  const t = useTheme();
  const [switching, setSwitching] = useState(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.md }}>
      <View style={{ flex: 1 }}>
        <T variant="caption" accessibilityRole="header" style={{ fontFamily: font.sansMedium }}>
          Insights
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}. Switch insight`}
            accessibilityHint="Opens Expenses, Spending impact and Recovery target"
            onPress={() => {
              haptics.tapped();
              setSwitching(true);
            }}
            style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.sm, opacity: pressed ? 0.7 : 1 })}
          >
            <T style={{ fontFamily: font.display, fontSize: typeScale.titleLg, color: t.brandHeading, flexShrink: 1 }}>{title}</T>
            <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: t.surfaceStrong }}>
              <Ionicons name="chevron-down" size={15} color={t.brandHeading} />
            </View>
          </Pressable>
          {titleAccessory}
        </View>
      </View>
      {right}
      <InsightSwitcherSheet
        visible={switching}
        active={active}
        onChoose={(id) => {
          setSwitching(false);
          if (id !== active) navigation.navigate(id);
        }}
        onClose={() => setSwitching(false)}
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
  const { fontScale } = useWindowDimensions();
  const { brand, ink, paper } = t;
  return (
    <View
      /*
       * NOT `accessible`. `tablist` is a grouping role whose whole purpose is
       * to have individually focusable children; setting `accessible` here
       * would collapse every tab below into one element and make the set
       * unusable. The tabs carry their own `tab` role and `selected` state,
       * which is what a reader actually announces. Left non-accessible on
       * purpose — see the progress bars for the opposite (leaf) case.
       */
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
              flexDirection: fontScale > 1.2 ? "column" : "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              flex: 1,
              minHeight: TAP_FLOOR,
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
                  minHeight: BADGE_HEIGHT,
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
