import { useCallback, useState } from "react";
import { Alert as RNAlert, Pressable, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, Disclosure, EmptyState, ErrorNote, Field, Money, Screen, T } from "../components/ui";
import { DateField } from "../components/DateField";
import { mascotSource } from "../components/MascotState";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { RecoveryScenarioSheet } from "../components/RecoveryScenarioSheet";
import { SkeletonCard } from "../components/Skeleton";
import { CoverageColumns } from "../components/charts";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { InsightHeader, Medallion } from "../components/InsightsShared";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useInsight } from "../lib/useInsight";
import { api, errorMessage } from "../lib/api";
import { formatMoney } from "../lib/money";
import { bufferPercentError, currentMonthKey, ownerTargetAmountError, parsePlanNumber } from "../lib/recoveryPlanForm";
import { font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type {
  RecoveryChangeSincePreviousDay,
  RecoveryCheckpoint,
  RecoveryCheckpointStatus,
  RecoveryInsight,
  RecoveryPlan,
  RecoveryStatus,
} from "../lib/types";

// ---------------------------------------------------------------- Recovery target

export function RecoveryTargetScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, paper, statusText } = t;
  const { selected } = useBusinessProfiles();
  const [askOpen, setAskOpen] = useState(false);
  const [showDefinition, setShowDefinition] = useState(false);
  /** Plan §13.2/§15 Phase 5 — the hypothetical scenario sheet. Its own boolean is enough: it reads `data` when open, so there is nothing to carry across renders. */
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const { data, loading, error, load } = useInsight<RecoveryInsight>(
    "/insights/recovery",
    { businessProfileId: selected?.id, coverageDays: 14 },
    [selected?.id]
  );

  /*
   * §7.5/§10.7 saved plan — fetched alongside, not gating, the main recovery
   * load above. A separate `useState`/`useFocusEffect` pair rather than a
   * second `useInsight` call: this must never block the main screen's own
   * loading/error states, and it renders nothing at all when it fails or
   * when nothing has been saved for the current month — there is no error
   * state of its own to show.
   */
  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  const loadPlan = useCallback(async () => {
    if (!selected) return;
    try {
      const list = await api.get<RecoveryPlan[]>(`/business-profiles/${selected.id}/recovery-plans`, {
        month: currentMonthKey(),
      });
      setPlan(list[0] ?? null);
    } catch {
      // Silent by design — see the comment above.
      setPlan(null);
    }
  }, [selected]);
  useFocusEffect(useCallback(() => { loadPlan(); }, [loadPlan]));

  if (!selected) return null;

  return (
    <Screen safeTop>
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="RecoveryTarget" title="Recovery target" />

        {/*
          Improvement Plan §6.1/§6.2 — "Sales Coverage Target" is the
          explanatory name; "Recovery target" stays as the nav label during
          the transition. The definition has to sit before or beside the
          first status, not buried under the formulas below, so it lives here
          rather than inside RecoveryMeter itself.
        */}
        <View style={{ marginBottom: space.md }}>
          <T variant="caption" numberOfLines={showDefinition ? undefined : 2}>
            Your Sales Coverage Target compares recorded sales references with your expected monthly expense amount.
            It is a planning guide and does not calculate profit, cash flow, or formal break-even.
          </T>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDefinition }}
            accessibilityLabel={showDefinition ? "Show less about recovery target" : "Learn more about recovery target"}
            onPress={() => setShowDefinition((shown) => !shown)}
            hitSlop={8}
            style={{ alignSelf: "flex-start", paddingVertical: space.xs }}
          >
            <T variant="label" style={{ color: brand[700] }}>
              {showDefinition ? "Show less" : "Learn more"}
            </T>
          </Pressable>
        </View>

        {/*
          Freshness (Improvement Plan §8.1/§8.2) — when the response is a
          server that has adopted the Phase 1 contract. Older/cached
          responses simply omit these fields, so nothing extra renders.
        */}
        {data?.asOfDate ? (
          <T variant="caption" style={{ marginBottom: space.md }}>
            As of{" "}
            {new Date(data.asOfDate).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
            {data.timezone ? `, ${data.timezone} time` : ""}
          </T>
        ) : null}

        {/* A refresh failure with data already on screen keeps showing that
            data, labeled stale, rather than replacing it with an error. An
            initial-load failure has nothing to fall back to, so it gets its
            own dedicated state with Retry below instead of an endless skeleton. */}
        {error && data ? (
          <View style={{ marginBottom: space.md }}>
            <ErrorNote>Showing the last successful result. Refreshing failed: {error}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={load} style={{ marginTop: space.sm }} />
          </View>
        ) : null}

        {loading && !data ? (
          <View style={{ gap: space.lg }}>
            <SkeletonCard style={{ height: 120 }} />
            <SkeletonCard style={{ height: 150 }} />
            <SkeletonCard style={{ height: 140 }} />
            <SkeletonCard style={{ height: 180 }} />
          </View>
        ) : error && !data ? (
          <View style={{ gap: space.md }}>
            <ErrorNote>{error}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={load} />
          </View>
        ) : data ? (
          <View style={{ gap: space.lg }}>
            {/*
              SAID BEFORE THE FIGURES, because without it the figures are a
              false accusation.

              Recovery is month-to-date and has no period to select, so imported
              history that stops months ago shows zero sales against the full
              monthly target — a screen confidently reporting that the owner
              missed everything, in a month they never traded in. The arithmetic
              is right; this is the sentence that makes it honest.
            */}
            {/*
              §8.1 empty month — illustrated with the mascot library's mapped
              "no sales records" pose (docs/mascot-scenario-library.md §4)
              rather than a plain warning callout, so an owner sees "nothing
              to measure yet" instead of reading it as an alert. No action
              button here: RecoveryPrimaryAction below already renders the
              one CTA for this exact status ("Record or import sales"),
              right beside the meter it changes — a second button here would
              only duplicate it.
            */}
            {data.monthHasNoRecords ? (
              <EmptyState
                title="Nothing to measure yet this month"
                image={mascotSource("noSalesRecords")}
                body={`Add a sale to start tracking this month's progress.${
                  data.latestSaleDate
                    ? ` Your latest sale was ${new Date(data.latestSaleDate).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        timeZone: "UTC",
                      })}.`
                    : ""
                }`}
              />
            ) : null}

            <Card>
              <RecoveryMeter data={data} />
              {/*
                §10.1/§10.2 primary action — one prominent, state-driven
                control right beside the status/meter, so an owner doesn't
                have to read the whole page to know what to do next.
              */}
              <RecoveryPrimaryAction
                status={data.status}
                navigation={navigation}
                businessProfile={selected}
              />
            </Card>

            {/*
              §10.3 "Why your target changed" — server-computed, deterministic
              diff against yesterday's own calculation. Absent (null) on the
              1st of the month or when setup is incomplete, and deliberately
              silent when the reason is `no_material_change` — nothing useful
              to say in that case.
            */}
            {data.changeSincePreviousDay && data.changeSincePreviousDay.primaryReason !== "no_material_change" ? (
              <Card>
                <RecoveryChangeExplanation change={data.changeSincePreviousDay} />
              </Card>
            ) : null}

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>Remaining recovery target</T>
              {/*
                Plan §7.4/§11 Phase 2 — once a weekly schedule is configured,
                the remaining-day count is exact rather than approximated, so
                the caption stops hedging and the escape hatch below no
                longer needs to appear.
              */}
              <T variant="caption" style={{ marginBottom: space.md }}>
                {data.operatingScheduleConfigured
                  ? "Based on your remaining open days."
                  : "Estimated from the operating days in your profile."}
              </T>
              {data.remainingOperatingDaysIsApproximated && !data.operatingScheduleConfigured ? (
                <Button
                  title="Edit operating schedule"
                  variant="secondary"
                  onPress={() => navigation.navigate("More", { screen: "OperatingSchedule" })}
                  style={{ marginBottom: space.md }}
                />
              ) : null}
              {/*
                Four lines that are read as a calculation, so each one is
                given a glyph: the eye can then follow expenses → sales →
                what is left → over how many days, without re-reading the
                labels every time it returns to the card.
              */}
              <Row
                icon="wallet-outline"
                label="Expected monthly expenses"
                value={data.expectedMonthlyExpenses}
                first
              />
              <Row icon="bar-chart-outline" label="Sales reference so far" value={data.salesThisMonth} />
              {/*
                §8.2/§10.5 data-quality disclosure — purely additive. The
                sales-this-month figure above is never hidden or changed by
                this; it just adds a caption when part of it isn't fully
                confirmed yet.
              */}
              {data.dataWarnings && data.dataWarnings.length > 0 ? (
                <T variant="caption" style={{ marginTop: -space.xs, marginBottom: space.sm }}>
                  Includes {formatMoney(data.provisionalSalesThisMonth ?? 0)} pending review or flagged as a possible
                  duplicate.
                </T>
              ) : null}
              <Row
                icon="flag-outline"
                label="Remaining target"
                value={data.remainingTarget}
                tint={statusText.critical}
              />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingVertical: space.sm,
                  borderTopWidth: 1,
                  borderTopColor: paper[200],
                }}
              >
                <Medallion icon="calendar-outline" tint={brand[700]} surface={brand[50]} size={28} />
                <T style={{ flex: 1, fontSize: typeScale.bodySm }}>Remaining operating days</T>
                <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoMedium }}>≈ {data.remainingOperatingDays}</T>
              </View>

              {/*
                Plan §13.2/§15 Phase 5 — the current target above is left
                completely untouched by this. The button only opens a
                separate what-if sheet; nothing on this screen changes when
                it is used.
              */}
              <Button
                title="See a hypothetical scenario"
                variant="secondary"
                onPress={() => setScenarioOpen(true)}
                style={{ marginTop: space.md }}
              />

              {/*
                §10.9/§11 Phase 7 — a plain entry point to the month-end
                review, the same "reached via a small link" pattern as
                OperatingSchedule/RecoveryNotificationPreferences above.
              */}
              <Button
                title="View last month's summary"
                variant="secondary"
                onPress={() => navigation.navigate("More", { screen: "MonthEndReview" })}
                style={{ marginTop: space.sm }}
              />
            </Card>

            {/*
              §7.5/§10.7 saved plan — an owner-visible reference note only,
              rendered right beside the scenario entry point it came from.
              Absent entirely when nothing has been saved for the current
              month, or when the fetch failed — see `loadPlan` above.
            */}
            {plan ? (
              <Card>
                <SavedPlanCard businessProfileId={selected.id} plan={plan} onChanged={setPlan} />
              </Card>
            ) : null}

            {/*
              §10.4 weekly checkpoints — bounded, month-scoped. Only rendered
              once the server actually sends them (older/cached responses
              simply omit `weeklyCheckpoints`, same optional-field pattern as
              every other Phase addition on this screen).
            */}
            {data.weeklyCheckpoints && data.weeklyCheckpoints.length > 0 ? (
              <Card>
                <RecoveryCheckpointsCard checkpoints={data.weeklyCheckpoints} today={data.today} />
              </Card>
            ) : null}

            <Card>
              <CoverageColumns
                data={data.dailyCoverage.map((d) => ({ date: d.date, amount: d.sales }))}
                target={data.dailyNeededTarget}
                subtitle="Daily sales against your target"
              />
              <View style={{ borderTopWidth: 1, borderTopColor: paper[200], marginTop: space.md }}>
                <Disclosure
                  title="Day-by-day details"
                  summary={`${data.dailyCoverage.length} days · sales and target status`}
                  defaultOpen={data.dailyCoverage.length <= 4}
                >
                  <DailyCoverageRows days={data.dailyCoverage} />
                </Disclosure>
              </View>
            </Card>
          </View>
        ) : null}
      </ScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Recovery Target" />

      {selected && data ? (
        <RecoveryScenarioSheet
          // Forces a remount on profile switch so the scenario's local state
          // (input, result) can't leak from one business into another.
          key={selected.id}
          visible={scenarioOpen}
          businessProfileId={selected.id}
          currentExpectedMonthlyExpenses={data.expectedMonthlyExpenses}
          onClose={() => setScenarioOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** Exact daily figures stay available without making a long month dominate the screen. */
function DailyCoverageRows({ days }: { days: RecoveryInsight["dailyCoverage"] }) {
  const t = useTheme();
  const { paper, statusText } = t;
  return (
    <View>
      {days.map((day, index) => {
        const closed = day.status === "closed";
        const tone = closed
          ? t.textMuted
          : day.status === "below"
            ? statusText.critical
            : day.status === "at"
              ? statusText.warning
              : statusText.good;
        return (
          <View
            key={day.date}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingVertical: space.sm,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: paper[200],
            }}
          >
            <T variant="caption" style={{ width: 48, fontFamily: font.monoMedium }}>
              {day.date.slice(5)}
            </T>
            <Money value={day.sales} size={typeScale.caption} weight="medium" />
            <T style={{ flex: 1, textAlign: "right", fontSize: typeScale.caption, color: tone }}>
              {closed
                ? "Closed"
                : day.status === "at"
                  ? "Reached"
                  : `${Math.round(Math.abs(day.gap ?? 0)).toLocaleString("en-PH")} ${day.status}`}
            </T>
          </View>
        );
      })}
    </View>
  );
}

/**
 * §10.1/§10.2 primary action — one prominent, state-driven control per the
 * plan's state/action table. `behind`, `ahead` and `covered` are rendered as
 * plain informational text rather than a button that would only ever
 * scroll the same screen: this screen has no scroll-to-ref convention
 * elsewhere, and a button whose sole effect is "look further down this
 * page you're already on" reads as broken more often than it helps. `ahead`
 * has no destination at all per the plan, so it is never anything but text.
 *
 * Renders nothing when `status` is undefined — an older/cached response
 * that predates the Phase 1 `status` field.
 */
function RecoveryPrimaryAction({
  status,
  navigation,
  businessProfile,
}: {
  status: RecoveryStatus | undefined;
  navigation: any;
  businessProfile: { id: number } | null;
}) {
  if (!status) return null;

  const goToRecords = () => navigation.navigate("Records", { screen: "RecordsList", params: { type: "sales" } });

  switch (status) {
    case "needs_setup":
      return (
        <Button
          title="Complete setup"
          variant="primary"
          style={{ marginTop: space.md }}
          onPress={() =>
            navigation.navigate("More", { screen: "BusinessProfileForm", params: { profile: businessProfile } })
          }
        />
      );
    case "no_current_month_data":
      return (
        <Button title="Record or import sales" variant="primary" style={{ marginTop: space.md }} onPress={goToRecords} />
      );
    case "data_incomplete":
      // Not yet emitted by the server (plan §10.2 table) — wired ahead of
      // time so nothing needs to change here once it is.
      return <Button title="Review sales" variant="primary" style={{ marginTop: space.md }} onPress={goToRecords} />;
    case "on_pace":
      return (
        <Button
          title="Record today's sales"
          variant="primary"
          style={{ marginTop: space.md }}
          onPress={() => navigation.navigate("Records", { screen: "AddSales" })}
        />
      );
    case "behind":
      return (
        <T variant="caption" style={{ marginTop: space.md }}>
          View today's plan — see "Remaining recovery target" below.
        </T>
      );
    case "ahead":
      return (
        <T variant="caption" style={{ marginTop: space.md }}>
          Maintain current pace
        </T>
      );
    case "covered":
      return (
        <T variant="caption" style={{ marginTop: space.md }}>
          Review month summary — see "Day by day" below.
        </T>
      );
    default:
      return null;
  }
}

/**
 * §8.2/§10.3 "Why your target changed" — the server's own deterministic
 * day-over-day diff, plain-language mapped by `primaryReason`. Callers
 * already filter out `null` and `no_material_change` before rendering this.
 */
function RecoveryChangeExplanation({ change }: { change: RecoveryChangeSincePreviousDay }) {
  const { statusText } = useTheme();
  const { adjustedDailyTargetDelta, salesAdded, primaryReason } = change;
  const increased = adjustedDailyTargetDelta > 0;
  const direction = increased ? "increased" : "decreased";
  const reasonCopy =
    primaryReason === "sales_added"
      ? "Recorded sales are helping close the gap."
      : primaryReason === "open_day_elapsed"
        ? "A day has passed, and the remaining amount is now spread across fewer days."
        : "Your setup or schedule changed.";

  return (
    <View>
      <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
        Why your target changed
      </T>
      <T style={{ marginBottom: space.xs }}>
        Your adjusted daily target {direction} by{" "}
        {formatMoney(Math.abs(adjustedDailyTargetDelta), { decimals: true })}.{" "}
        <T style={{ color: increased ? statusText.critical : statusText.good }}>{reasonCopy}</T>
      </T>
      {salesAdded !== 0 ? (
        <T variant="caption" style={{ marginBottom: space.sm }}>
          {/* salesAdded is server-derived as a sum of positive-validated sales
              amounts, so it's currently always non-negative; this would need
              distinct phrasing if refunds/negative adjustments ever feed it. */}
          You recorded {formatMoney(salesAdded, { decimals: true })} in sales since yesterday.
        </T>
      ) : null}
      {/*
        This section is server-computed arithmetic, not AI-generated text —
        same disclosure convention AskFinSight already uses for its own
        computed figures (see AskFinSight.tsx's "calculated by FinSight, not
        by AI").
      */}
      <T variant="caption">This explanation is calculated by FinSight, not written by AI.</T>
    </View>
  );
}

/**
 * §10.4 weekly checkpoints — the CURRENT (most recent one that has already
 * passed, or the first checkpoint of the month if none have) and NEXT (the
 * first still in the future) checkpoints prominently, with the full
 * month's list secondary behind this app's existing `Disclosure` pattern
 * (the shared "closed until wanted" primitive — see ui.tsx — rather than a
 * bespoke expand/collapse control).
 */
function RecoveryCheckpointsCard({ checkpoints, today }: { checkpoints: RecoveryCheckpoint[]; today: string }) {
  const past = checkpoints.filter((c) => c.endDate <= today);
  const current = past.length > 0 ? past[past.length - 1] : checkpoints[0];
  const next = checkpoints.find((c) => c.endDate > today) ?? null;
  // The rare early-month case where the very first checkpoint hasn't
  // happened yet: it is both the "current" fallback and the "next"
  // checkpoint, so it is shown once rather than twice.
  const showNextSeparately = next && next.endDate !== current.endDate;

  return (
    <View>
      <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
        Weekly checkpoints
      </T>
      <T variant="caption" style={{ marginBottom: space.md }}>
        Cumulative sales against your target at set points in the month.
      </T>

      <CheckpointRow label="Current checkpoint" checkpoint={current} first />
      {showNextSeparately ? <CheckpointRow label="Next checkpoint" checkpoint={next} /> : null}

      <Disclosure title="All checkpoints this month" defaultOpen={false}>
        {checkpoints.map((c, i) => (
          <CheckpointListRow key={c.endDate} checkpoint={c} first={i === 0} />
        ))}
      </Disclosure>
    </View>
  );
}

/** Tone mapping shared by both checkpoint renderings below — same status palette RecoveryMeter and the "Day by day" list already use. */
function checkpointTone(status: RecoveryCheckpointStatus, statusText: Record<"good" | "warning" | "critical", string>, muted: string) {
  switch (status) {
    case "ahead":
      return statusText.good;
    case "on_pace":
      return statusText.warning;
    case "behind":
      return statusText.critical;
    case "pending":
    default:
      return muted;
  }
}

const checkpointStatusLabel: Record<RecoveryCheckpointStatus, string> = {
  ahead: "Ahead",
  on_pace: "On pace",
  behind: "Behind",
  pending: "Pending",
};

function formatCheckpointDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The prominent current/next display — one full card row each. */
function CheckpointRow({ label, checkpoint, first }: { label: string; checkpoint: RecoveryCheckpoint; first?: boolean }) {
  const t = useTheme();
  const { statusText, paper } = t;
  const tone = checkpointTone(checkpoint.status, statusText, t.textMuted);
  return (
    <View
      style={{
        paddingVertical: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
        gap: 2,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <T variant="label" style={{ color: t.ink[700] }}>
          {label} · {formatCheckpointDate(checkpoint.endDate)}
        </T>
        <T style={{ fontSize: typeScale.caption, color: tone }}>{checkpointStatusLabel[checkpoint.status]}</T>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <T variant="caption">Target: {formatMoney(checkpoint.cumulativeTarget)}</T>
        {checkpoint.recordedAmount === null ? (
          <T variant="caption">Not yet reached</T>
        ) : (
          <Money value={checkpoint.recordedAmount} size={13} weight="medium" />
        )}
      </View>
      {checkpoint.variance !== null ? (
        <T style={{ fontSize: typeScale.caption, color: tone, textAlign: "right" }}>
          {formatMoney(checkpoint.variance, { signed: true, decimals: true })} vs. target
        </T>
      ) : null}
    </View>
  );
}

/** The compact secondary row used inside the "All checkpoints" disclosure. */
function CheckpointListRow({ checkpoint, first }: { checkpoint: RecoveryCheckpoint; first?: boolean }) {
  const t = useTheme();
  const { statusText, paper } = t;
  const tone = checkpointTone(checkpoint.status, statusText, t.textMuted);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: space.sm,
        gap: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
      }}
    >
      <T variant="caption" style={{ width: 56, fontFamily: font.monoMedium }}>
        {formatCheckpointDate(checkpoint.endDate)}
      </T>
      <T variant="caption" style={{ flex: 1 }}>
        Target {formatMoney(checkpoint.cumulativeTarget)}
      </T>
      <View style={{ alignItems: "flex-end" }}>
        {checkpoint.recordedAmount === null ? (
          <T variant="caption">Not yet reached</T>
        ) : (
          <Money value={checkpoint.recordedAmount} size={13} weight="medium" />
        )}
        <T style={{ fontSize: typeScale.micro, color: tone }}>{checkpointStatusLabel[checkpoint.status]}</T>
      </View>
    </View>
  );
}

/**
 * "This month's saved plan" — plan §7.5/§10.7/§11 Phase 6. A view of the
 * reference note the owner saved from the scenario sheet, with edit/delete
 * in place. Never reads or writes anything the real Recovery Target
 * calculation touches — see RecoveryPlan's own type-level warning.
 */
function SavedPlanCard({
  businessProfileId,
  plan,
  onChanged,
}: {
  businessProfileId: number;
  plan: RecoveryPlan;
  onChanged: (plan: RecoveryPlan | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amountRaw, setAmountRaw] = useState(plan.ownerTargetAmount !== null ? String(plan.ownerTargetAmount) : "");
  const [deadline, setDeadline] = useState(plan.deadline ?? "");
  const [bufferRaw, setBufferRaw] = useState(plan.bufferPercent !== null ? String(plan.bufferPercent) : "");
  const [amountFieldError, setAmountFieldError] = useState<string | null>(null);
  const [bufferFieldError, setBufferFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function startEditing() {
    setAmountRaw(plan.ownerTargetAmount !== null ? String(plan.ownerTargetAmount) : "");
    setDeadline(plan.deadline ?? "");
    setBufferRaw(plan.bufferPercent !== null ? String(plan.bufferPercent) : "");
    setAmountFieldError(null);
    setBufferFieldError(null);
    setSaveError(null);
    setEditing(true);
  }

  async function saveEdits() {
    const amountErr = ownerTargetAmountError(amountRaw);
    const bufferErr = bufferPercentError(bufferRaw);
    if (amountErr || bufferErr) {
      setAmountFieldError(amountErr);
      setBufferFieldError(bufferErr);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.put<RecoveryPlan>(`/business-profiles/${businessProfileId}/recovery-plans/${plan.month}`, {
        ownerTargetAmount: amountRaw.trim() === "" ? null : parsePlanNumber(amountRaw),
        deadline: deadline.trim() === "" ? null : deadline,
        bufferPercent: bufferRaw.trim() === "" ? null : parsePlanNumber(bufferRaw),
      });
      onChanged(updated);
      setEditing(false);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    RNAlert.alert(
      "Remove this saved plan?",
      "This only removes your own reference note for this month — it doesn't affect your business profile or recorded sales.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await api.delete(`/business-profiles/${businessProfileId}/recovery-plans/${plan.month}`);
              onChanged(null);
            } catch (err) {
              setSaveError(errorMessage(err));
            }
          },
        },
      ],
    );
  }

  if (editing) {
    return (
      <View style={{ gap: space.sm }}>
        <T variant="heading" accessibilityRole="header">
          Edit this month&apos;s saved plan
        </T>
        <Field
          label="Owner target amount (optional)"
          value={amountRaw}
          onChangeText={(v) => {
            setAmountRaw(v);
            setAmountFieldError(null);
          }}
          keyboardType="decimal-pad"
          error={amountFieldError}
        />
        <DateField label="Deadline (optional)" value={deadline} onChange={setDeadline} allowFuture optional onClear={() => setDeadline("")} />
        <Field
          label="Buffer percent (optional)"
          value={bufferRaw}
          onChangeText={(v) => {
            setBufferRaw(v);
            setBufferFieldError(null);
          }}
          keyboardType="decimal-pad"
          error={bufferFieldError}
        />
        {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button title="Save changes" variant="primary" onPress={saveEdits} loading={saving} style={{ flex: 1 }} />
          <Button title="Cancel" variant="secondary" onPress={() => setEditing(false)} style={{ flex: 1 }} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 4 }}>
      <T variant="heading" accessibilityRole="header">
        This month&apos;s saved plan
      </T>
      <T variant="caption" style={{ marginBottom: space.sm }}>
        Your own reference note — it doesn't change your business profile or recorded sales.
      </T>
      {plan.ownerTargetAmount !== null ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <T style={{ fontSize: typeScale.bodySm }}>Owner target amount</T>
          <Money value={plan.ownerTargetAmount} size={14} weight="medium" />
        </View>
      ) : null}
      {plan.deadline ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <T style={{ fontSize: typeScale.bodySm }}>Deadline</T>
          <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoMedium }}>{plan.deadline}</T>
        </View>
      ) : null}
      {plan.bufferPercent !== null ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <T style={{ fontSize: typeScale.bodySm }}>Buffer</T>
          <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoMedium }}>{plan.bufferPercent}%</T>
        </View>
      ) : null}
      {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
      <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
        <Button title="Edit" variant="secondary" onPress={startEditing} style={{ flex: 1 }} />
        <Button title="Delete" variant="secondary" onPress={confirmDelete} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  tint,
  first,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: number;
  /** Colours the FIGURE only — the label stays neutral so the row still scans. */
  tint?: string;
  /** Drops the top rule, so the list does not open with one under a caption. */
  first?: boolean;
}) {
  const t = useTheme();
  const { brand, paper } = t;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingVertical: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
      }}
    >
      <Medallion icon={icon} tint={brand[700]} surface={brand[50]} size={28} />
      <T style={{ fontSize: typeScale.bodySm, flex: 1 }}>{label}</T>
      <Money value={value} size={14} weight="medium" color={tint} />
    </View>
  );
}
