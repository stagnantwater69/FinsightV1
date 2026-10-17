import { View } from "react-native";
import { Button, T } from "./ui";
import { NumberedPagination } from "./NumberedPagination";
import { useTheme } from "../context/ThemeContext";
import { space, typeScale } from "../theme/tokens";

export function ExpensePagination({ label, page, size, count, totalCount, complete, available, busy, hasNext, onPage, onNext, error, onRetry }: {
  label: "Review" | "Recurring"; page: number; size: number; count: number; totalCount?: number; complete: boolean; available: boolean;
  busy: boolean; hasNext: boolean; onPage: (page: number) => void; onNext: () => void;
  error?: string | null; onRetry?: () => void;
}) {
  const t = useTheme();
  const start = page * size;
  const knownTotal = complete ? count : totalCount !== undefined && Number.isInteger(totalCount) && totalCount >= count ? totalCount : null;
  return (
    <View style={{ gap: space.md }}>
      {available && count > 0 ? <T accessibilityLiveRegion="polite" style={{ color: t.textPrimary, fontSize: typeScale.bodySm }}>Page {page + 1}{knownTotal !== null ? ` of ${Math.ceil(knownTotal / size)}` : ""}</T> : null}
      <T accessibilityLiveRegion="polite" style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>{available ? count > 0 ? `Showing ${start + 1}–${Math.min(start + size, count)}${knownTotal !== null ? ` of ${knownTotal}${!complete && hasNext ? " · More available" : ""}` : hasNext ? " · More available" : ""}` : complete ? "No items to show" : `Loading ${label.toLowerCase()} items…` : "Item count unavailable"}</T>
      <NumberedPagination page={page} totalPages={knownTotal !== null ? Math.max(1, Math.ceil(knownTotal / size)) : undefined} reachablePages={Math.max(page + 1, Math.ceil(count / size))} busy={busy} available={available} hasNext={hasNext} onPage={onPage} onNext={onNext} />
      {error ? <View style={{ gap: space.sm }}><T style={{ color: t.statusText.critical, fontSize: typeScale.bodySm }}>{error}</T><Button title="Retry next page" variant="secondary" onPress={onRetry ?? onNext} disabled={busy} /></View> : null}
    </View>
  );
}
