import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../lib/haptics";
import { Button, Callout, Card, ErrorNote, SelectChip, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { api, errorMessage } from "../lib/api";
import { font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
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

/**
 * The category's owner-controlled cost-behavior classification, as a small
 * badge — plan §5.2/§15 Phase 5. Only shown for "fixed" and "mixed": those
 * are the two behaviors the backend's suggested-check catalogue actually adds
 * copy for (`COST_BEHAVIOR_SUGGESTED_CHECK_CATALOGUE` in
 * reductionOpportunity.service.ts appends nothing for "variable" or
 * "unclassified"), so this badge is the only extra signal needed — the
 * checklist below the card already carries the rest.
 */
const COST_BEHAVIOR_BADGE: Partial<Record<ReductionOpportunity["costBehavior"], string>> = {
  fixed: "Fixed cost",
  mixed: "Mixed cost",
};

/**
 * Two or three evidence figures per card (plan §10.2), chosen by type so each
 * card leads with the numbers that actually explain why it appeared rather
 * than a generic slice of the evidence object.
 */
function evidenceFigures(o: ReductionOpportunity): { label: string; value: string }[] {
  const e = o.evidence;
  switch (o.type) {
    case "FREQUENT_PURCHASE_ACCUMULATION":
      return [
        { label: "Records this period", value: `${e.recordCount}` },
        { label: "Category total", value: formatMoney(e.currentAmount) },
        { label: "Share of expenses", value: `${e.expenseSharePercent.toFixed(0)}%` },
      ];
    case "RECORD_REVIEW_FIRST":
      return [
        { label: "Possible duplicates", value: `${e.possibleDuplicateCount}` },
        { label: "Unusual records", value: `${e.unusualRecordCount}` },
        { label: "Category total", value: formatMoney(e.currentAmount) },
      ];
    case "CATEGORY_PRESSURE":
    default:
      return [
        { label: "This period", value: formatMoney(e.currentAmount) },
        { label: "Share of expenses", value: `${e.expenseSharePercent.toFixed(0)}%` },
        e.changePercent === null
          ? { label: "Change", value: "New this period" }
          : { label: "Change", value: `${e.changePercent >= 0 ? "+" : ""}${e.changePercent.toFixed(0)}%` },
      ];
  }
}

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
            Thanks — noted.
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
  const { brand, ink, paper } = t;
  const priority = PRIORITY_COPY[opportunity.priority];
  const figures = evidenceFigures(opportunity);

  return (
    <Card>
      {/*
        Not collapsed into one accessible node: unlike SpendingBreakdownCard's
        flip, this card carries a real interactive control below ("View
        related records") that has to stay individually reachable, so the
        priority/confidence/category read as their own labelled elements
        instead.
      */}
      <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
        <View
          style={{
            paddingHorizontal: space.sm,
            paddingVertical: 2,
            borderRadius: 11,
            backgroundColor: t.statusSurface[priority.tone],
          }}
        >
          <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: t.statusText[priority.tone] }}>
            {priority.label}
          </T>
        </View>
        <View
          style={{
            paddingHorizontal: space.sm,
            paddingVertical: 2,
            borderRadius: 11,
            backgroundColor: paper[200],
          }}
        >
          <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink[600] }}>
            {CONFIDENCE_LABEL[opportunity.confidence]}
          </T>
        </View>
        {COST_BEHAVIOR_BADGE[opportunity.costBehavior] ? (
          <View
            style={{
              paddingHorizontal: space.sm,
              paddingVertical: 2,
              borderRadius: 11,
              borderWidth: 1,
              borderColor: brand[200],
              backgroundColor: brand[50],
            }}
          >
            <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: brand[700] }}>
              {COST_BEHAVIOR_BADGE[opportunity.costBehavior]}
            </T>
          </View>
        ) : null}
      </View>

      <T style={{ marginTop: space.sm, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: ink[900] }}>
        {opportunity.categoryName}
      </T>
      <T variant="caption" style={{ marginTop: 2 }}>
        {opportunity.observation}
      </T>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, marginTop: space.md }}>
        {figures.map((f) => (
          <View key={f.label} accessible accessibilityLabel={`${f.label}: ${f.value}`}>
            <T variant="label" style={{ color: ink[500] }}>
              {f.label}
            </T>
            <T style={{ fontFamily: font.monoMedium, fontSize: typeScale.bodySm, color: ink[900], marginTop: 2 }}>
              {f.value}
            </T>
          </View>
        ))}
      </View>

      <T variant="caption" style={{ marginTop: space.md, fontFamily: font.sansSemibold, color: ink[700] }}>
        Why this appeared
      </T>
      <T variant="caption" style={{ marginTop: 2 }}>
        {opportunity.rationale}
      </T>

      {opportunity.suggestedChecks.length > 0 ? (
        <View style={{ marginTop: space.md }}>
          <T variant="caption" style={{ fontFamily: font.sansSemibold, color: ink[700] }}>
            Suggested checks
          </T>
          {opportunity.suggestedChecks.map((check) => (
            <T key={check} variant="caption" style={{ marginTop: 2 }}>
              • {check}
            </T>
          ))}
        </View>
      ) : null}

      {opportunity.limitations.length > 0 ? (
        <View style={{ marginTop: space.md }}>
          <T variant="caption" style={{ fontFamily: font.sansSemibold, color: ink[700] }}>
            Limitations
          </T>
          {opportunity.limitations.map((limitation) => (
            <T key={limitation} variant="caption" style={{ marginTop: 2 }}>
              • {limitation}
            </T>
          ))}
        </View>
      ) : null}

      <OpportunityFeedback
        opportunityId={opportunity.id}
        businessProfileId={businessProfileId}
        categoryName={opportunity.categoryName}
      />

      {/* All three actions §10.2 lists, in its own order. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Pressable
          onPress={() => {
            haptics.tapped();
            onViewRecords(opportunity.categoryId);
          }}
          accessibilityRole="button"
          accessibilityLabel={`View related records for ${opportunity.categoryName}`}
          style={({ pressed }) => ({
            marginTop: space.md,
            minHeight: TAP_FLOOR,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <T style={{ color: brand[700], fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>
            View related records
          </T>
          <Ionicons name="chevron-forward" size={16} color={brand[700]} />
        </Pressable>

        {/*
          Opens Ask FinSight with the question already in the composer — see
          lib/reductionOpportunityAsk.ts. Nothing is sent here: the sheet's
          own Send button is the owner's, same gate SpendingImpactScreen's
          "Talk this through" card uses. A separate quoted-preview card was
          not added per card the way that screen's single scenario gets one —
          up to three of these on screen at once would mean up to three quote
          boxes repeating text the composer is about to show anyway — but the
          composer opens already carrying the exact words, editable or
          deletable before anything reaches the AI.
        */}
        <Pressable
          onPress={() => {
            haptics.tapped();
            onAskAboutThis(opportunity);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Ask FinSight about this ${opportunity.categoryName} opportunity`}
          style={({ pressed }) => ({
            marginTop: space.md,
            minHeight: TAP_FLOOR,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="sparkles-outline" size={15} color={brand[700]} />
          <T style={{ color: brand[700], fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>
            Ask FinSight about this
          </T>
        </Pressable>

        {/*
          Phase 4 — plan §12.4: a modal launched from the card, scoped to its
          own category. See ReductionSimulationSheet.tsx for why it never
          shows availableFunds and why it does not reuse Spending Impact's UI.
        */}
        <Pressable
          onPress={() => {
            haptics.tapped();
            onSimulate(opportunity);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Simulate a reduction for ${opportunity.categoryName}`}
          style={({ pressed }) => ({
            marginTop: space.md,
            minHeight: TAP_FLOOR,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="calculator-outline" size={15} color={brand[700]} />
          <T style={{ color: brand[700], fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>
            Simulate reduction
          </T>
        </Pressable>
      </View>
    </Card>
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
  const { brand } = t;
  const { data, loading, error } = state;

  return (
    <View>
      <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm, color: brand[900] }}>
        Reduction opportunities
      </T>

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
          {historical ? (
            <Callout tone="info">
              Showing {data.period.start.slice(0, 10)} to {data.period.end.slice(0, 10)} — a historical window, not
              the current period.
            </Callout>
          ) : null}
          {data.opportunities.length === 0 ? (
            <Card>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.ink[900] }}>
                No material opportunities found
              </T>
              <T variant="caption" style={{ marginTop: 2 }}>
                Nothing crossed the review thresholds for this period. That is a good sign, not a gap in the check.
              </T>
            </Card>
          ) : (
            data.opportunities.slice(0, MAX_CARDS).map((opportunity) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                businessProfileId={businessProfileId}
                onViewRecords={onViewRecords}
                onAskAboutThis={onAskAboutThis}
                onSimulate={onSimulate}
              />
            ))
          )}
        </View>
      )}
    </View>
  );
}
