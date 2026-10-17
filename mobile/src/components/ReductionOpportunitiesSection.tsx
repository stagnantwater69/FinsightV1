import { useState } from "react";
import { SectionTitle } from "./CoachKit";
import { ActivityIndicator, Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as haptics from "../lib/haptics";
import { Button, Callout, Card, ErrorNote, SelectChip, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { ExpenseActionButton } from "./ExpenseActionButton";
import { api, errorMessage } from "../lib/api";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";
import type {
  ReductionOpportunity,
  ReductionOpportunityFeedbackRating,
  ReductionOpportunityResponse,
} from "../lib/types";

/**
 * The "Reduction opportunities" sub-section of Expense insight — Overview.
 *
 * Same shape as ExpenseAlertsSection.tsx: all the state (the fetch, its
 * loading/error) lives on ExpenseBehaviorScreen and is handed down as props,
 * so this file has no fetch of its own. See §10 of
 * docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md for the UX spec this follows.
 *
 * PHASE 4: the card now carries all three actions plan §10.2 lists —
 * "View related records", "Ask FinSight about this" (Phase 3) and "Simulate
 * reduction" (item 9, this phase). The last one opens
 * ReductionSimulationSheet, scoped to the card's own category — see that
 * file for why it is a plain Modal rather than AskFinSight's sheet.
 */

const MAX_CARDS = 3;

/** Priority as a labelled chip — never colour alone. */
const PRIORITY_COPY: Record<ReductionOpportunity["priority"], { label: string; tone: "critical" | "serious" | "warning" }> = {
  high: { label: "High priority", tone: "critical" },
  medium: { label: "Medium priority", tone: "serious" },
  low: { label: "Low priority", tone: "warning" },
};

const CONFIDENCE_LABEL: Record<ReductionOpportunity["confidence"], string> = {
  strong: "Strong confidence",
  moderate: "Moderate confidence",
  limited: "Limited confidence",
};

const COST_BEHAVIOR_BADGE: Partial<Record<ReductionOpportunity["costBehavior"], string>> = {
  fixed: "Fixed cost",
  mixed: "Mixed cost",
  variable: "Variable cost",
};

/**
 * "Was this helpful?" — plan §15 Phase 5. `POST
 * /insights/reduction-opportunities/feedback`, write-only: the buttons never
 * fetch a prior answer first, and pressing either one again is "changing your
 * answer" — the server upserts on `(businessProfileId, opportunityId, userId)`,
 * so a resubmission is not an error and is not blocked here either.
 */
function OpportunityFeedback({
  opportunityId,
  businessProfileId,
  categoryName,
}: {
  opportunityId: string;
  businessProfileId: number;
  categoryName: string;
}) {
  const t = useTheme();
  const [rating, setRating] = useState<ReductionOpportunityFeedbackRating | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(next: ReductionOpportunityFeedbackRating) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/insights/reduction-opportunities/feedback", {
        businessProfileId,
        opportunityId,
        rating: next,
      });
      setRating(next);
      haptics.succeeded();
    } catch (err) {
      setError(errorMessage(err));
      haptics.failed();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={{ marginTop: space.md }}>
      <T variant="label" style={{ color: t.textSecondary, marginBottom: 6 }}>
        Was this helpful?
      </T>
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
        <SelectChip
          label="Helpful"
          selected={rating === "helpful"}
          disabled={submitting}
          onPress={() => void submit("helpful")}
          accessibilityLabel={`Mark this ${categoryName} opportunity as helpful`}
          haptic={false}
        />
        <SelectChip
          label="Not relevant"
          selected={rating === "not_relevant"}
          disabled={submitting}
          onPress={() => void submit("not_relevant")}
          accessibilityLabel={`Mark this ${categoryName} opportunity as not relevant`}
          haptic={false}
        />
        {/* Confirms the answer landed — a selected chip alone could be missed against its own row. */}
        {rating && !submitting ? (
          <T
            variant="caption"
            accessibilityLiveRegion="polite"
            style={{ color: t.statusText.good }}
          >
            Feedback saved.
          </T>
        ) : null}
      </View>
      {error ? (
        <T variant="caption" style={{ marginTop: 4, color: t.statusText.critical }} accessibilityLiveRegion="assertive">
          {error}
        </T>
      ) : null}
    </View>
  );
}

function OpportunityCard({
  opportunity,
  businessProfileId,
  onViewRecords,
  onAskAboutThis,
  onSimulate,
}: {
  opportunity: ReductionOpportunity;
  businessProfileId: number;
  onViewRecords: (categoryId: number) => void;
  onAskAboutThis: (opportunity: ReductionOpportunity) => void;
  onSimulate: (opportunity: ReductionOpportunity) => void;
}) {
  const t = useTheme();
  const priority = PRIORITY_COPY[opportunity.priority];
  const [showDetails, setShowDetails] = useState(false);
  const evidence = opportunity.evidence;
  const previous = evidence.previousAmount;
  const maximum = Math.max(evidence.currentAmount, previous ?? 0, 1);
  const change = previous === null ? null : evidence.currentAmount - previous;
  const changeLabel = previous === null || evidence.changePercent === null
    ? "No earlier comparison"
    : change === 0 ? "0% · unchanged" : `${Math.abs(evidence.changePercent).toFixed(1)}% ${change! > 0 ? "higher" : "lower"}`;
  const comparisonData: ChartDatum[] = [{ key: String(opportunity.id), label: `${opportunity.categoryName} spending comparison`, values: [{ label: "This period", value: evidence.currentAmount, color: t.brandFill }, { label: "Previous period", value: previous, color: t.textMuted, unavailableLabel: "No earlier comparison" }, { label: "Share of expenses", value: evidence.expenseSharePercent, display: `${evidence.expenseSharePercent.toFixed(1)}%` }], note: changeLabel }];
  const comparisonSelection = useChartSelection(comparisonData, businessProfileId);
  const action = (label: string, spoken: string, icon: keyof typeof Ionicons.glyphMap, onPress: () => void, primary = false) => (
    <Pressable
      onPress={() => { haptics.tapped(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      style={({ pressed }) => ({
        minHeight: TAP_FLOOR,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        borderWidth: 1,
        borderColor: primary ? t.brandText : t.brandBorder,
        borderRadius: radius.md,
        backgroundColor: primary ? t.brandSurface : t.surface,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        opacity: pressed ? 0.7 : 1,
        ...(primary ? {} : { flex: 1, minWidth: 130 }),
      })}
    >
      <Ionicons name={icon} size={20} color={t.brandText} />
      <T style={{ color: t.brandText, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, flexShrink: 1, textAlign: "center" }}>{label}</T>
    </Pressable>
  );

  return (
    <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, backgroundColor: t.surface, padding: space.lg, gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <T variant="caption" style={{ color: t.textMuted }}>Reduction opportunity</T>
        <T accessibilityRole="header" style={{ fontSize: typeScale.display, fontFamily: font.sansSemibold, color: t.brandHeading }}>{opportunity.categoryName}</T>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "100%" }}>
            <Ionicons name="alert-circle" size={20} color={t.statusText[priority.tone]} />
            <T style={{ color: t.statusText[priority.tone], fontSize: typeScale.bodySm, fontFamily: font.sansMedium, flexShrink: 1 }}>{priority.label}</T>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "100%" }}>
            <Ionicons name="cellular-outline" size={18} color={t.textSecondary} />
            <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, flexShrink: 1 }}>{CONFIDENCE_LABEL[opportunity.confidence]}</T>
          </View>
        </View>
      </View>
      <View style={{ gap: space.sm }}>
        <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>This period</T>
        <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.display, color: t.brandHeading, fontVariant: ["tabular-nums"] }}>{formatMoney(evidence.currentAmount, { decimals: true })}</T>
        <T style={{ color: t.textSecondary }}>{opportunity.observation}</T>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.border, paddingVertical: space.md }}>
        <View style={{ flex: 1, minWidth: 115, gap: space.xs }}>
          <T variant="caption">Share of expenses</T>
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.title, color: t.brandHeading }}>{evidence.expenseSharePercent.toFixed(1)}%</T>
        </View>
        <View style={{ flex: 1, minWidth: 115, gap: space.xs }}>
          <T variant="caption">Change</T>
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: t.brandHeading }}>{changeLabel}</T>
        </View>
      </View>
      {opportunity.type === "FREQUENT_PURCHASE_ACCUMULATION" ? <T style={{ color: t.textSecondary }}>{evidence.recordCount} records this period</T> : opportunity.type === "RECORD_REVIEW_FIRST" ? <T style={{ color: t.textSecondary }}>{evidence.possibleDuplicateCount} possible duplicates · {evidence.unusualRecordCount} unusual records</T> : null}
      {previous !== null ? (
        <View style={{ gap: space.md }}>
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: t.brandHeading }}>Compared with last period</T>
          {[
            { label: "Previous period", amount: previous, color: t.textMuted },
            { label: "This period", amount: evidence.currentAmount, color: t.brandFill },
          ].map((row) => (
            <View key={row.label} accessible accessibilityLabel={`${row.label}, ${formatMoney(row.amount, { decimals: true })}`} style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}>
                <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>{row.label}</T>
                <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, fontVariant: ["tabular-nums"] }}>{formatMoney(row.amount, { decimals: true })}</T>
              </View>
              <ChartPlotPressArea selection={comparisonSelection} count={1} chartLabel={`${opportunity.categoryName} opportunity comparison`}>
              <View accessible={false} style={{ height: 8, borderRadius: radius.sm, backgroundColor: t.surfaceMuted }}>
                <View style={{ height: 8, borderRadius: radius.sm, width: `${Math.max(0, Math.min(100, row.amount / maximum * 100))}%`, backgroundColor: row.color }} />
              </View>
              </ChartPlotPressArea>
            </View>
          ))}
          <ChartValueReadout data={comparisonData} selection={comparisonSelection} chartLabel={`${opportunity.categoryName} opportunity comparison`} />
          <T variant="caption">{change === 0 ? `${opportunity.categoryName} stayed the same.` : `${opportunity.categoryName} was ${formatMoney(Math.abs(change!), { decimals: true })} ${change! > 0 ? "higher" : "lower"} than the previous period.`}</T>
        </View>
      ) : null}
      <View style={{ gap: space.sm }}>
        {action("Simulate a reduction", `Simulate a reduction for ${opportunity.categoryName}`, "calculator-outline", () => onSimulate(opportunity), true)}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {action("View records", `View related records for ${opportunity.categoryName}`, "document-text-outline", () => onViewRecords(opportunity.categoryId))}
          {action("Ask FinSight", `Ask FinSight about this ${opportunity.categoryName} opportunity`, "chatbubble-outline", () => onAskAboutThis(opportunity))}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showDetails }}
        accessibilityLabel={showDetails ? `Hide details for ${opportunity.categoryName}` : `Details for ${opportunity.categoryName}`}
        onPress={() => setShowDetails((value) => !value)}
        style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md }}
      >
        <T style={{ color: t.brandText, flex: 1, fontFamily: font.sansSemibold }}>{showDetails ? "Hide details" : "Why this was highlighted"}</T>
        <Ionicons name={showDetails ? "chevron-up" : "chevron-down"} size={18} color={t.brandText} />
      </Pressable>
      {showDetails ? (
        <View style={{ gap: space.md }}>
          <T style={{ color: t.textSecondary }}>{opportunity.rationale}</T>
          {COST_BEHAVIOR_BADGE[opportunity.costBehavior] ? <T variant="caption">{COST_BEHAVIOR_BADGE[opportunity.costBehavior]}</T> : null}
          {opportunity.costBehavior === "fixed" ? <T style={{ color: t.textSecondary }}>Fixed cost: check the contract or whether it is still needed.</T> : opportunity.costBehavior === "mixed" ? <T style={{ color: t.textSecondary }}>Mixed cost: part stays flat, part changes with activity.</T> : null}
          {opportunity.suggestedChecks.length > 0 ? (
            <View style={{ gap: space.sm }}>
              <T style={{ fontFamily: font.sansSemibold }}>Suggested checks</T>
              {opportunity.suggestedChecks.map((check, index) => <T key={index} style={{ color: t.textSecondary }}>{check}</T>)}
            </View>
          ) : null}
          {opportunity.limitations.length > 0 ? (
            <View style={{ gap: space.sm }}>
              <T style={{ fontFamily: font.sansSemibold }}>Limitations</T>
              {opportunity.limitations.map((limitation, index) => <T key={index} style={{ color: t.textSecondary }}>{limitation}</T>)}
            </View>
          ) : null}
          <OpportunityFeedback opportunityId={opportunity.id} businessProfileId={businessProfileId} categoryName={opportunity.categoryName} />
        </View>
      ) : null}
      <T variant="caption">Based on your recorded expenses</T>
    </View>
  );
}

/** A layout-stable placeholder while the opportunity fetch is in flight. */
function OpportunitiesSkeleton() {
  const t = useTheme();
  return (
    <Card>
      <View
        accessible
        accessibilityLabel="Loading reduction opportunities"
        style={{ alignItems: "center", paddingVertical: space.lg }}
      >
        <ActivityIndicator color={t.brand[600]} />
      </View>
    </Card>
  );
}

export function ReductionOpportunitiesSection({
  state,
  businessProfileId,
  onViewRecords,
  onAskAboutThis,
  onSimulate,
  historical,
}: {
  state: {
    data: ReductionOpportunityResponse | null;
    loading: boolean;
    error: string | null;
    load: () => void | Promise<void>;
  };
  /** Needed for the "Was this helpful?" feedback POST — see OpportunityFeedback. */
  businessProfileId: number;
  onViewRecords: (categoryId: number) => void;
  onAskAboutThis: (opportunity: ReductionOpportunity) => void;
  onSimulate: (opportunity: ReductionOpportunity) => void;
  /** True when the period shown is an owner-selected historical window, not "now". */
  historical: boolean;
}) {
  const t = useTheme();
  const { data, loading, error } = state;
  const [showAll, setShowAll] = useState(false);

  return (
    <View>
      <View style={{ marginBottom: space.sm }}>
        <SectionTitle eyebrow="Reduction opportunities" question="Where can I save?" icon="bulb-outline" />
      </View>

      {error ? (
        <Card>
          <ErrorNote>{error}</ErrorNote>
          <View style={{ marginTop: space.sm, alignSelf: "flex-start" }}>
            <Button title="Try again" variant="secondary" onPress={() => void state.load()} />
          </View>
        </Card>
      ) : loading || !data ? (
        <OpportunitiesSkeleton />
      ) : data.dataQuality.status === "insufficient" ? (
        <Card>
          <T variant="caption">
            {data.dataQuality.message ?? "Not enough expense history yet to look for reduction opportunities."}
          </T>
        </Card>
      ) : (
        <View style={{ gap: space.sm }}>
          {data.dataQuality.message ? <T style={{ color: t.textSecondary, marginBottom: space.sm }}>{data.dataQuality.message}</T> : null}
          {historical && data.period.start ? (
            <Callout tone="info">
              Historical period: {data.period.start.slice(0, 10)} to {data.period.end.slice(0, 10)}.
            </Callout>
          ) : null}
          {data.opportunities.length === 0 ? (
            <Card>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.ink[900] }}>
                No material opportunities found
              </T>
              <T variant="caption" style={{ marginTop: 2 }}>
                No expense patterns crossed the review thresholds for this period.
              </T>
            </Card>
          ) : (
            <View style={{ gap: space.lg }}>
              {data.opportunities.slice(0, showAll ? undefined : MAX_CARDS).map((opportunity) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                businessProfileId={businessProfileId}
                onViewRecords={onViewRecords}
                onAskAboutThis={onAskAboutThis}
                onSimulate={onSimulate}
              />
              ))}
              {data.opportunities.length > MAX_CARDS ? (
                <ExpenseActionButton title={showAll ? "Show fewer opportunities" : `Show all ${data.opportunities.length} opportunities`} variant="secondary" onPress={() => setShowAll(!showAll)} />
              ) : null}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
