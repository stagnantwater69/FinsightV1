import { useState } from "react";
import { View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, ErrorNote, OptionSheet, Screen, T } from "../components/ui";
import { ContentScrollView } from "../components/ContentScrollView";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { FindingReview, UnusualComparison } from "../components/ExpenseAlertsSection";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useAiChat } from "../context/AiChatContext";
import { useTheme } from "../context/ThemeContext";
import { api, errorMessage } from "../lib/api";
import { SIGNAL_COPY, findingSignalStrength } from "../lib/confidenceBands";
import { setFlash } from "../lib/flash";
import { feedbackActions, findingCategory, type FeedbackAction } from "../lib/findingFeedback";
import * as haptics from "../lib/haptics";
import { formatMoney } from "../lib/money";
import { formatDueDate } from "../lib/recurringAgenda";
import type { AnomalyFindingFeedback } from "../lib/types";
import type { InsightsScreenProps } from "../navigation/types";
import { font, space, typeScale } from "../theme/tokens";

/** What each answer does, in the words of the card's buttons. */
const CHOICES: Record<AnomalyFindingFeedback, { name: string; effect: string }> = {
  CONFIRMED_UNUSUAL: { name: "Yes, unusual", effect: "It really was out of the ordinary. It is kept as a confirmed flag." },
  EXPECTED_TRANSACTION: { name: "Expected expense", effect: "It is normal for your business. The flag is cleared and FinSight treats this as normal for you." },
  DUPLICATE: { name: "Mark duplicate", effect: "It copies another record. It is noted as a duplicate; the record itself is not deleted here." },
  INCORRECT_MATCH: { name: "Wrong match", effect: "The two are different purchases. The flag is cleared." },
  NO_LONGER_RELEVANT: { name: "No longer relevant", effect: "Clears it from your review list." },
};

/**
 * One finding or unusual expense, opened from a row on the Expenses Review
 * tab. The page is about that one item: the decision, why it was flagged, and
 * what each answer does. On success the owner goes back to the list, where the
 * row is gone and the flash names what they answered.
 */
export function FindingDetailScreen({ navigation, route }: InsightsScreenProps<"FindingDetail">) {
  const { finding, expense } = route.params;
  const t = useTheme();
  const { selected } = useBusinessProfiles();
  const chat = useAiChat();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [answersOpen, setAnswersOpen] = useState(false);

  async function review(_id: number, action: FeedbackAction) {
    if (!finding || !selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/insights/findings/${finding.id}/review`, {
        status: action.status,
        feedback: action.feedback,
      }, { cacheScope: { businessProfileId: selected.id } });
      haptics.succeeded();
      setFlash(action.toast);
      navigation.goBack();
    } catch (err) {
      haptics.failed();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const line = { fontSize: typeScale.bodySm, color: t.textSecondary };
  const heading = { fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary };
  const fact = (label: string, value: string, mono = false) => (
    <View key={label} style={{ flexDirection: "row", gap: space.md }}>
      <T style={{ ...line, width: 112 }}>{label}</T>
      <T style={{ flex: 1, fontSize: typeScale.bodySm, color: t.textPrimary, ...(mono ? { fontFamily: font.monoSemibold, fontVariant: ["tabular-nums" as const] } : {}) }}>{value}</T>
    </View>
  );
  const multiple = expense && expense.categoryMean > 0 ? expense.amount / expense.categoryMean : null;
  const signal = finding ? SIGNAL_COPY[findingSignalStrength(finding.severity, finding.score)] : null;
  const answers = finding ? feedbackActions(findingCategory(finding.type)) : [];

  return (
    <Screen>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {finding ? (
          <FindingReview
            finding={finding}
            expense={expense}
            showEvidence={false}
            reviewFinding={review}
            onOtherAnswers={() => setAnswersOpen(true)}
            onExplain={(f) => {
              // The flag's id travels with the question so the answer is about this one.
              chat.prepareQuestion(`Why did FinSight flag "${f.title}"? Explain the comparison behind it.`, undefined, { kind: "finding", findingId: f.id });
              setAskOpen(true);
            }}
          />
        ) : expense ? <UnusualComparison expense={expense} /> : null}

        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons name="help-circle-outline" size={20} color={t.textMuted} />
            <T accessibilityRole="header" style={{ ...heading, flex: 1 }}>Why this was flagged</T>
          </View>
          {finding ? (
            finding.reasons.map((reason, index) => <T key={index} style={line}>{`• ${reason}`}</T>)
          ) : expense ? (
            <T style={line}>{`This expense is well above what you usually spend on ${expense.categoryName}.`}</T>
          ) : null}
          {signal ? <T style={line}>{`${signal.label}: ${signal.detail}`}</T> : null}
          <View style={{ gap: space.sm }}>
            {expense ? fact("Category", expense.categoryName) : null}
            {expense ? fact("Date", formatDueDate(expense.date) || expense.date.slice(0, 10)) : null}
            {expense ? fact("This expense", formatMoney(expense.amount, { decimals: true }), true) : null}
            {expense ? fact("Category average", formatMoney(expense.categoryMean, { decimals: true }), true) : null}
            {multiple !== null ? fact("Compared", `${multiple.toFixed(1)}× the category average`) : null}
            {finding ? fact("Detected", formatDueDate(finding.detectedAt)) : null}
            {finding ? fact("Reference", `Finding #${finding.id}${finding.expenseRecordId !== null ? ` · Record #${finding.expenseRecordId}` : ""}`) : null}
          </View>
        </Card>

        {finding ? (
          <Card style={{ gap: space.sm }}>
            <T accessibilityRole="header" style={heading}>What each choice does</T>
            {answers.slice(0, 2).map((action) => (
              <T key={action.feedback} style={line}>
                <T style={{ ...line, fontFamily: font.sansSemibold, color: t.textPrimary }}>{`${CHOICES[action.feedback].name}: `}</T>
                {CHOICES[action.feedback].effect}
              </T>
            ))}
            <T style={line}>
              <T style={{ ...line, fontFamily: font.sansSemibold, color: t.textPrimary }}>Other answers: </T>
              {`${answers.slice(2).map((action) => CHOICES[action.feedback].name).join(", ")}.`}
            </T>
          </Card>
        ) : (
          <T variant="caption">FinSight compares this expense with the usual amount in its category. Nothing needs answering here.</T>
        )}
      </ContentScrollView>
      <AskFinSightFab onPress={() => setAskOpen(true)} />
      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Expense Insights" />
      <OptionSheet
        visible={answersOpen && finding !== undefined}
        title="What was this, really?"
        options={answers.map((a) => ({ id: a.feedback, name: a.label }))}
        value={finding?.feedback ?? null}
        onChoose={(id) => {
          const action = answers.find((a) => a.feedback === id);
          if (action && finding) void review(finding.id, action);
        }}
        onClose={() => setAnswersOpen(false)}
        emptyText="No answers available."
      />
    </Screen>
  );
}
