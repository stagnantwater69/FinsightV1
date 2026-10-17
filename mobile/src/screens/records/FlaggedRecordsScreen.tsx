import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, View } from "react-native";
import { CONTENT_WIDTH } from "../../components/ContentScrollView";
import { useFocusEffect } from "@react-navigation/native";
import { AlertBadge, Button, Card, ConfirmSheet, Disclosure, EmptyState, ErrorNote, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api } from "../../lib/api";
import { ConnectionNotice, LastUpdated } from "../../components/ConnectionNotice";
import {
  describeActionFailure,
  describeLoadFailure,
  toLoadFailure,
  type LoadFailure,
} from "../../lib/connectionState";
import { setFlash } from "../../lib/flash";
import {
  SERVER_STATE_STALE_MS,
  isServerStateAffected,
  subscribeToServerState,
} from "../../lib/serverStateCache";
import * as haptics from "../../lib/haptics";
import { font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import Ionicons from "@expo/vector-icons/Ionicons";
import { TAP_FLOOR } from "../../components/touchTarget";
import { flagReasonText } from "../../lib/flagReasons";
import { formatMoney } from "../../lib/money";
import { RECORD_SOURCE_LABELS, type FlaggedRecordCounts, type FlaggedRecordPage, type RecordItem, type RecordSource } from "../../lib/types";
import { badges, type ImportBatchSummary } from "./shared";

/**
 * How many flagged records one request asks for.
 *
 * The server's ceiling on the paginated form is 100. It is NOT the same number
 * as the 200-item cap it applies to a request that sends no `limit` at all —
 * that cap is a safety net for un-updated clients, and silently hides
 * everything past it. This screen always sends a `limit`, so it always gets
 * `{ items, nextCursor }` and can walk to the end of a re-imported
 * spreadsheet's worth of duplicates instead of stopping at 200.
 */
const PAGE_SIZE = 100;

/** Identity for de-duping appended pages — ids are unique per table, not across. */
const recordKey = (r: RecordItem) => `${r.type}-${r.id}`;

interface DuplicateGroup {
  key: string;
  /** The batch these came in on, when they all did. */
  batch: ImportBatchSummary | null;
  records: RecordItem[];
}

type ReviewListItem =
  | { key: string; kind: "heading"; label: string; spaced: boolean }
  | { key: string; kind: "group"; group: DuplicateGroup }
  | { key: string; kind: "record"; record: RecordItem };

/**
 * HOW THIS SCREEN GROUPS DUPLICATES, AND WHY IT GROUPS THEM AT ALL
 * ================================================================
 * A flat list asks one question per flagged record. That is fine for three
 * and unusable for three hundred — and three hundred is not a strange case,
 * it is what re-importing one spreadsheet produces. The answer an owner gives
 * to the first row is almost always the answer they would give to every row,
 * so the screen should ask once.
 *
 * Every flagged record appears in EXACTLY ONE group, which is the property
 * that makes a bulk action safe. Two overlapping groupings would let the same
 * record be discarded from one card and kept from another, and whichever was
 * tapped second would act on a record that no longer exists.
 *
 * So duplicates are split by where they came from: those that arrived on a
 * CSV import group by that import (the real story is "this file was imported
 * twice", and one decision settles the whole file), and everything else
 * groups by duplicateOfRecordId — the record they all duplicate, which
 * findDuplicate already points every copy at, so the key is free rather than
 * reconstructed here.
 *
 * Records flagged for being LARGE rather than duplicated are not grouped at
 * all: each is its own judgement about one purchase, and there is nothing to
 * batch. Mirrors web's FlaggedRecords.tsx exactly.
 */
function groupDuplicates(
  duplicates: RecordItem[],
  batches: ImportBatchSummary[],
): { byImport: DuplicateGroup[]; byMatch: DuplicateGroup[] } {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const importGroups = new Map<number, RecordItem[]>();
  const matchGroups = new Map<string, RecordItem[]>();

  for (const record of duplicates) {
    if (record.importBatchId) {
      const list = importGroups.get(record.importBatchId) ?? [];
      list.push(record);
      importGroups.set(record.importBatchId, list);
      continue;
    }
    // Falls back to the record's own id so a copy whose original has since
    // been deleted still forms a group of one rather than being dropped.
    const key = `match-${record.duplicateOfRecordId ?? `self-${record.type}-${record.id}`}`;
    const list = matchGroups.get(key) ?? [];
    list.push(record);
    matchGroups.set(key, list);
  }

  return {
    byImport: [...importGroups.entries()].map(([batchId, records]) => ({
      key: `import-${batchId}`,
      batch: batchById.get(batchId) ?? null,
      records,
    })),
    byMatch: [...matchGroups.entries()].map(([key, records]) => ({ key, batch: null, records })),
  };
}
export function FlaggedRecordsScreen() {
  const t = useTheme();
  const { brand, ink } = t;
  const { selected, categories } = useBusinessProfiles();
  const selectedBusinessProfileId = selected?.id ?? null;
  const selectedBusinessProfileIdRef = useRef(selectedBusinessProfileId);
  selectedBusinessProfileIdRef.current = selectedBusinessProfileId;
  const requestVersionRef = useRef(0);
  const focusedRef = useRef(false);
  const dirtyRef = useRef(true);
  const loadedAtRef = useRef<number | null>(null);
  const loadingBusinessProfileIdRef = useRef<number | null>(null);
  const invalidationGenerationRef = useRef(0);
  const loadedBusinessProfileIdRef = useRef<number | null>(null);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [loadedBusinessProfileId, setLoadedBusinessProfileId] = useState<number | null>(null);
  /** The cursor for the page after what is on screen; null once there is none. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * The total from `/records/flagged/count`, or null when that call failed.
   *
   * Its own endpoint on purpose: this number used to be `records.length`,
   * which meant rendering a count downloaded every flagged record to measure
   * it. Null rather than 0 on failure — "0 records to review" is an all-clear
   * this screen has no grounds to give when it does not know.
   */
  const [flaggedTotal, setFlaggedTotal] = useState<number | null>(null);
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** The group whose "Discard" is waiting on the confirm sheet. */
  const [pendingDiscard, setPendingDiscard] = useState<DuplicateGroup | null>(null);
  /** A failed resolve — reassures about the record, not about the list's age. */
  const [error, setError] = useState<string | null>(null);
  /** A failed "Load more" — sits with the button, not over the whole screen. */
  const [moreError, setMoreError] = useState<string | null>(null);
  /** A failed fetch of the review queue. See lib/connectionState.ts. */
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => () => {
    selectedBusinessProfileIdRef.current = null;
    loadedBusinessProfileIdRef.current = null;
    requestVersionRef.current += 1;
    loadingBusinessProfileIdRef.current = null;
  }, []);

  const load = useCallback(async () => {
    if (
      selectedBusinessProfileId === null ||
      selectedBusinessProfileIdRef.current !== selectedBusinessProfileId
    ) return;
    const requestBusinessProfileId = selectedBusinessProfileId;
    if (loadingBusinessProfileIdRef.current === requestBusinessProfileId) return;
    loadingBusinessProfileIdRef.current = requestBusinessProfileId;
    const requestVersion = ++requestVersionRef.current;
    const invalidationGeneration = invalidationGenerationRef.current;
    const retainingCurrentData = loadedBusinessProfileIdRef.current === requestBusinessProfileId;
    if (!retainingCurrentData) {
      loadedBusinessProfileIdRef.current = null;
      setLoadedBusinessProfileId(null);
      setRecords([]);
      setNextCursor(null);
      setFlaggedTotal(null);
      setBatches([]);
      setLoadedAt(null);
      loadedAtRef.current = null;
      setLoadFailure(null);
      setError(null);
      setMoreError(null);
      setBusyKey(null);
      setPendingDiscard(null);
      setLoadingMore(false);
      setLoading(true);
      setRefreshing(false);
    } else {
      setRefreshing(true);
    }
    setClock(Date.now());
    try {
      // Together rather than in sequence: the batch list only supplies names
      // for the groups below, so waiting for one before asking for the other
      // would delay the screen for no reason.
      const [page, importBatches, count] = await Promise.all([
        api.get<FlaggedRecordPage>("/records/flagged", {
          businessProfileId: requestBusinessProfileId,
          limit: PAGE_SIZE,
        }),
        api
          .get<ImportBatchSummary[]>("/records/csv-imports/batches", {
            businessProfileId: requestBusinessProfileId,
          })
          // A group that cannot name its import still works — it just says
          // "an import" instead of the file's title.
          .catch(() => [] as ImportBatchSummary[]),
        // Swallowed like the batches: the queue itself is usable without the
        // headline number, and an error banner over a list that loaded fine
        // would be the bigger problem.
        api
          .get<FlaggedRecordCounts>("/records/flagged/count", {
            businessProfileId: requestBusinessProfileId,
          })
          .catch(() => null),
      ]);
      if (
        requestVersionRef.current !== requestVersion ||
        selectedBusinessProfileIdRef.current !== requestBusinessProfileId ||
        invalidationGenerationRef.current !== invalidationGeneration
      ) return;
      setRecords(page.items);
      setNextCursor(page.nextCursor);
      setFlaggedTotal(count ? count.total : null);
      setBatches(importBatches);
      const completedAt = Date.now();
      setLoadedAt(completedAt);
      loadedAtRef.current = completedAt;
      dirtyRef.current = false;
      setLoadFailure(null);
      loadedBusinessProfileIdRef.current = requestBusinessProfileId;
      setLoadedBusinessProfileId(requestBusinessProfileId);
    } catch (err) {
      if (
        requestVersionRef.current !== requestVersion ||
        selectedBusinessProfileIdRef.current !== requestBusinessProfileId ||
        invalidationGenerationRef.current !== invalidationGeneration
      ) return;
      if (!retainingCurrentData) {
        setRecords([]);
        setNextCursor(null);
        setFlaggedTotal(null);
        setBatches([]);
        setLoadedAt(null);
        loadedAtRef.current = null;
      }
      dirtyRef.current = true;
      setLoadFailure(toLoadFailure(err));
      loadedBusinessProfileIdRef.current = requestBusinessProfileId;
      setLoadedBusinessProfileId(requestBusinessProfileId);
    } finally {
      if (loadingBusinessProfileIdRef.current === requestBusinessProfileId) {
        loadingBusinessProfileIdRef.current = null;
      }
      if (
        requestVersionRef.current === requestVersion &&
        selectedBusinessProfileIdRef.current === requestBusinessProfileId
      ) {
        setLoading(false);
        setRefreshing(false);
      }
      if (
        invalidationGenerationRef.current !== invalidationGeneration &&
        selectedBusinessProfileIdRef.current === requestBusinessProfileId &&
        focusedRef.current
      ) {
        void load();
      }
    }
  }, [selectedBusinessProfileId]);

  /**
   * The next page, appended rather than replacing what is on screen.
   *
   * Appending is what makes the grouping below stay correct across pages: a
   * re-imported file's duplicates are grouped by import batch, and paging
   * "Previous / Next" the way RecordsScreen does would split one such group
   * across pages and offer a bulk action over part of it. A failure here is
   * reported as an ACTION failure, not a load failure — the records already
   * listed are untouched and still resolvable.
   */
  const loadMore = useCallback(async () => {
    if (
      selectedBusinessProfileId === null ||
      loadedBusinessProfileId !== selectedBusinessProfileId ||
      selectedBusinessProfileIdRef.current !== selectedBusinessProfileId ||
      !nextCursor ||
      loadingMore
    ) return;
    const requestBusinessProfileId = selectedBusinessProfileId;
    const requestVersion = requestVersionRef.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get<FlaggedRecordPage>("/records/flagged", {
        businessProfileId: requestBusinessProfileId,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (
        requestVersionRef.current !== requestVersion ||
        selectedBusinessProfileIdRef.current !== requestBusinessProfileId ||
        loadedBusinessProfileIdRef.current !== requestBusinessProfileId
      ) return;
      setRecords((current) => {
        const seen = new Set(current.map(recordKey));
        return [...current, ...page.items.filter((r) => !seen.has(recordKey(r)))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (
        requestVersionRef.current !== requestVersion ||
        selectedBusinessProfileIdRef.current !== requestBusinessProfileId
      ) return;
      setMoreError(describeActionFailure(toLoadFailure(err), "The records already listed are still here.", "read"));
    } finally {
      if (
        requestVersionRef.current === requestVersion &&
        selectedBusinessProfileIdRef.current === requestBusinessProfileId
      ) setLoadingMore(false);
    }
  }, [loadedBusinessProfileId, loadingMore, nextCursor, selectedBusinessProfileId]);

  const needsRefresh = useCallback(() => (
    dirtyRef.current ||
    loadedBusinessProfileIdRef.current !== selectedBusinessProfileId ||
    loadedAtRef.current === null ||
    Date.now() - loadedAtRef.current >= SERVER_STATE_STALE_MS
  ), [selectedBusinessProfileId]);

  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    if (needsRefresh()) void load();
    return () => {
      focusedRef.current = false;
    };
  }, [load, needsRefresh]));

  useEffect(() => subscribeToServerState((event) => {
    if (event.type === "clear") {
      dirtyRef.current = true;
      loadedAtRef.current = null;
      requestVersionRef.current += 1;
      loadedBusinessProfileIdRef.current = null;
      setLoadedBusinessProfileId(null);
      setRecords([]);
      setNextCursor(null);
      setFlaggedTotal(null);
      setBatches([]);
      setLoadedAt(null);
      setLoadFailure(null);
      return;
    }
    if (
      selectedBusinessProfileId !== null &&
      isServerStateAffected(
        "/records/flagged",
        { businessProfileId: selectedBusinessProfileId },
        event,
      )
    ) {
      dirtyRef.current = true;
      invalidationGenerationRef.current += 1;
      if (focusedRef.current) void load();
    }
  }), [load, selectedBusinessProfileId]);

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (nextState) => {
      const returningToForeground =
        /inactive|background/.test(previousState) && nextState === "active";
      previousState = nextState;
      if (returningToForeground && focusedRef.current && needsRefresh()) void load();
    });
    return () => subscription.remove();
  }, [load, needsRefresh]);

  async function resolve(r: RecordItem) {
    if (
      selectedBusinessProfileIdRef.current !== r.businessProfileId ||
      loadedBusinessProfileIdRef.current !== r.businessProfileId
    ) return;
    const path = r.type === "expense" ? `/records/expenses/${r.id}` : `/records/sales/${r.id}`;
    const key = `record-${recordKey(r)}`;
    setBusyKey(key);
    setError(null);
    try {
      await api.patch(
        path,
        { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" },
        { cacheScope: { businessProfileId: r.businessProfileId } },
      );
      if (selectedBusinessProfileIdRef.current !== r.businessProfileId) return;
      await load();
    } catch (err) {
      if (selectedBusinessProfileIdRef.current === r.businessProfileId) setError(describeActionFailure(toLoadFailure(err), "This record is still waiting for review."));
    } finally {
      if (selectedBusinessProfileIdRef.current === r.businessProfileId) setBusyKey(null);
    }
  }

  /**
   * One decision applied to a whole group.
   *
   * The confirm states the count and says what survives. "Discard 40 records"
   * on its own reads as though it might take the owner's real purchases with
   * it — naming the originals as safe is the difference between a button
   * someone can press and one they abandon.
   */
  async function resolveGroup(group: DuplicateGroup, action: "keep" | "discard") {
    // Discard goes through ConfirmSheet rather than `Alert.alert`: the system
    // alert is a no-op on Expo web, so the button looked dead there.
    if (action === "discard") {
      setPendingDiscard(group);
      return;
    }
    await runGroupAction(group, action);
  }

  async function runGroupAction(group: DuplicateGroup, action: "keep" | "discard") {
    const activeBusinessProfileId = selectedBusinessProfileIdRef.current;
    if (
      activeBusinessProfileId === null ||
      loadedBusinessProfileIdRef.current !== activeBusinessProfileId ||
      group.records.some((record) => record.businessProfileId !== activeBusinessProfileId)
    ) return;
    setBusyKey(group.key);
    try {
      const res = await api.post<{ resolved: number }>("/records/duplicates/resolve", {
        businessProfileId: activeBusinessProfileId,
        action,
        expenseIds: group.records.filter((r) => r.type === "expense").map((r) => r.id),
        salesIds: group.records.filter((r) => r.type === "sales").map((r) => r.id),
      });
      if (selectedBusinessProfileIdRef.current !== activeBusinessProfileId) return;
      if (action === "discard") {
        haptics.warned();
      } else {
        haptics.succeeded();
      }
      // The server's count, not the group's — it excludes anything already
      // resolved elsewhere, and saying "40" when 38 were left would be a
      // small lie about the owner's own books.
      setFlash(
        action === "keep"
          ? `Kept ${res.resolved} record${res.resolved === 1 ? "" : "s"}`
          : `Discarded ${res.resolved} record${res.resolved === 1 ? "" : "s"}`,
      );
      await load();
    } catch (err) {
      if (selectedBusinessProfileIdRef.current !== activeBusinessProfileId) return;
      haptics.failed();
      setError(describeActionFailure(toLoadFailure(err), "These records are still waiting for review."));
    } finally {
      if (selectedBusinessProfileIdRef.current === activeBusinessProfileId) setBusyKey(null);
    }
  }

  if (!selected) return null;

  const discardCount = pendingDiscard?.records.length ?? 0;
  const loadedForSelectedBusiness = loadedBusinessProfileId === selected.id;
  const visibleRecords = loadedForSelectedBusiness ? records : [];
  const visibleBatches = loadedForSelectedBusiness ? batches : [];
  const visibleFlaggedTotal = loadedForSelectedBusiness ? flaggedTotal : null;
  const visibleLoadFailure = loadedForSelectedBusiness ? loadFailure : null;
  const visibleError = loadedForSelectedBusiness ? error : null;
  const visibleMoreError = loadedForSelectedBusiness ? moreError : null;
  const visibleLoadedAt = loadedForSelectedBusiness ? loadedAt : null;
  const visibleLoading = (loading && !loadedForSelectedBusiness) || !loadedForSelectedBusiness;
  const duplicates = visibleRecords.filter((r) => r.duplicateStatus === "Flagged");
  const others = visibleRecords.filter((r) => r.duplicateStatus !== "Flagged");
  const { byImport, byMatch } = groupDuplicates(duplicates, visibleBatches);
  const listItems: ReviewListItem[] = [
    ...(byImport.length > 0
      ? [
          { key: "heading-import", kind: "heading" as const, label: `Duplicates from an imported file · ${byImport.reduce((sum, group) => sum + group.records.length, 0)} records shown`, spaced: false },
          ...byImport.map((group) => ({ key: group.key, kind: "group" as const, group })),
        ]
      : []),
    ...(byMatch.length > 0
      ? [
          { key: "heading-match", kind: "heading" as const, label: `Possible duplicates · ${byMatch.reduce((sum, group) => sum + group.records.length, 0)} records shown`, spaced: true },
          ...byMatch.map((group) => ({ key: group.key, kind: "group" as const, group })),
        ]
      : []),
    ...(others.length > 0
      ? [
          { key: "heading-other", kind: "heading" as const, label: "Other records to check", spaced: true },
          ...others.map((record) => ({ key: `record-${recordKey(record)}`, kind: "record" as const, record })),
        ]
      : []),
  ];

  const recordMeta = (record: RecordItem) => [
    new Date(record.date).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
    categories.find((category) => category.id === record.categoryId)?.name,
    record.type === "expense" ? "Expense" : "Sales",
  ].filter(Boolean).join(" · ");
  const sourceLabel = (record: RecordItem) => RECORD_SOURCE_LABELS[record.source as RecordSource] ?? record.source;
  const reason = (record: RecordItem) => record.largeExpenseFlag && selected.expectedMonthlyExpenses <= 0
    ? ["Flagged as a large expense. Add a monthly expense estimate to see the threshold.", record.duplicateStatus === "Flagged" ? flagReasonText({ ...record, largeExpenseFlag: false }, selected) : ""].filter(Boolean).join(" ")
    : flagReasonText(record, selected);
  const reviewAction = (title: string, onPress: () => void, disabled: boolean, kind: "keep" | "discard" | "reviewed") => (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: kind === "discard" ? t.statusText.critical : t.brandText, backgroundColor: kind === "reviewed" ? t.brandSurface : t.surface, opacity: disabled ? 0.5 : pressed ? 0.7 : 1, ...(kind === "reviewed" ? {} : { flex: 1, minWidth: 125 }) })}>
      {kind === "reviewed" ? <Ionicons name="checkmark-circle-outline" size={20} color={t.brandText} /> : null}
      <T style={{ textAlign: "center", flexShrink: 1, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: kind === "discard" ? t.statusText.critical : t.brandText }}>{title}</T>
    </Pressable>
  );
  const renderGroup = (group: DuplicateGroup) => {
    const count = group.records.length;
    const first = group.records[0]!;
    const homogeneous = group.records.every((record) => record.type === first.type && record.amount === first.amount && record.date.slice(0, 10) === first.date.slice(0, 10) && record.description === first.description && record.categoryId === first.categoryId);
    const amount = homogeneous ? first.amount : group.records.reduce((sum, record) => sum + record.amount, 0);
    return (
      <Card key={group.key} style={{ marginBottom: space.md, gap: space.md }}>
        <View style={{ alignSelf: "flex-start" }}><AlertBadge kind="duplicate" /></View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm }}>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 120, gap: space.xs }}>
            <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>{group.batch?.title ?? (homogeneous ? first.description : "Records with a possible match")}</T>
            <T variant="caption">{group.batch ? `Imported ${group.batch.uploadDate.slice(0, 10)} · ${count} records shown` : homogeneous ? recordMeta(first) : `${count} records shown`}</T>
          </View>
          <View style={{ gap: space.xs }}>
            <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, fontVariant: ["tabular-nums"] }}>{formatMoney(amount, { decimals: true })}</T>
            {!homogeneous || count > 1 ? <T variant="caption">{homogeneous ? "per record" : "Loaded group total"}</T> : null}
          </View>
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md, gap: space.sm }}>
          <T style={{ color: t.textSecondary }}>Flagged as possible duplicates. Check the records before choosing what to keep.</T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><Ionicons name="copy-outline" size={20} color={t.textSecondary} /><T>{count} {count === 1 ? "record" : "records"} to check</T></View>
          <T variant="caption">Discard removes only these flagged records.</T>
          {nextCursor ? <T variant="caption">Actions apply to the records currently loaded in this group. Load more to check the remaining records.</T> : null}
        </View>
        <Disclosure title="Records in this group" summary={`${count} records · amounts, sources and flag reasons`}>
          {group.records.map((record) => <View key={recordKey(record)} style={{ borderTopWidth: 1, borderTopColor: t.border, paddingVertical: space.sm, gap: space.xs }}>
            <T style={{ fontFamily: font.sansMedium }}>{record.description}</T>
            <T variant="caption">{recordMeta(record)} · {sourceLabel(record)}</T>
            <T style={{ fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{formatMoney(record.amount, { decimals: true })}</T>
            <T variant="caption">{reason(record)}</T>
            {badges(record)}
          </View>)}
        </Disclosure>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {reviewAction(count === 1 ? "Keep it" : `Keep all ${count}`, () => void resolveGroup(group, "keep"), busyKey === group.key, "keep")}
          {reviewAction(count === 1 ? "Discard it" : `Discard all ${count}`, () => void resolveGroup(group, "discard"), busyKey === group.key, "discard")}
        </View>
      </Card>
    );
  };

  return (
    <Screen>
      <FlatList
        style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center" }}
        data={listItems}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
        initialNumToRender={12}
        windowSize={7}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={brand[600]}
          />
        )}
        ListHeaderComponent={(
          <>
        <View style={{ backgroundColor: t.brandSurface, borderRadius: radius.md, padding: space.lg, marginBottom: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Ionicons name="document-text-outline" size={32} color={t.brandText} />
          <View style={{ flex: 1, gap: space.xs }}>
            <T variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite">{visibleFlaggedTotal === null ? visibleLoading ? "Loading review count…" : "Review count unavailable" : `${visibleFlaggedTotal} record${visibleFlaggedTotal === 1 ? " needs" : "s need"} a check`}</T>
            <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>Review duplicates and unusually large expenses.</T>
            {visibleFlaggedTotal !== null && visibleRecords.length < visibleFlaggedTotal ? <T variant="caption">{visibleFlaggedTotal} records flagged · showing {visibleRecords.length}</T> : null}
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", marginBottom: space.lg }}><Ionicons name="information-circle-outline" size={20} color={t.textMuted} /><T variant="caption" style={{ flex: 1 }}>A flag means check the record; it may still be correct.</T></View>
        {visibleError ? <ErrorNote>{visibleError}</ErrorNote> : null}

        <ConnectionNotice
          notice={describeLoadFailure(visibleLoadFailure, {
            hasData: visibleRecords.length > 0,
            lastUpdatedAt: visibleLoadedAt,
            now: clock,
            subject: "the records to review",
          })}
          onRetry={load}
          busy={visibleLoading || refreshing}
          style={{ marginBottom: space.md }}
        />

        {visibleRecords.length > 0 ? (
          <LastUpdated at={visibleLoadedAt} now={clock} style={{ marginBottom: space.sm }} />
        ) : null}
          </>
        )}
        ListEmptyComponent={visibleLoading ? (
          <ActivityIndicator color={brand[600]} />
        ) : visibleRecords.length === 0 && visibleLoadFailure ? (
          /*
            Same reason as Notifications: "Nothing needs your attention" over a
            failed fetch is an all-clear this screen has no grounds to give.
          */
          null
        ) : visibleRecords.length === 0 ? (
          <EmptyState
            title="Nothing needs your attention"
            icon="✓"
            body="FinSight flags possible duplicates and unusually large expenses here as you record them."
          />
        ) : null}
        renderItem={({ item }) => {
          if (item.kind === "heading") {
            return (
              <T variant="heading" accessibilityRole="header" style={{ marginTop: item.spaced ? space.lg : 0, marginBottom: space.md }}>
                {item.label}
              </T>
            );
          }
          if (item.kind === "group") return renderGroup(item.group);
          const r = item.record;
          return (
            <Card style={{ marginBottom: space.md, gap: space.md }}>
              {badges(r)}
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm }}>
                <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 120, gap: space.xs }}>
                  <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>{r.description}</T>
                  <T variant="caption">{recordMeta(r)} · {sourceLabel(r)}</T>
                </View>
                <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, fontVariant: ["tabular-nums"] }}>{formatMoney(r.amount, { decimals: true })}</T>
              </View>
              <T style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md, color: t.textSecondary }}>{reason(r)}</T>
              {reviewAction(busyKey === `record-${recordKey(r)}` ? "Marking reviewed…" : "Looks right — mark reviewed", () => void resolve(r), busyKey === `record-${recordKey(r)}`, "reviewed")}
            </Card>
          );
        }}
        ListFooterComponent={visibleRecords.length > 0 ? (
          nextCursor ? (
              <Card style={{ marginTop: space.xs }}>
                {visibleMoreError ? <ErrorNote>{visibleMoreError}</ErrorNote> : null}
                <T
                  variant="caption"
                  accessibilityLiveRegion="polite"
                  style={{ textAlign: "center", color: ink[500], marginBottom: space.sm }}
                >
                  Showing {visibleRecords.length}
                  {visibleFlaggedTotal !== null ? ` of ${visibleFlaggedTotal}` : ""}
                </T>
                <Button
                  title={loadingMore ? "Loading…" : "Load more"}
                  variant="secondary"
                  loading={loadingMore}
                  disabled={loadingMore}
                  onPress={() => void loadMore()}
                />
              </Card>
            ) : (
              <T variant="caption" style={{ textAlign: "center", color: ink[500], marginTop: space.md }}>
                That's everything waiting for review.
              </T>
            )
        ) : null}
      />
      <ConfirmSheet
        visible={pendingDiscard !== null}
        title={`Discard ${discardCount} record${discardCount === 1 ? "" : "s"}?`}
        body={
          `This deletes ${discardCount === 1 ? "this copy" : `these ${discardCount} copies`} for good. The original ` +
          `record${discardCount === 1 ? "" : "s"} they duplicate ${discardCount === 1 ? "is" : "are"} not flagged and ` +
          `${discardCount === 1 ? "stays" : "stay"} exactly as ${discardCount === 1 ? "it is" : "they are"}.`
        }
        confirmLabel={`Discard ${discardCount}`}
        confirmVariant="danger"
        busy={pendingDiscard !== null && busyKey === pendingDiscard.key}
        onConfirm={() => {
          const group = pendingDiscard;
          if (!group) return;
          void runGroupAction(group, "discard").finally(() => setPendingDiscard(null));
        }}
        onCancel={() => setPendingDiscard(null)}
      />
    </Screen>
  );
}
