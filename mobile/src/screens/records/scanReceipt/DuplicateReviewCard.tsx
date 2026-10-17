import { View } from "react-native";
import { Button, Card, ErrorNote, Money, T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { space } from "../../../theme/tokens";
import { duplicateReasonLabel, duplicateReviewIsComplete, type ReceiptDuplicateReview } from "./duplicateReview";

/** Possible existing copies of this receipt, which must all be seen before Save anyway. */
export function DuplicateReviewCard({
  review,
  loadError,
  busy,
  locked,
  onLoadMore,
  onSaveAnyway,
  onGoBack,
}: {
  review: ReceiptDuplicateReview;
  loadError: string | null;
  busy: boolean;
  /** Another review action is in progress. */
  locked: boolean;
  onLoadMore: () => void;
  onSaveAnyway: () => void;
  onGoBack: () => void;
}) {
  const { border } = useTheme();
  return (
    <Card emphasis>
      <T variant="title" accessibilityRole="header">Possible duplicate</T>
      <T variant="caption" style={{ marginTop: 2, marginBottom: space.md }}>
        {review.code === "DUPLICATE_REVIEW_CHANGED"
          ? "The possible matches changed while you were reviewing them. Compare this latest list before deciding."
          : "This receipt may already be in your records. Compare the vendor, date and total before saving another copy."}
      </T>
      <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.sm }}>
        Showing {review.candidates.length} of {review.candidateCount} possible {review.candidateCount === 1 ? "match" : "matches"}.
      </T>
      <View style={{ gap: space.sm }}>
        {review.candidates.map((candidate) => (
          <View
            key={candidate.id}
            style={{ borderTopWidth: 1, borderTopColor: border, paddingTop: space.sm, gap: 2 }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.sm }}>
              <T variant="heading" style={{ flex: 1 }}>{candidate.vendor?.trim() || "Vendor not recorded"}</T>
              <Money value={candidate.total} decimals />
            </View>
            <T variant="caption">{candidate.date.slice(0, 10)} · {candidate.scoreBand === "EXACT" ? "Exact match" : "Likely match"}</T>
            <T variant="caption">
              {candidate.reasons.length > 0
                ? [...new Set(candidate.reasons.map(duplicateReasonLabel))].join(" · ")
                : "Similar receipt details"}
            </T>
          </View>
        ))}
      </View>
      <View style={{ gap: space.sm, marginTop: space.md }}>
        {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}
        {!duplicateReviewIsComplete(review) ? (
          <>
            <T variant="caption">Load and review every possible match before saving another copy.</T>
            <Button
              title={loadError ? "Try loading remaining matches again" : "Load remaining matches"}
              variant="secondary"
              loading={busy}
              disabled={locked}
              onPress={onLoadMore}
            />
          </>
        ) : null}
        <Button
          title="Save anyway"
          variant="danger"
          loading={busy}
          disabled={!duplicateReviewIsComplete(review) || locked}
          onPress={onSaveAnyway}
        />
        <Button
          title="Go back and edit"
          variant="ghost"
          disabled={busy}
          onPress={onGoBack}
        />
      </View>
    </Card>
  );
}
