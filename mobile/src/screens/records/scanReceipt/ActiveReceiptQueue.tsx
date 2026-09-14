import { ActivityIndicator, View } from "react-native";
import { Button, Money, T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { radius, space } from "../../../theme/tokens";
import type { ReceiptHistoryItem } from "./types";

export type ReceiptResumeAction = "wait" | "review" | "retry";

function receiptResumeAction(item: ReceiptHistoryItem): ReceiptResumeAction | null {
  if (item.processingStatus === "Processing") return "wait";
  if (item.processingStatus === "Failed") return item.allowedActions.retryProcessing ? "retry" : null;
  return item.allowedActions.reviewResult ? "review" : null;
}

function actionLabel(action: ReceiptResumeAction | null) {
  if (action === "wait") return "Continue waiting";
  if (action === "retry") return "Retry processing";
  if (action === "review") return "Review result";
  return "No action available";
}

function statusCopy(item: ReceiptHistoryItem) {
  if (item.processingStatus === "Processing") return "FinSight is still reading the stored images.";
  if (item.processingStatus === "Failed") {
    return item.processingError || "FinSight couldn't read this receipt. The stored images are still available.";
  }
  return "Ready for you to check before saving.";
}

export function ActiveReceiptQueue({
  items,
  loading,
  loadingMore,
  hasMore,
  error,
  deletingId,
  onRefresh,
  onLoadMore,
  onDelete,
  onOpen,
}: {
  items: ReceiptHistoryItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  deletingId: number | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  onDelete: (item: ReceiptHistoryItem) => void;
  onOpen: (item: ReceiptHistoryItem, action: ReceiptResumeAction) => void;
}) {
  const t = useTheme();
  if (!loading && !error && items.length === 0) return null;

  return (
    <View
      style={{
        gap: space.sm,
        marginBottom: space.lg,
        padding: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
      }}
    >
      <View style={{ gap: 2 }}>
        <T variant="heading" accessibilityRole="header">Receipts to finish</T>
        <T variant="caption">Continue an upload from any device. FinSight uses the securely stored receipt images.</T>
      </View>

      {loading && items.length === 0 ? (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <ActivityIndicator color={t.brandText} />
          <T variant="caption">Checking for unfinished receipts…</T>
        </View>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="assertive" style={{ gap: space.sm }}>
          <T accessibilityRole="alert" variant="caption" style={{ color: t.statusText.critical }}>{error}</T>
          <Button title="Check again" variant="secondary" onPress={onRefresh} loading={loading} />
        </View>
      ) : null}

      {items.map((item) => {
        const action = receiptResumeAction(item);
        const named = item.extractedVendor?.trim() || item.extractedDescription?.trim();
        // Rows still being read have no vendor yet, so the scan number keeps
        // two of them apart for a screen reader and for the owner.
        const title = named || `Stored receipt ${item.id}`;
        const rowName = item.receiptBatchId && item.receiptOrdinal ? `${title}, receipt ${item.receiptOrdinal}` : title;
        return (
          <View
            key={item.id}
            style={{ gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.sm }}>
              <T variant="heading" style={{ flexGrow: 1, flexShrink: 1 }}>{title}</T>
              {item.extractedAmount != null ? <Money value={item.extractedAmount} decimals /> : null}
            </View>
            <T variant="caption">{statusCopy(item)}</T>
            {item.receiptBatchId && item.receiptOrdinal ? (
              <T variant="caption">Receipt {item.receiptOrdinal} in its capture batch</T>
            ) : null}
            <Button
              title={actionLabel(action)}
              accessibilityLabel={`${actionLabel(action)} for ${rowName}`}
              variant={action === "review" ? "primary" : "secondary"}
              disabled={!action || deletingId !== null}
              onPress={() => { if (action) onOpen(item, action); }}
            />
            <Button
              title="Delete scan"
              accessibilityLabel={`Delete scan for ${rowName}`}
              variant="danger"
              disabled={deletingId !== null && deletingId !== item.id}
              loading={deletingId === item.id}
              onPress={() => onDelete(item)}
            />
          </View>
        );
      })}

      {hasMore ? <Button title="Show more receipts" variant="ghost" onPress={onLoadMore} loading={loadingMore} /> : null}
    </View>
  );
}
