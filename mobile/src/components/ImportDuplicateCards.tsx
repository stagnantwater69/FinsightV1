import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, ConfirmSheet, ErrorNote, T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { api } from "../lib/api";
import { describeActionFailure, toLoadFailure } from "../lib/connectionState";
import { setFlash } from "../lib/flash";
import { importDuplicateGroups, type ImportDuplicateGroup } from "../lib/flagGroups";
import * as haptics from "../lib/haptics";
import { formatMoney } from "../lib/money";
import type { ImportBatchPage, ImportBatchSummary, RecordItem } from "../lib/types";
import { font, radius, space, typeScale } from "../theme/tokens";

/**
 * One card per CSV import that left two or more flagged duplicates, with a
 * single Keep all / Discard all for the whole file. This is the bulk half of
 * the old Review records screen; one-off flags are decided on their own
 * screen from the list below.
 */
export function ImportDuplicateCards({
  records,
  hasMore,
  businessProfileId,
  onChanged,
  onOpen,
}: {
  /** Every flagged record loaded so far, not just the visible page. */
  records: readonly RecordItem[];
  /** More flagged records exist than are loaded, so a group may be partial. */
  hasMore: boolean;
  businessProfileId: number;
  onChanged: () => Promise<unknown> | void;
  /** Given on the Review tab: each import is one row that opens ImportDuplicatesScreen, where it is decided. */
  onOpen?: (records: RecordItem[]) => void;
}) {
  const t = useTheme();
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<ImportDuplicateGroup | null>(null);
  const groups = importDuplicateGroups(records.filter((r) => r.businessProfileId === businessProfileId), batches);
  const wantsNames = groups.length > 0;

  useEffect(() => {
    if (!wantsNames) return;
    let cancelled = false;
    // Names only: a group that cannot name its file still works as "An imported file".
    api.get<ImportBatchPage | ImportBatchSummary[]>("/records/csv-imports/batches", { businessProfileId })
      .then((data) => { if (!cancelled) setBatches(Array.isArray(data) ? data : data.items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [businessProfileId, wantsNames]);

  if (groups.length === 0) return null;

  async function resolve(group: ImportDuplicateGroup, action: "keep" | "discard") {
    if (group.records.some((r) => r.businessProfileId !== businessProfileId)) return;
    setBusy(group.batchId);
    setError(null);
    try {
      const res = await api.post<{ resolved: number }>("/records/duplicates/resolve", {
        businessProfileId,
        action,
        expenseIds: group.records.filter((r) => r.type === "expense").map((r) => r.id),
        salesIds: group.records.filter((r) => r.type === "sales").map((r) => r.id),
      });
      if (action === "discard") haptics.warned(); else haptics.succeeded();
      // The server's count: it leaves out anything already decided elsewhere.
      setFlash(`${action === "keep" ? "Kept" : "Discarded"} ${res.resolved} record${res.resolved === 1 ? "" : "s"}`);
      await onChanged();
    } catch (err) {
      haptics.failed();
      setError(describeActionFailure(toLoadFailure(err), "These records are still waiting for review."));
    } finally {
      setBusy(null);
    }
  }

  if (onOpen) {
    const total = groups.reduce((sum, group) => sum + group.records.length, 0);
    return (
      <View style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T accessibilityRole="header" style={{ flex: 1, fontSize: typeScale.subpageTitle, fontFamily: font.sansSemibold, color: t.textPrimary }}>Duplicate imports</T>
          <View style={{ borderRadius: radius.full, paddingHorizontal: space.md, paddingVertical: space.xs, backgroundColor: t.statusSurface.warning }}>
            <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.statusText.warning }}>{`${total} records`}</T>
          </View>
        </View>
        <Card style={{ paddingVertical: space.xs }}>
          {groups.map((group, index) => {
            const count = group.records.length;
            const sum = group.records.reduce((acc, r) => acc + r.amount, 0);
            const title = group.batch?.title ?? "An imported file";
            const meta = `${count} possible duplicates${group.batch ? ` · Imported ${group.batch.uploadDate.slice(0, 10)}` : ""}`;
            return (
              <Pressable
                key={group.batchId}
                accessibilityRole="button"
                accessibilityLabel={`${title}, ${meta}, ${formatMoney(sum)}. Review this import.`}
                onPress={() => onOpen(group.records)}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: t.border, opacity: pressed ? 0.7 : 1 })}
              >
                <Ionicons name="document-text-outline" size={22} color={t.statusText.warning} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                    <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>{title}</T>
                    <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.body, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(sum)}</T>
                  </View>
                  <T numberOfLines={1} style={{ fontSize: typeScale.bodySm, color: t.statusText.warning }}>{meta}</T>
                </View>
                <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
              </Pressable>
            );
          })}
        </Card>
      </View>
    );
  }

  const discardCount = pendingDiscard?.records.length ?? 0;
  return (
    <View style={{ gap: space.md }}>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {groups.map((group) => {
        const count = group.records.length;
        const total = group.records.reduce((sum, r) => sum + r.amount, 0);
        return (
          <Card key={group.batchId} style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Ionicons name="document-text-outline" size={18} color={t.statusText.warning} />
              <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.statusText.warning }}>Duplicates from one import</T>
            </View>
            <T numberOfLines={1} style={{ fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>
              {group.batch?.title ?? "An imported file"}
            </T>
            <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>
              {`${group.batch ? `Imported ${group.batch.uploadDate.slice(0, 10)} · ` : ""}${count} possible duplicates · `}
              <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoSemibold, color: t.textPrimary }}>{formatMoney(total)}</T>
            </T>
            {hasMore ? (
              <T variant="caption">Applies to the {count} loaded so far. More flagged records may be on later pages.</T>
            ) : null}
            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
              <Button title={`Keep all ${count}`} variant="secondary" disabled={busy !== null} onPress={() => void resolve(group, "keep")} style={{ flex: 1 }} />
              <Button title={`Discard all ${count}`} variant="danger" disabled={busy !== null} onPress={() => setPendingDiscard(group)} style={{ flex: 1 }} />
            </View>
          </Card>
        );
      })}
      <ConfirmSheet
        visible={pendingDiscard !== null}
        title={`Discard ${discardCount} records?`}
        body={`This deletes these ${discardCount} copies for good. The original records they duplicate are not flagged and stay exactly as they are.`}
        confirmLabel={`Discard ${discardCount}`}
        confirmVariant="danger"
        busy={pendingDiscard !== null && busy === pendingDiscard.batchId}
        onConfirm={() => {
          const group = pendingDiscard;
          if (!group) return;
          void resolve(group, "discard").finally(() => setPendingDiscard(null));
        }}
        onCancel={() => setPendingDiscard(null)}
      />
    </View>
  );
}
