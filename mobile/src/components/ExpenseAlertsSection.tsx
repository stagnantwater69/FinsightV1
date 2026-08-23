import { ActivityIndicator, Pressable, View } from "react-native";
import { Alert as AlertBanner, Button, Card, ErrorNote, T } from "./ui";
import { Medallion } from "./InsightsShared";
import { Ionicons } from "@expo/vector-icons";
import { SIGNAL_COPY, findingSignalStrength } from "../lib/confidenceBands";
import { findingCategory, quickActions, type FeedbackAction } from "../lib/findingFeedback";
import { TAP, font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { AnomalyFinding, AnomalyFindingPage, ExpenseBehavior } from "../lib/types";

/**
 * The Alerts sub-section of Expense insight — things that want the owner's
 * attention, decisions first and context-only items under them.
 *
 * Split out of ExpenseBehaviorScreen.tsx as a pure presentational piece: all
 * the state (the finding list, its loading/error, the feedback sheet) lives
 * on the screen and is handed down as props, so this file has no fetch of
 * its own.
 */
export function ExpenseAlertsSection({
  unusualExpenses,
  insufficientHistoryCategories,
  openFindings,
  findingState,
  feedbackError,
  reviewFinding,
  onOtherAnswers,
}: {
  unusualExpenses: ExpenseBehavior["unusualExpenses"];
  insufficientHistoryCategories: ExpenseBehavior["insufficientHistoryCategories"];
  openFindings: number;
  findingState: { data: AnomalyFindingPage | null; loading: boolean; error: string | null };
  feedbackError: string | null;
  reviewFinding: (id: number, action: FeedbackAction) => void | Promise<void>;
  onOtherAnswers: (finding: AnomalyFinding) => void;
}) {
  const t = useTheme();
  const { brand, ink, paper, statusText } = t;
  /*
    NOTHING FLAGGED is a result, not an absence.

    With no findings and no unusual expenses this rendered two cards
    containing one grey sentence each — the layout of a screen that had
    failed to load. A clean month is the outcome an owner wants, and it
    should look like one rather than like a blank.
  */
  if (openFindings === 0 && unusualExpenses.length === 0) {
    return (
      <Card>
        <View style={{ alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
          <View
            style={{
              width: 84,
              height: 84,
              borderRadius: 42,
              backgroundColor: t.statusSurface.good,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: space.lg,
            }}
          >
            <Ionicons name="checkmark-circle-outline" size={40} color={statusText.good} />
          </View>
          <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>
            Nothing needs a look
          </T>
          <T variant="caption" style={{ textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 260 }}>
            No duplicates, no unusual amounts. FinSight checks every record as it is added and will
            put anything worth reviewing here.
          </T>
        </View>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.md }}>Unusual expenses</T>
        {unusualExpenses.length === 0 ? (
          <T variant="caption">Nothing flagged as unusual right now.</T>
        ) : (
          <View style={{ gap: space.sm }}>
            {unusualExpenses.map((u) => (
              <AlertBanner
                key={u.id}
                kind="large-expense"
                label="Unusual for this category"
                meta={`${u.categoryName} · ${u.date.slice(0, 10)}`}
              >
                {u.description} — usually around {Math.round(u.categoryMean).toLocaleString("en-PH")}
              </AlertBanner>
            ))}
          </View>
        )}
        {insufficientHistoryCategories.length > 0 ? (
          <T variant="caption" style={{ marginTop: space.md }}>
            Not enough history yet to check:{" "}
            {insufficientHistoryCategories.map((c) => c.categoryName).join(", ")}
          </T>
        ) : null}
      </Card>

      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: 2 }}>
          {openFindings > 0
            ? `${openFindings} ${openFindings === 1 ? "item needs" : "items need"} your review`
            : "FinSight findings"}
        </T>
        <T variant="caption" style={{ marginBottom: space.sm }}>
          Each one is a question, not a verdict — you decide what it was.
        </T>
        {findingState.error ? <ErrorNote>{findingState.error}</ErrorNote> : null}
        {findingState.loading ? <ActivityIndicator color={brand[600]} /> : null}
        {!findingState.loading && (findingState.data?.items.length ?? 0) === 0 ? (
          <T variant="caption">No findings need review.</T>
        ) : null}
        {feedbackError ? <ErrorNote>{feedbackError}</ErrorNote> : null}
        <View style={{ gap: space.sm }}>
          {findingState.data?.items.map((finding) => {
            /*
              A duplicate and an unusual amount are different questions
              with different answers, so they are told apart before they
              are read — colour, glyph and the wording of the buttons.
            */
            const category = findingCategory(finding.type);
            const duplicate = category === "duplicate";
            /*
              How much attention the finding is asking for, in words.
              ADR-4: the detector's severity grade and its raw score
              are internal, and "HIGH" reads as an accusation — the
              band says what the owner should do instead. The score
              only ever breaks a tie inside the mapping.
            */
            const signal = SIGNAL_COPY[findingSignalStrength(finding.severity, finding.score)];
            const quick = quickActions(category);
            return (
              <View
                key={finding.id}
                style={{
                  borderWidth: 1,
                  borderColor: paper[200],
                  borderRadius: radius.md,
                  padding: space.md,
                }}
              >
                <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
                  <Medallion
                    icon={duplicate ? "copy-outline" : "alert-circle-outline"}
                    tint={duplicate ? statusText.warning : statusText.critical}
                    surface={duplicate ? t.statusSurface.warning : t.statusSurface.critical}
                  />
                  <View style={{ flex: 1 }}>
                    <T style={{ fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansSemibold }}>
                      {finding.title}
                    </T>
                    {/*
                      The band, in words — never colour alone, and
                      never the raw score.
                    */}
                    <T
                      style={{
                        marginTop: 2,
                        fontSize: typeScale.micro,
                        fontFamily: font.sansSemibold,
                        color: signal.tone === "info" ? brand[700] : statusText[signal.tone],
                      }}
                    >
                      {signal.label}
                    </T>
                    {/*
                      WHY, capped at three. The detectors write these
                      in the owner's own figures; a fourth line is
                      where a card stops being read.
                    */}
                    {finding.reasons.slice(0, 3).map((reason) => (
                      <T key={reason} variant="caption" style={{ marginTop: 2, color: ink[700] }}>
                        • {reason}
                      </T>
                    ))}
                    <T variant="caption" style={{ marginTop: 4 }}>
                      {signal.detail}
                    </T>
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                  {quick.map((action, i) => (
                    <View key={action.feedback} style={{ flex: 1 }}>
                      <Button
                        title={action.label}
                        variant={i === 0 ? "brand" : "secondary"}
                        onPress={() => void reviewFinding(finding.id, action)}
                      />
                    </View>
                  ))}
                </View>
                <Pressable
                  onPress={() => onOtherAnswers(finding)}
                  accessibilityRole="button"
                  accessibilityLabel={`Other answers for ${finding.title}`}
                  style={{ minHeight: TAP, justifyContent: "center" }}
                >
                  <T variant="caption" style={{ color: brand[700] }}>
                    Something else…
                  </T>
                </Pressable>
              </View>
            );
          })}
        </View>
      </Card>
    </>
  );
}
