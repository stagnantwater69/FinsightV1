import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, ConfirmSheet, ErrorNote, Screen, T } from "../../components/ui";
import { ContentScrollView } from "../../components/ContentScrollView";
import { FAB_CLEARANCE } from "../../components/AskFinSightFab";
import { RecordOriginPanel } from "../../components/RecordOrigin";
import { SkeletonBox } from "../../components/Skeleton";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { useTheme } from "../../context/ThemeContext";
import { api } from "../../lib/api";
import { describeActionFailure, toLoadFailure } from "../../lib/connectionState";
import { setFlash } from "../../lib/flash";
import { flagReasonText } from "../../lib/flagReasons";
import { returnFromFlagDetail } from "../../lib/flaggedRecordsNavigation";
import * as haptics from "../../lib/haptics";
import { formatMoney } from "../../lib/money";
import { recordUpdatePath } from "../../lib/recordUpdate";
import { RECORD_SOURCE_LABELS, type RecordDetail, type RecordItem, type RecordSource } from "../../lib/types";
import type { RecordsScreenProps } from "../../navigation/types";
import { font, space, typeScale } from "../../theme/tokens";

type Decision = "keep" | "discard" | "reviewed";
type Loaded = { status: "loading" } | { status: "ready"; detail: RecordDetail } | { status: "missing" };

/**
 * One flagged record, opened from a row on the Expenses Review tab.
 *
 * The point of the screen is the comparison: a duplicate is shown above the
 * record it may copy, so "keep or discard" is decided by looking rather than
 * guessing from one line. The decision uses the same requests as the Flagged
 * records screen, for this record only.
 */
export function FlagDetailScreen({ navigation, route }: RecordsScreenProps<"FlagDetail">) {
  const { record } = route.params;
  const t = useTheme();
  const { selected, categories } = useBusinessProfiles();
  const duplicate = record.duplicateStatus === "Flagged";
  const [self, setSelf] = useState<Loaded>({ status: "loading" });
  const [original, setOriginal] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchDetail = (type: RecordItem["type"], id: number, set: (value: Loaded) => void) =>
      api.get<RecordDetail>(recordUpdatePath(type, id))
        .then((detail) => { if (!cancelled) set({ status: "ready", detail }); })
        // A deleted original (or a failed fetch) still leaves this record decidable.
        .catch(() => { if (!cancelled) set({ status: "missing" }); });
    void fetchDetail(record.type, record.id, setSelf);
    if (duplicate && record.duplicateOfRecordId) void fetchDetail(record.type, record.duplicateOfRecordId, setOriginal);
    else setOriginal({ status: "missing" });
    return () => { cancelled = true; };
  }, [record.type, record.id, record.duplicateOfRecordId, duplicate]);

  if (!selected) return null;
  if (selected.id !== record.businessProfileId) {
    return (
      <Screen>
        <View style={{ padding: space.lg }}>
          <Card><T>This record belongs to a different business.</T></Card>
        </View>
      </Screen>
    );
  }

  const reason = flagReasonText(record, selected);
  const categoryName = (id: number | undefined) => categories.find((c) => c.id === id)?.name ?? "No category";
  const date = (value: string) => new Date(value).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  async function decide(decision: Decision) {
    setBusy(true);
    setError(null);
    try {
      if (decision === "reviewed") {
        await api.patch(
          recordUpdatePath(record.type, record.id),
          { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" },
          { cacheScope: { businessProfileId: record.businessProfileId } },
        );
      } else {
        await api.post("/records/duplicates/resolve", {
          businessProfileId: record.businessProfileId,
          action: decision,
          expenseIds: record.type === "expense" ? [record.id] : [],
          salesIds: record.type === "sales" ? [record.id] : [],
        });
      }
      if (decision === "discard") haptics.warned(); else haptics.succeeded();
      setFlash(decision === "discard" ? "Discarded 1 record" : decision === "keep" ? "Kept 1 record" : "Marked reviewed");
      // Same return path as the header back button, which App.tsx wires with an untyped navigation too.
      returnFromFlagDetail(navigation as never);
    } catch (err) {
      haptics.failed();
      setError(describeActionFailure(toLoadFailure(err), "This record is still waiting for review."));
      setBusy(false);
    }
  }

  const line = { fontSize: typeScale.bodySm, color: t.textSecondary };
  const heading = { fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary };
  const threshold = selected.expectedMonthlyExpenses * (selected.largeExpenseThresholdPercent / 100);
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  // What the flagged record shares with the one it may copy, once that one has loaded.
  const match: [string, boolean][] | null = duplicate && original.status === "ready" ? [
    ["Dates", record.date.slice(0, 10) === original.detail.date.slice(0, 10)],
    ["Amounts", Number(record.amount) === Number(original.detail.amount)],
    ["Descriptions", same(record.description, original.detail.description)],
    ...(record.vendor || original.detail.vendor ? [["Vendors", same(record.vendor, original.detail.vendor)] as [string, boolean]] : []),
  ] : null;

  const row = (label: string, value: string | null | undefined) => value ? (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
      <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>{label}</T>
      <T style={{ flexShrink: 1, textAlign: "right", fontSize: typeScale.bodySm, color: t.textPrimary }}>{value}</T>
    </View>
  ) : null;

  const recordCard = (heading: string, item: RecordItem, detail: RecordDetail | null, footer?: ReactNode) => (
    <Card style={{ gap: space.sm }}>
      <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textSecondary, textTransform: "uppercase", letterSpacing: 0.6 }}>{heading}</T>
      <T style={{ fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>{item.description}</T>
      <T style={{ fontSize: typeScale.titleLg, fontFamily: font.monoSemibold, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(item.amount, { decimals: true })}</T>
      <View>
        {row("Date", date(item.date))}
        {row("Category", categoryName(item.categoryId))}
        {row("Vendor", item.vendor)}
        {row("Added by", RECORD_SOURCE_LABELS[item.source as RecordSource] ?? item.source)}
        {row("Record", `#${item.id}`)}
      </View>
      {detail?.origin ? <RecordOriginPanel origin={detail.origin} recordAmount={item.amount} /> : null}
      {footer}
    </Card>
  );

  return (
    <Screen>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
          <Ionicons name={duplicate ? "copy-outline" : "flag-outline"} size={20} color={t.statusText.warning} style={{ marginTop: 1 }} />
          <T style={{ flex: 1, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.statusText.warning }}>
            {reason.charAt(0).toUpperCase() + reason.slice(1)}
          </T>
        </View>

        {/* The decision sits in the first card, the same place as on the other Review detail pages. */}
        {recordCard(duplicate ? "Flagged record" : "This expense", record, self.status === "ready" ? self.detail : null, (
          <View style={{ gap: space.sm, marginTop: space.xs }}>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            {duplicate ? (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button title="Keep" variant="secondary" disabled={busy} onPress={() => void decide("keep")} style={{ flex: 1 }} />
                <Button title="Discard" variant="danger" disabled={busy} onPress={() => setConfirmDiscard(true)} style={{ flex: 1 }} />
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button title="Edit" variant="secondary" disabled={busy} onPress={() => navigation.navigate("EditRecord", { record })} style={{ flex: 1 }} />
                <Button title="Mark as reviewed" variant="brand" loading={busy} onPress={() => void decide("reviewed")} style={{ flex: 1 }} />
              </View>
            )}
          </View>
        ))}

        {duplicate && record.duplicateOfRecordId ? (
          original.status === "loading" ? (
            <Card><View accessible accessibilityLabel="Loading the original record"><SkeletonBox height={120} /></View></Card>
          ) : original.status === "ready" ? (
            recordCard("Looks like this one", original.detail, original.detail)
          ) : (
            <Card><T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>{`Record #${record.duplicateOfRecordId} couldn't be shown. It may have been deleted.`}</T></Card>
          )
        ) : null}


        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons name="help-circle-outline" size={20} color={t.textMuted} />
            <T accessibilityRole="header" style={{ ...heading, flex: 1 }}>Why this was flagged</T>
          </View>
          {duplicate ? (
            <T style={line}>{`It has the same date and amount as ${record.duplicateOfRecordId ? `record #${record.duplicateOfRecordId}` : "another record"}, which you already had. Two records like that are often the same purchase entered twice${record.importBatchId ? ", here by a CSV import" : ""}.`}</T>
          ) : null}
          {match ? (
            <View style={{ gap: space.sm }}>
              {match.map(([label, same]) => (
                <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Ionicons name={same ? "checkmark" : "close"} size={16} color={same ? t.statusText.warning : t.textMuted} />
                  <T style={{ flex: 1, fontSize: typeScale.bodySm, color: t.textPrimary }}>{`${label} ${same ? "match" : "differ"}`}</T>
                </View>
              ))}
            </View>
          ) : null}
          {record.largeExpenseFlag ? (
            <T style={line}>{`It is ${formatMoney(record.amount)}, over your ${formatMoney(threshold)} large-expense limit: ${selected.largeExpenseThresholdPercent}% of the ${formatMoney(selected.expectedMonthlyExpenses)} you expect to spend in a month. You can change the limit in your business profile.`}</T>
          ) : null}
        </Card>

        <Card style={{ gap: space.sm }}>
          <T accessibilityRole="header" style={heading}>What each choice does</T>
          {(duplicate
            ? [
                ["Keep", "It is a separate purchase. It stays and stops being flagged."],
                ["Discard", `It is a copy. It is deleted for good; ${record.duplicateOfRecordId ? `record #${record.duplicateOfRecordId}` : "the original"} stays exactly as it is.`],
              ]
            : [
                ["Mark as reviewed", "The amount is correct. It is marked reviewed and the flag is cleared."],
                ["Edit", "Something is wrong with it. Opens the full record so you can fix the amount or details, or delete it."],
              ]
          ).map(([name, effect]) => (
            <T key={name} style={line}>
              <T style={{ ...line, fontFamily: font.sansSemibold, color: t.textPrimary }}>{`${name}: `}</T>
              {effect}
            </T>
          ))}
        </Card>
      </ContentScrollView>

      <ConfirmSheet
        visible={confirmDiscard}
        title="Discard 1 record?"
        body="This deletes this copy for good. The original record it duplicates is not flagged and stays exactly as it is."
        confirmLabel="Discard 1"
        confirmVariant="danger"
        busy={busy}
        onConfirm={() => { void decide("discard").finally(() => setConfirmDiscard(false)); }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </Screen>
  );
}
