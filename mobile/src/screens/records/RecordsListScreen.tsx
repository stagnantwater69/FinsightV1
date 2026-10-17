import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONTENT_WIDTH } from "../../components/ContentScrollView";
import {
  AppState,
  Alert as RNAlert,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  useWindowDimensions,
  View,
  type ListRenderItem,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, EmptyState, ErrorNote, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api } from "../../lib/api";
import { ConnectionNotice, FreshnessStatus } from "../../components/ConnectionNotice";
import {
  describeActionFailure,
  describeLoadFailure,
  toLoadFailure,
  type LoadFailure,
} from "../../lib/connectionState";
import { useDebounced } from "../../lib/useDebounced";
import { takeFlash } from "../../lib/flash";
import { SkeletonList } from "../../components/Skeleton";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as haptics from "../../lib/haptics";
import { recordUpdatePath } from "../../lib/recordUpdate";
import { TAP, font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../../lib/types";
import { RecordCard } from "./RecordCard";
import { NumberedPagination } from "../../components/NumberedPagination";
import { RecordFilterSheet } from "./RecordFilterSheet";
import { TAP_FLOOR } from "../../components/touchTarget";
import { SOURCE_TILES } from "./recordSources";
import { Mascot } from "../../components/MascotState";
import { useInsight } from "../../lib/useInsight";
import { useCursorCollection } from "../../lib/useCursorCollection";
import type { ImportBatchPage } from "../../lib/types";
import type { FlaggedRecordCounts } from "../../lib/types";
import { type ImportBatchSummary } from "./shared";
import {
  createServerStateIdentity,
  fetchServerState,
  isServerStateAffected,
  peekServerState,
  subscribeToServerState,
} from "../../lib/serverStateCache";


/**
 * The record-type filter. Module scope so the array is not rebuilt on every
 * keystroke in the search box above it.
 *
 * Labels are written out rather than capitalised from the values at render
 * time: "all" reads better as "All" than as a transformed string, and the
 * value is what the API expects, so the two are allowed to differ.
 */
const RECORD_TYPES = [
  { label: "All", value: "all" },
  { label: "Expense", value: "expense" },
  { label: "Sales", value: "sales" },
] as const;

interface RecordPage {
  items: RecordItem[];
  nextCursor: string | null;
}

type RecordSearchQuery = Record<string, string | number | boolean | undefined>;

const isCompleteDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** "Today · Sat, Oct 10" / "Fri, Oct 9": the heading over each day's records. */
function dayHeading(date: string): string {
  const iso = date.slice(0, 10);
  const label = new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return iso === today ? `Today · ${label}` : label;
}

export function RecordsScreen({ navigation, route }: any) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stackedFilters = width < 360 || fontScale > 1.2;
  const { brand, ink } = t;
  const { selected, categories } = useBusinessProfiles();
  // Only the headline number for the review banner; a failure just hides it.
  const flagged = useInsight<FlaggedRecordCounts>(
    "/records/flagged/count",
    { businessProfileId: selected?.id },
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  const selectedBusinessProfileIdRef = useRef<number | null>(selected?.id ?? null);
  selectedBusinessProfileIdRef.current = selected?.id ?? null;
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const firstSnapshot = useRef<{ identity: string; data: RecordPage } | null>(null);
  const consumedCursors = useRef(new Set<string>());
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<"all" | "expense" | "sales">("all");
  // The endpoint has supported these three since before mobile had any UI for
  // them, so a phone could only ever filter by type and keyword.
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [source, setSource] = useState<RecordSource | null>(null);
  /**
   * Which CSV import to narrow to, and the list to choose from.
   *
   * Only meaningful alongside source === "CSV_UPLOAD", the same rule the web
   * filter follows — and the reason the batches are fetched only once that
   * source is chosen rather than on every visit to Records. Without this a
   * phone could see that a record came from a spreadsheet but never which one,
   * which after a 30,000-row import is most of the question.
   */
  const [importBatchId, setImportBatchId] = useState<number | null>(null);
  const [importSearch, setImportSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  /** Which whole-period shortcut is in effect, if any. */
  const [rangeLabel, setRangeLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  /**
   * A failed DELETE or RESOLVE, as a finished sentence.
   *
   * Kept separate from `loadFailure` below because the two need opposite
   * reassurances: a failed load is about the figures on screen being old, and
   * a failed action is about the record NOT having changed. Collapsing them
   * would attach one of those sentences to the other's failure.
   */
  const [error, setError] = useState<string | null>(null);
  /** A failed search, kept as a descriptor. See lib/connectionState.ts. */
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [loadFailureIdentity, setLoadFailureIdentity] = useState<string | null>(null);
  /** When the rows on screen arrived, and the clock the caption is read against. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  /**
   * The "that worked" line. Two sources feed it: an action completed here
   * (resolving a flag), and an action completed on a screen that then went
   * back to this one (see lib/flash). Both end up in the same Callout, so
   * there is one place a confirmation can appear and one rule for how long.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The search box is a raw TextInput rather than a `Field` — it has no label
   * and sits inside a card with the type switcher — so it does not inherit
   * `Field`'s focus border and has to carry its own. Same rule as `Field`:
   * colour changes, width does not, so the card below it never shifts.
   */
  const [keywordFocused, setKeywordFocused] = useState(false);
  const scrollRef = useRef<FlatList<RecordItem>>(null);
  const requestVersion = useRef(0);
  const focused = useRef(false);
  const loadedIdentityRef = useRef<string | null>(null);
  loadedIdentityRef.current = loadedIdentity;

  useEffect(() => () => {
    selectedBusinessProfileIdRef.current = null;
    requestVersion.current += 1;
  }, []);

  // Typing "groceries" used to fire nine requests, each racing the last.
  const searchTerm = useDebounced(keyword);
  const importSearchTerm = useDebounced(importSearch);
  const importQuery = { businessProfileId: selected?.id, pageSize: 50, search: importSearchTerm || undefined };
  const importFront = useInsight<ImportBatchPage | ImportBatchSummary[]>("/records/csv-imports/batches", importQuery, [selected?.id, source, importSearchTerm], { enabled: Boolean(selected) && source === "CSV_UPLOAD" });
  const importPage = useMemo(() => Array.isArray(importFront.data) ? { items: importFront.data, nextCursor: null } : importFront.data, [importFront.data]);
  const importCollection = useCursorCollection<ImportBatchSummary, string>({ data: importPage, lastUpdatedAt: importFront.lastUpdatedAt, refreshing: importFront.refreshing }, "/records/csv-imports/batches", importQuery, `${selected?.id}:${source}:${importSearchTerm}`, "cursor", (item) => String(item.id));
  const importState = importCollection.read();
  const importBatches = importState.items;
  const importError = importFront.error ?? importState.error;
  useEffect(() => { setImportSearch(""); }, [selected?.id]);

  const buildQuery = useCallback(
    (cursor?: string): RecordSearchQuery => ({
      businessProfileId: selected?.id,
      type,
      keyword: searchTerm || undefined,
      categoryId: categoryId ?? undefined,
      source: source ?? undefined,
      importBatchId: source === "CSV_UPLOAD" && importBatchId ? importBatchId : undefined,
      dateFrom: isCompleteDate(dateFrom) ? dateFrom : undefined,
      dateTo: isCompleteDate(dateTo) ? dateTo : undefined,
      limit: 100,
      cursor,
    }),
    [selected?.id, type, searchTerm, categoryId, source, importBatchId, dateFrom, dateTo],
  );

  const currentQuery = useMemo(() => buildQuery(), [buildQuery]);
  const currentIdentity = useMemo(
    () => createServerStateIdentity("/records/search", currentQuery),
    [currentQuery],
  );
  const cachedCurrent = loadedIdentity === currentIdentity
    ? null
    : peekServerState<RecordPage>("/records/search", currentQuery);
  const currentPage = loadedIdentity === currentIdentity
    ? { items: records, nextCursor }
    : cachedCurrent?.data ?? null;
  const loadedRecords = currentPage?.items ?? [];
  const loadedRecordsRef = useRef<RecordItem[]>(loadedRecords);
  loadedRecordsRef.current = loadedRecords;
  const loadedPageCount = Math.max(1, Math.ceil(loadedRecords.length / 10));
  const visiblePageIndex = Math.min(pageIndex, loadedPageCount - 1);
  const visibleRecords = loadedRecords.slice(visiblePageIndex * 10, (visiblePageIndex + 1) * 10);
  const visibleRecordsRef = useRef<RecordItem[]>(visibleRecords);
  visibleRecordsRef.current = visibleRecords;
  const visibleNextCursor = currentPage?.nextCursor ?? null;
  const visibleLoadedAt = loadedIdentity === currentIdentity ? loadedAt : cachedCurrent?.updatedAt ?? null;
  const visibleLoadFailure = loadFailureIdentity === currentIdentity ? loadFailure : null;
  const switchingQuery = !currentPage && loadedIdentity !== currentIdentity;

  const load = useCallback(
    async (isRefresh = false, cursor?: string, append = false): Promise<boolean> => {
      if (!selected) return false;
      const request = ++requestVersion.current;
      const query = buildQuery(cursor);
      const identity = createServerStateIdentity("/records/search", buildQuery());
      const cached = peekServerState<RecordPage>("/records/search", query);
      const anchor = firstSnapshot.current;
      const hasVisiblePage = loadedIdentityRef.current === identity || cached !== null;
      const applyPage = (page: RecordPage, updatedAt: number) => {
        if (append) {
          if (firstSnapshot.current !== anchor) return;
          if (!cursor || page.nextCursor === cursor || (page.nextCursor !== null && consumedCursors.current.has(page.nextCursor))) throw new Error("More records could not be loaded. Refresh your records and try again.");
          consumedCursors.current.add(cursor);
          setRecords((previous) => {
            const seen = new Set(previous.map((item) => `${item.type}:${item.id}`));
            return [...previous, ...page.items.filter((item) => {
              const key = `${item.type}:${item.id}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })];
          });
          setNextCursor(page.nextCursor);
        } else if (isRefresh || firstSnapshot.current?.identity !== identity || firstSnapshot.current.data !== page) {
          const seen = new Set<string>();
          const items = page.items.filter((item) => {
            const key = `${item.type}:${item.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          const changedQuery = firstSnapshot.current?.identity !== identity;
          firstSnapshot.current = { identity, data: page };
          consumedCursors.current = new Set();
          setRecords(items);
          setNextCursor(page.nextCursor);
          setPageIndex((current) => changedQuery ? 0 : Math.min(current, Math.max(0, Math.ceil(items.length / 10) - 1)));
        }
        setLoadedIdentity(identity);
        setLoadedAt(updatedAt);
        setLoadFailure(null);
        setLoadFailureIdentity(null);
      };
      setError(null);
      setClock(Date.now());
      if (isRefresh) setRefreshing(true);
      else if (append) setLoadingMore(true);
      else if (hasVisiblePage) setRevalidating(true);
      else setLoading(true);
      try {
        if (!append && cached && (!isRefresh || loadedIdentityRef.current !== identity)) applyPage(cached.data, cached.updatedAt);
        if (!isRefresh && !append && cached && !cached.stale) {
          if (request !== requestVersion.current) return false;
          return true;
        }
        const result = await fetchServerState<RecordPage>({
          path: "/records/search", query,
          fetcher: () => api.get<RecordPage>("/records/search", query), force: isRefresh || append,
        });
        if (request !== requestVersion.current || (append && firstSnapshot.current !== anchor)) return false;
        applyPage(result.data, result.updatedAt);
        return true;
      } catch (err) {
        if (request !== requestVersion.current) return false;
        if (append) setError(describeActionFailure(toLoadFailure(err), "Your loaded records are unchanged. Try Load more records again.", "read"));
        else { setLoadFailure(toLoadFailure(err)); setLoadFailureIdentity(identity); }
        return false;
      } finally {
        if (request === requestVersion.current) {
          setLoading(false); setRefreshing(false); setRevalidating(false); setLoadingMore(false);
        }
      }
    },
    [selected, buildQuery],
  );

  useEffect(() => {
    setPageIndex((current) => Math.min(current, loadedPageCount - 1));
  }, [loadedPageCount]);

  const activeFilters =
    (categoryId !== null ? 1 : 0) +
    (source !== null ? 1 : 0) +
    (importBatchId !== null ? 1 : 0) +
    (isCompleteDate(dateFrom) ? 1 : 0) +
    (isCompleteDate(dateTo) ? 1 : 0);

  /** The filters that are on, as removable chips. A date range is one chip, however many ends it has. */
  const filterChips: { key: string; label: string; remove: () => void }[] = [];
  const chosenCategory = categories.find((c) => c.id === categoryId);
  if (chosenCategory) filterChips.push({ key: "category", label: chosenCategory.name, remove: () => setCategoryId(null) });
  if (source) {
    filterChips.push({
      key: "source",
      label: SOURCE_TILES.find((tile) => tile.value === source)?.label ?? RECORD_SOURCE_LABELS[source],
      remove: () => {
        setSource(null);
        setImportBatchId(null);
      },
    });
  }
  const chosenBatch = importBatches.find((b) => b.id === importBatchId);
  if (importBatchId !== null) {
    filterChips.push({ key: "batch", label: chosenBatch?.title ?? "One import", remove: () => setImportBatchId(null) });
  }
  if (isCompleteDate(dateFrom) || isCompleteDate(dateTo)) {
    filterChips.push({
      key: "dates",
      label: rangeLabel ?? `${isCompleteDate(dateFrom) ? dateFrom : "…"} – ${isCompleteDate(dateTo) ? dateTo : "…"}`,
      remove: () => {
        setDateFrom("");
        setDateTo("");
        setRangeLabel(null);
      },
    });
  }

  function clearFilters() {
    setCategoryId(null);
    setSource(null);
    // Cleared with the rest. Left behind it would keep scoping the list to one
    // import while the sheet says no filters are active — and its own control
    // is hidden the moment the source goes, so there would be nothing on screen
    // to turn it off with.
    setImportBatchId(null);
    setDateFrom("");
    setDateTo("");
    setRangeLabel(null);
  }

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
        requestVersion.current += 1;
      };
    }, [load]),
  );

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (nextState) => {
      const returningToForeground =
        /inactive|background/.test(previousState) && nextState === "active";
      previousState = nextState;
      if (!returningToForeground || !focused.current) return;

      const cached = peekServerState<RecordPage>("/records/search", currentQuery);
      if (!cached || cached.stale) void load();
    });
    return () => subscription.remove();
  }, [currentQuery, load]);

  useEffect(
    () =>
      subscribeToServerState((event) => {
        if (event.type === "clear") {
          requestVersion.current += 1;
          setRecords([]);
          setNextCursor(null);
          setPageIndex(0);
          firstSnapshot.current = null;
          consumedCursors.current = new Set();
          setLoadedIdentity(null);
          setLoadedAt(null);
          setLoadFailure(null);
          setLoadFailureIdentity(null);
          setLoading(true);
          return;
        }
        if (
          focused.current &&
          isServerStateAffected("/records/search", currentQuery, event)
        ) {
          void load();
        }
      }),
    [currentQuery, load],
  );

  /*
   * A filter handed in by another screen — today, "show me this category's
   * records" from the categories list, which is what web's "View records"
   * link does with a query string.
   *
   * Consumed ONCE and then cleared. React Navigation keeps params on the route
   * until something replaces them, so without the clear this screen would
   * silently re-apply the category filter every time the owner came back to
   * it, including after they had deliberately cleared it — a list quietly
   * hiding records with no visible cause.
   *
   * The filter panel is opened along with it, because a filtered list that
   * looks exactly like an unfiltered one is how an owner concludes their
   * records have gone missing.
   */
  useFocusEffect(
    useCallback(() => {
      const incomingBatch = route?.params?.importBatchId;
      if (Number.isSafeInteger(incomingBatch) && incomingBatch > 0) {
        setSource("CSV_UPLOAD");
        setImportBatchId(incomingBatch);
        setShowFilters(true);
        navigation.setParams?.({ importBatchId: undefined });
        navigation.getParent?.()?.setParams?.({ screen: undefined, params: undefined });
      }
      const incoming = route?.params?.categoryId;
      if (incoming === undefined) return;
      setCategoryId(incoming);
      if (route?.params?.type) setType(route.params.type);
      setShowFilters(true);
      navigation.setParams({ categoryId: undefined, type: undefined });
      /*
       * The TAB's params too, not just this screen's — they are different
       * routes and only this one has been consumed.
       *
       * Insights reaches this filter with
       * `navigate("Records", { screen: "RecordsList", params: { categoryId } })`,
       * which is the only form that crosses tabs, and that directive sticks
       * to the Records TAB route. bottom-tabs replays a tab's stored params
       * on every later press of it, so without this the owner's next tap on
       * Records — days later, from another tab — silently re-applies a
       * category filter they set once from a chart.
       */
      navigation.getParent()?.setParams({ screen: undefined, params: undefined });
    }, [route?.params?.categoryId, route?.params?.type, route?.params?.importBatchId, navigation]),
  );

  // Collected on focus rather than from a route param because the screens that
  // leave one all return here via goBack(), which carries nothing. Dropping the
  // notice on blur means a confirmation never outlives the visit it belongs to.
  useFocusEffect(
    useCallback(() => {
      const handed = takeFlash();
      if (handed) setNotice(handed);
      return () => setNotice(null);
    }, []),
  );

  // The timer hangs off the notice itself, so it is cancelled by the same
  // clearing that blur and unmount already do — it cannot fire into a screen
  // that has gone away.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Deleting from a swipe still asks first.
   *
   * The gesture only reveals the button; this is the second gate. A record is
   * evidence for figures on every other screen, and a mis-swipe while
   * scrolling must not be able to destroy one.
   */
  const confirmDelete = useCallback((record: RecordItem) => {
    RNAlert.alert(
      "Delete this record?",
      `"${record.description}" will be removed. This cannot be undone.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (selectedBusinessProfileIdRef.current !== record.businessProfileId) return;
            // Optimistic: the row leaves immediately and comes back if the
            // server refuses, rather than the owner watching a spinner over a
            // row they have already decided about.
            const previous = loadedRecordsRef.current;
            setRecords((rows) => rows.filter((x) => !(x.type === record.type && x.id === record.id)));
            try {
              await api.delete(
                recordUpdatePath(record.type, record.id),
                undefined,
                { cacheScope: { businessProfileId: record.businessProfileId } },
              );
              haptics.committed();
            } catch (err) {
              if (selectedBusinessProfileIdRef.current !== record.businessProfileId) return;
              setRecords((rows) => {
                if (rows.some((item) => item.type === record.type && item.id === record.id)) return rows;
                const restored = [...rows];
                const position = previous.findIndex((item) => item.type === record.type && item.id === record.id);
                restored.splice(Math.max(0, Math.min(position, restored.length)), 0, record);
                return restored;
              });
              setError(describeActionFailure(toLoadFailure(err), "The record is still in your books."));
              haptics.failed();
            }
          },
        },
      ],
    );
  }, []);

  /** Clears a flag from the list, without a trip to the review screen. */
  const resolve = useCallback(async (record: RecordItem) => {
    if (selectedBusinessProfileIdRef.current !== record.businessProfileId) return;
    const previous = loadedRecordsRef.current.find((item) => item.type === record.type && item.id === record.id) ?? record;
    setRecords((rows) =>
      rows.map((x) =>
        x.type === record.type && x.id === record.id
          ? { ...x, reviewStatus: "Reviewed" as const, duplicateStatus: "Not a Duplicate" as const }
          : x,
      ),
    );
    try {
      await api.patch(recordUpdatePath(record.type, record.id), {
        duplicateStatus: "Not a Duplicate",
        reviewStatus: "Reviewed",
      }, { cacheScope: { businessProfileId: record.businessProfileId } });
      if (selectedBusinessProfileIdRef.current !== record.businessProfileId) return;
      haptics.succeeded();
      // This one stays on the list, so it needs no hand-off — the same Callout,
      // set directly.
      setNotice("Marked reviewed and not a duplicate.");
    } catch (err) {
      if (selectedBusinessProfileIdRef.current !== record.businessProfileId) return;
      setRecords((rows) => rows.map((item) => item.type === record.type && item.id === record.id ? previous : item));
      setError(describeActionFailure(toLoadFailure(err), "The record's flags are unchanged."));
      haptics.failed();
    }
  }, []);

  const categoryNames = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const renderRecord = useCallback<ListRenderItem<RecordItem>>(
    ({ item, index }) => (
      <>
      {index === 0 || visibleRecordsRef.current[index - 1]?.date.slice(0, 10) !== item.date.slice(0, 10) ? (
        <T
          accessibilityRole="header"
          style={{
            marginTop: index === 0 ? 0 : space.md,
            marginBottom: space.sm,
            fontSize: typeScale.caption,
            fontFamily: font.sansSemibold,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {dayHeading(item.date)}
        </T>
      ) : null}
      <RecordCard
        r={item}
        categoryName={categoryNames.get(item.categoryId ?? -1) ?? "—"}
        onPress={() => navigation.navigate("EditRecord", { record: item })}
        onDelete={() => confirmDelete(item)}
        onResolve={() => resolve(item)}
      />
      </>
    ),
    [categoryNames, confirmDelete, navigation, resolve, t],
  );

  if (!selected) {
    return (
      <Screen>
        <View style={{ padding: space.lg }}>
          <EmptyState title="Set up a business first" body="Records belong to a business profile." />
        </View>
      </Screen>
    );
  }

  /*
   * `hasData` is `records.length > 0`, NOT "a load has succeeded before".
   *
   * The two differ on a filter that legitimately matches nothing and then
   * fails to refresh, and the row count is the honest one: there is nothing on
   * screen to describe as stale, so the notice must be the one that explains a
   * blank list rather than the one that ages the figures on it.
   */
  const loadNotice = describeLoadFailure(visibleLoadFailure, {
    hasData: visibleRecords.length > 0,
    lastUpdatedAt: visibleLoadedAt,
    now: clock,
    subject: "your records",
  });

  function changePage(targetPage: number) {
    setPageIndex(Math.max(0, Math.min(targetPage, loadedPageCount - 1)));
    scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  return (
    <Screen safeTop>
      <FlatList<RecordItem>
        style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center" }}
        ref={scrollRef}
        data={visibleRecords}
        renderItem={renderRecord}
        keyExtractor={(item) => `${item.type}-${item.id}`}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: space.lg, paddingTop: space.md, paddingBottom: space.xxl * 2 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={brand[600]}
          />
        }
        ListHeaderComponent={
          <>
        <T accessibilityRole="header" variant="title" numberOfLines={2} style={{ fontFamily: font.display, fontSize: typeScale.titleLg, marginBottom: space.lg }}>
          Records
        </T>

        {flagged.data && flagged.data.total > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${flagged.data.total} ${flagged.data.total === 1 ? "record needs" : "records need"} a quick check. Review`}
            onPress={() => navigation.navigate("FlaggedRecords", { from: undefined })}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              marginBottom: space.md,
              paddingVertical: space.sm,
              paddingRight: space.md,
              paddingLeft: space.sm,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: t.accent[100],
              backgroundColor: pressed ? t.accent[100] : t.ACCENT.surface,
            })}
          >
            <Mascot state="possibleDuplicate" size={52} />
            <View style={{ flex: 1 }}>
              <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.textPrimary }}>
                {`${flagged.data.total} ${flagged.data.total === 1 ? "record needs" : "records need"} a quick check`}
              </T>
              <T variant="caption">{`${flagged.data.expenses} expenses · ${flagged.data.sales} sales`}</T>
            </View>
            <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>Review ›</T>
          </Pressable>
        ) : null}

        {notice ? (
          <View style={{ marginBottom: space.md }}>
            <Callout tone="info">{notice}</Callout>
          </View>
        ) : null}

        <View style={{ marginBottom: space.md, gap: space.sm }}>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                minHeight: TAP + 4,
                borderWidth: 1,
                borderColor: keywordFocused ? brand[600] : t.border,
                borderRadius: radius.lg,
                paddingHorizontal: space.md,
                backgroundColor: t.surface,
              }}
            >
              <Ionicons name="search" size={18} color={ink[400]} />
              <TextInput
                value={keyword}
                onChangeText={setKeyword}
                placeholder="Search records"
                placeholderTextColor={ink[400]}
                accessibilityLabel="Search descriptions"
                // The list filters as you type, so there is nothing for the return
                // key to submit — "search" just closes the keyboard over the
                // results the box has already produced.
                returnKeyType="search"
                onFocus={() => setKeywordFocused(true)}
                onBlur={() => setKeywordFocused(false)}
                style={{ flex: 1, minHeight: TAP_FLOOR, fontFamily: font.sans, fontSize: typeScale.body, color: ink[900] }}
              />
              {/* Clearing a search should not mean fourteen taps on backspace. */}
              {keyword ? (
                <Pressable
                  onPress={() => setKeyword("")}
                  accessibilityRole="button"
                  accessibilityLabel="Clear the search"
                  hitSlop={8}
                  style={{ padding: 2 }}
                >
                  <Ionicons name="close-circle-outline" size={18} color={ink[300]} />
                </Pressable>
              ) : null}
            </View>
            {/*
              The filters live in a sheet behind this button rather than in a
              panel above the list: sixteen category chips opened inline used
              to fill the screen before a single record showed. Solid with a
              count while any filter is on, so a filtered list never passes
              for the whole one.
            */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={filterChips.length > 0 ? `Filters, ${filterChips.length} on` : "Filters"}
              onPress={() => setShowFilters(true)}
              style={({ pressed }) => ({
                width: TAP + 4,
                minHeight: TAP + 4,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.lg,
                borderWidth: filterChips.length > 0 ? 0 : 1,
                borderColor: t.border,
                backgroundColor: filterChips.length > 0 ? t.brandFill : pressed ? t.surfaceMuted : t.surface,
              })}
            >
              <Ionicons name="options-outline" size={20} color={filterChips.length > 0 ? t.onBrandFill : brand[700]} />
              {filterChips.length > 0 ? (
                <View style={{ position: "absolute", top: -6, right: -6, minWidth: 22, height: 22, paddingHorizontal: 5, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: t.brandHeading, borderWidth: 2, borderColor: t.surfaceSunken }}>
                  {/* An explicit line box: the inherited 22pt one is taller than this badge, and Android clips to it. */}
                  <T style={{ fontSize: typeScale.micro, lineHeight: 14, fontFamily: font.sansSemibold, color: t.onBrandFill, includeFontPadding: false, textAlignVertical: "center" }}>{filterChips.length}</T>
                </View>
              ) : null}
            </Pressable>
          </View>

          <View style={{ flexDirection: stackedFilters ? "column" : "row", alignItems: stackedFilters ? "stretch" : "center", gap: space.sm }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
              {RECORD_TYPES.map((option) => {
                const checked = type === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ checked }}
                    onPress={() => setType(option.value)}
                    style={({ pressed }) => ({
                      minHeight: TAP_FLOOR,
                      justifyContent: "center",
                      paddingHorizontal: space.md,
                      borderRadius: radius.full,
                      borderWidth: checked ? 0 : 1,
                      borderColor: t.border,
                      backgroundColor: checked ? t.brandSolid : pressed ? t.surfaceMuted : t.surface,
                    })}
                    hitSlop={4}
                  >
                    <T style={{ fontSize: typeScale.label, fontFamily: checked ? font.sansSemibold : font.sansMedium, color: checked ? t.onBrandSolid : t.textSecondary }}>{option.label}</T>
                  </Pressable>
                );
              })}
            </View>
            {/*
              How many records the current filters actually leave — the useful
              number is what came back, not how many filters are on.
            */}
            <T variant="caption" style={{ marginLeft: stackedFilters ? 0 : "auto", alignSelf: stackedFilters ? "flex-end" : undefined, flexShrink: 1 }}>
              {loading || switchingQuery
                ? ""
                : `${visiblePageIndex > 0 ? `Page ${visiblePageIndex + 1} · ` : ""}${visibleRecords.length} record${visibleRecords.length === 1 ? "" : "s"}`}
            </T>
          </View>

          {/* What is filtered, each one removable, only while something is. */}
          {filterChips.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
              {filterChips.map((chip) => (
                <Pressable
                  key={chip.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove filter: ${chip.label}`}
                  onPress={chip.remove}
                  hitSlop={4}
                  style={({ pressed }) => ({
                    minHeight: 34,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingLeft: space.md,
                    paddingRight: space.sm,
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: t.brandBorder,
                    backgroundColor: pressed ? t.brandBorder : t.brandSurface,
                  })}
                >
                  <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>{chip.label}</T>
                  <Ionicons name="close" size={14} color={t.brandText} />
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear all filters"
                onPress={clearFilters}
                hitSlop={4}
                style={{ minHeight: 34, justifyContent: "center", paddingHorizontal: space.xs }}
              >
                <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.textSecondary }}>Clear all</T>
              </Pressable>
            </View>
          ) : null}
        </View>

        <RecordFilterSheet
          visible={showFilters}
          onClose={() => setShowFilters(false)}
          values={{ categoryId, source, importBatchId, dateFrom, dateTo, rangeLabel }}
          categories={categories}
          importBatches={importBatches}
          importSearch={importSearch}
          onImportSearch={setImportSearch}
          importLoading={importFront.loading || importState.loading}
          importError={importError}
          hasMoreImports={Boolean(importState.cursor)}
          onMoreImports={() => void importCollection.loadNext()}
          onRetryImports={() => { if (importState.error && importState.cursor) void importCollection.loadNext(); else void importFront.load(); }}
          onCategory={setCategoryId}
          onSource={(next) => {
            setSource(next);
            // Cleared with the source it belongs to — a batch left selected
            // under "Any" would scope the list by a filter no longer on screen.
            if (next !== "CSV_UPLOAD") setImportBatchId(null);
          }}
          onImportBatch={setImportBatchId}
          onDates={(from, to, label) => {
            setDateFrom(from);
            setDateTo(to);
            setRangeLabel(label);
          }}
          onClear={clearFilters}
          activeCount={activeFilters}
        />

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <ConnectionNotice
          notice={loadNotice}
          onRetry={() => load(true)}
          busy={refreshing || revalidating}
          style={{ marginBottom: space.md }}
        />

        {/* The list is laid out by each card's own margin rather than a gap on
            the container, so this carries its own. */}
        {visibleRecords.length > 0 ? (
          <FreshnessStatus
            at={visibleLoadedAt}
            now={clock}
            refreshing={refreshing || revalidating}
            style={{ marginBottom: space.sm }}
          />
        ) : null}
          </>
        }
        ListEmptyComponent={
          loading || switchingQuery ? (
          <SkeletonList />
        ) : visibleLoadFailure ? (
          /*
            THE BUG THIS BRANCH FIXES. A search that failed left `records`
            empty, which fell through to the empty state below — so an owner
            whose wifi dropped was told "You haven't added any records yet"
            about books that were fine. Being told your records are gone is not
            a cosmetic error; it is the sentence that makes someone re-enter a
            month of expenses. The notice above already says what happened and
            offers the retry, so this branch draws nothing more.
          */
          null
        ) : (
          <EmptyState
            title={keyword ? "No records match that search" : "You haven't added any records yet"}
            body={
              keyword
                ? "Try a different word, or clear the search box."
                : "Start with what you spent today — even one entry is enough for FinSight to begin showing you something."
            }
            action={!keyword ? <Button title="Add your first expense" variant="primary" onPress={() => navigation.navigate("AddExpense")} /> : undefined}
          />
        )
        }
        ListFooterComponent={
          visibleRecords.length > 0 ? (
              <Card style={{ marginTop: space.xs, paddingHorizontal: 0 }}>
                <T
                  variant="caption"
                  accessibilityLiveRegion="polite"
                  style={{ textAlign: "center", color: ink[500], marginBottom: space.sm }}
                >
                  Page {visiblePageIndex + 1} of {loadedPageCount} · {loadedRecords.length} records loaded
                </T>
                <NumberedPagination page={visiblePageIndex} totalPages={loadedPageCount} reachablePages={loadedPageCount} busy={loadingMore || refreshing || revalidating} available={!switchingQuery} hasNext={visiblePageIndex + 1 < loadedPageCount} onPage={changePage} onNext={() => changePage(visiblePageIndex + 1)} />
                {visibleNextCursor ? <Button title="Load more records" accessibilityLabel="Load more records" variant="secondary" loading={loadingMore} disabled={loadingMore || refreshing || revalidating || switchingQuery} onPress={() => void load(false, visibleNextCursor, true)} style={{ marginTop: space.md }} /> : null}
              </Card>
          ) : null
        }
      />

    </Screen>
  );
}
