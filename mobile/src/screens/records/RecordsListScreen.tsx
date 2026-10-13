import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Alert as RNAlert,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  View,
  type ListRenderItem,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, EmptyState, ErrorNote, Screen, ScreenHeader, SegmentedControl, SelectChip, T } from "../../components/ui";
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
import { DateField, DateRangeChips } from "../../components/DateField";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../../lib/haptics";
import { recordUpdatePath } from "../../lib/recordUpdate";
import { TAP, font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../../lib/types";
import { RecordCard } from "./RecordCard";
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

export function RecordsScreen({ navigation, route }: any) {
  const t = useTheme();
  const { brand, ink } = t;
  const { selected, categories } = useBusinessProfiles();
  const selectedBusinessProfileIdRef = useRef<number | null>(selected?.id ?? null);
  selectedBusinessProfileIdRef.current = selected?.id ?? null;
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // The search endpoint is cursor-based, so keep the cursor that opened each
  // visited page. This gives mobile predictable Previous / Next navigation
  // without inventing a total page count the API does not return.
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [loadingMore, setLoadingMore] = useState(false);
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
  const [importBatches, setImportBatches] = useState<ImportBatchSummary[]>([]);
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
  }, []);

  // Typing "groceries" used to fire nine requests, each racing the last.
  const searchTerm = useDebounced(keyword);

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
      limit: 50,
      cursor,
    }),
    [selected?.id, type, searchTerm, categoryId, source, importBatchId, dateFrom, dateTo],
  );

  const currentCursor = pageCursors[pageIndex];
  const currentQuery = useMemo(() => buildQuery(currentCursor), [buildQuery, currentCursor]);
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
  const visibleRecords = currentPage?.items ?? [];
  const visibleRecordsRef = useRef<RecordItem[]>(visibleRecords);
  visibleRecordsRef.current = visibleRecords;
  const visibleNextCursor = currentPage?.nextCursor ?? null;
  const visibleLoadedAt = loadedIdentity === currentIdentity ? loadedAt : cachedCurrent?.updatedAt ?? null;
  const visibleLoadFailure = loadFailureIdentity === currentIdentity ? loadFailure : null;
  const switchingQuery = !currentPage && loadedIdentity !== currentIdentity;

  const load = useCallback(
    async (isRefresh = false, cursor?: string, targetPage = 0, isPagination = false): Promise<boolean> => {
      if (!selected) return false;

      const query = buildQuery(cursor);
      const identity = createServerStateIdentity("/records/search", query);
      const cached = peekServerState<RecordPage>("/records/search", query);
      const request = ++requestVersion.current;
      const hasVisiblePage = loadedIdentityRef.current === identity || cached !== null;

      const applyPage = (page: RecordPage, updatedAt: number) => {
        setRecords(page.items);
        setNextCursor(page.nextCursor);
        setPageIndex(targetPage);
        setPageCursors((current) => {
          if (targetPage === 0) return [undefined];
          const visited = current.slice(0, targetPage + 1);
          visited[targetPage] = cursor;
          return visited;
        });
        setLoadedIdentity(identity);
        setLoadedAt(updatedAt);
        setLoadFailure(null);
        setLoadFailureIdentity(null);
      };

      if (cached) applyPage(cached.data, cached.updatedAt);
      setError(null);
      setClock(Date.now());

      if (!isRefresh && cached && !cached.stale) {
        setLoading(false);
        setRefreshing(false);
        setRevalidating(false);
        setLoadingMore(false);
        return true;
      }

      if (isRefresh) {
        setRefreshing(true);
      } else if (isPagination) {
        setLoadingMore(true);
      } else if (hasVisiblePage) {
        setRevalidating(true);
      } else {
        setLoading(true);
      }

      try {
        const result = await fetchServerState<RecordPage>({
          path: "/records/search",
          query,
          fetcher: () => api.get<RecordPage>("/records/search", query),
          force: isRefresh,
        });
        if (request !== requestVersion.current) return false;
        applyPage(result.data, result.updatedAt);
        return true;
      } catch (err) {
        if (request !== requestVersion.current) return false;
        setLoadFailure(toLoadFailure(err));
        setLoadFailureIdentity(identity);
        return false;
      } finally {
        if (request === requestVersion.current) {
          setLoading(false);
          setRefreshing(false);
          setRevalidating(false);
          setLoadingMore(false);
        }
      }
    },
    [selected, buildQuery],
  );

  /*
   * Fetched only while CSV Upload is actually the chosen source.
   *
   * Loading every import on every visit to Records would be wasted work on the
   * common case of never opening this filter at all — and on a phone that is a
   * request an owner pays for. A failure is swallowed: the picker simply says
   * there are none, which is a smaller problem than an error banner over a
   * records list that loaded perfectly well.
   */
  useEffect(() => {
    if (!selected || source !== "CSV_UPLOAD") {
      setImportBatches([]);
      return;
    }
    let active = true;
    api
      .get<ImportBatchSummary[]>("/records/csv-imports/batches", { businessProfileId: selected.id })
      .then((list) => {
        if (active) setImportBatches(list);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // Keyed by the id alone: the profile object is replaced on every refresh,
    // and depending on it would refetch the same list for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, source]);

  const activeFilters =
    (categoryId !== null ? 1 : 0) +
    (source !== null ? 1 : 0) +
    (importBatchId !== null ? 1 : 0) +
    (isCompleteDate(dateFrom) ? 1 : 0) +
    (isCompleteDate(dateTo) ? 1 : 0);

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
      if (!cached || cached.stale) void load(false, currentCursor, pageIndex);
    });
    return () => subscription.remove();
  }, [currentCursor, currentQuery, load, pageIndex]);

  useEffect(
    () =>
      subscribeToServerState((event) => {
        if (event.type === "clear") {
          requestVersion.current += 1;
          setRecords([]);
          setNextCursor(null);
          setPageIndex(0);
          setPageCursors([undefined]);
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
          void load(false, currentCursor, pageIndex);
        }
      }),
    [currentCursor, currentQuery, load, pageIndex],
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
    }, [route?.params?.categoryId, route?.params?.type, navigation]),
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
            const previous = visibleRecordsRef.current;
            setRecords((rows) => rows.filter((x) => !(x.type === record.type && x.id === record.id)));
            try {
              await api.delete(
                recordUpdatePath(record.type, record.id),
                undefined,
                { cacheScope: { businessProfileId: record.businessProfileId } },
              );
              haptics.committed();
            } catch (err) {
              setRecords(previous);
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
    const previous = visibleRecordsRef.current;
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
      haptics.succeeded();
      // This one stays on the list, so it needs no hand-off — the same Callout,
      // set directly.
      setNotice("Marked reviewed and not a duplicate.");
    } catch (err) {
      setRecords(previous);
      setError(describeActionFailure(toLoadFailure(err), "The record's flags are unchanged."));
      haptics.failed();
    }
  }, []);

  const categoryNames = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const renderRecord = useCallback<ListRenderItem<RecordItem>>(
    ({ item }) => (
      <RecordCard
        r={item}
        categoryName={categoryNames.get(item.categoryId ?? -1) ?? "—"}
        onPress={() => navigation.navigate("EditRecord", { record: item })}
        onDelete={() => confirmDelete(item)}
        onResolve={() => resolve(item)}
      />
    ),
    [categoryNames, confirmDelete, navigation, resolve],
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

  async function changePage(targetPage: number, cursor?: string) {
    const loaded = await load(false, cursor, targetPage, true);
    if (loaded) scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  return (
    <Screen safeTop>
      <FlatList<RecordItem>
        ref={scrollRef}
        data={visibleRecords}
        renderItem={renderRecord}
        keyExtractor={(item) => `${item.type}-${item.id}`}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingTop: space.md, paddingBottom: space.xxl * 2 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true, currentCursor, pageIndex)}
            tintColor={brand[600]}
          />
        }
        ListHeaderComponent={
          <>
        <ScreenHeader title="Records" />

        {notice ? (
          <View style={{ marginBottom: space.md }}>
            <Callout tone="info">{notice}</Callout>
          </View>
        ) : null}

        <Card style={{ marginBottom: space.md }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              minHeight: TAP,
              borderWidth: 1,
              borderColor: keywordFocused ? brand[600] : ink[200],
              borderRadius: radius.md,
              paddingHorizontal: space.md,
            }}
          >
            <Ionicons name="search" size={17} color={ink[400]} />
            <TextInput
              value={keyword}
              onChangeText={setKeyword}
              placeholder="Search descriptions…"
              placeholderTextColor={ink[400]}
              // The list filters as you type, so there is nothing for the return
              // key to submit — "search" just closes the keyboard over the
              // results the box has already produced.
              returnKeyType="search"
              onFocus={() => setKeywordFocused(true)}
              onBlur={() => setKeywordFocused(false)}
              style={{ flex: 1, minHeight: TAP, fontSize: typeScale.body, color: ink[900] }}
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
                <Ionicons name="close-circle" size={17} color={ink[300]} />
              </Pressable>
            ) : null}
          </View>
          <View style={{ marginTop: space.sm }}>
            <SegmentedControl
              options={RECORD_TYPES}
              value={type}
              onChange={setType}
              accessibilityLabel="Record type"
            />
          </View>

          {/*
            Kept behind a toggle. Four more controls open by default would
            bury the list they filter on a phone screen; the count keeps an
            active filter from being invisible while collapsed.
          */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Pressable
              onPress={() => setShowFilters((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showFilters }}
              accessibilityLabel={showFilters ? "Hide filters" : "More filters"}
              hitSlop={6}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: space.sm }}
            >
              <Ionicons name="options-outline" size={16} color={brand[700]} />
              <T style={{ fontSize: typeScale.label, color: brand[700], fontFamily: font.sansMedium }}>
                {showFilters ? "Hide filters" : "More filters"}
              </T>
            </Pressable>
            {/*
              How many records the current filters actually leave, on the same
              line as the control that changes them. It used to say only how
              many filters were ON, which answers a question nobody asks — the
              useful number is what came back.
            */}
            <T variant="caption" style={{ color: activeFilters > 0 ? brand[700] : ink[500] }}>
              {activeFilters > 0
                ? `${activeFilters} active`
                  : loading || switchingQuery
                    ? ""
                    : `Page ${pageIndex + 1} · ${visibleRecords.length} record${visibleRecords.length === 1 ? "" : "s"}`}
            </T>
          </View>

          {showFilters ? (
            <View style={{ gap: space.sm }}>
              <View>
                <T variant="caption" style={{ marginBottom: 4 }}>Category</T>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                  {/*
                    "Any" is a real chip in the row, not a special case: the
                    cleared state is a value the owner can pick, so it looks
                    and behaves like every other value here.
                  */}
                  <SelectChip label="Any" selected={categoryId === null} onPress={() => setCategoryId(null)} />
                  {categories.map((c) => (
                    <SelectChip
                      key={c.id}
                      label={c.name}
                      selected={categoryId === c.id}
                      // Tapping the chip that is already on turns it off again,
                      // which is the same thing as choosing "Any".
                      onPress={() => setCategoryId(categoryId === c.id ? null : c.id)}
                    />
                  ))}
                </View>
              </View>

              <View>
                <T variant="caption" style={{ marginBottom: 4 }}>How it was added</T>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                  <SelectChip label="Any" selected={source === null} onPress={() => setSource(null)} />
                  {(Object.keys(RECORD_SOURCE_LABELS) as RecordSource[]).map((s) => (
                    <SelectChip
                      key={s}
                      label={RECORD_SOURCE_LABELS[s]}
                      selected={source === s}
                      onPress={() => {
                        const next = source === s ? null : s;
                        setSource(next);
                        // Cleared with the source it belongs to — a batch left
                        // selected under "Any" would scope the list by a filter
                        // no longer on screen.
                        if (next !== "CSV_UPLOAD") setImportBatchId(null);
                      }}
                    />
                  ))}
                </View>
              </View>

              {/*
                Only once CSV Upload is the chosen source. "Which import" is
                meaningless for a typed record, and a control that is usually
                empty is worse than one that appears when it has something to
                say — the same progressive disclosure the web filter uses.
              */}
              {source === "CSV_UPLOAD" ? (
                <View>
                  <T variant="caption" style={{ marginBottom: 4 }}>Which import</T>
                  {importBatches.length === 0 ? (
                    <T variant="caption" style={{ color: ink[400] }}>
                      No CSV imports for this business yet.
                    </T>
                  ) : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                      <SelectChip
                        label="All imports"
                        selected={importBatchId === null}
                        onPress={() => setImportBatchId(null)}
                      />
                      {importBatches.map((b) => (
                        <SelectChip
                          key={b.id}
                          label={b.title}
                          selected={importBatchId === b.id}
                          onPress={() => setImportBatchId(importBatchId === b.id ? null : b.id)}
                        />
                      ))}
                    </View>
                  )}
                </View>
              ) : null}

              <View>
                <T variant="caption" style={{ marginBottom: 4 }}>When</T>
                {/*
                  Most filtering is "this week" or "this month" rather than two
                  specific dates, so those cost one tap and the pickers below
                  are only needed for a genuinely custom range.
                */}
                <DateRangeChips
                  activeLabel={rangeLabel}
                  onPick={(from, to, label) => {
                    setDateFrom(from);
                    setDateTo(to);
                    setRangeLabel(label);
                  }}
                />
              </View>

              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <DateField
                    label="From"
                    value={dateFrom}
                    optional
                    onChange={(v) => {
                      setDateFrom(v);
                      setRangeLabel(null);
                    }}
                    onClear={() => {
                      setDateFrom("");
                      setRangeLabel(null);
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <DateField
                    label="To"
                    value={dateTo}
                    optional
                    onChange={(v) => {
                      setDateTo(v);
                      setRangeLabel(null);
                    }}
                    onClear={() => {
                      setDateTo("");
                      setRangeLabel(null);
                    }}
                  />
                </View>
              </View>

              {activeFilters > 0 ? (
                <Button title="Clear filters" variant="ghost" onPress={clearFilters} />
              ) : null}
            </View>
          ) : null}
        </Card>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <ConnectionNotice
          notice={loadNotice}
          onRetry={() => load(true, currentCursor, pageIndex)}
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
          visibleRecords.length > 0 && (pageIndex > 0 || visibleNextCursor) ? (
              <Card style={{ marginTop: space.xs }}>
                <T
                  variant="caption"
                  accessibilityLiveRegion="polite"
                  style={{ textAlign: "center", color: ink[500], marginBottom: space.sm }}
                >
                  Page {pageIndex + 1}
                </T>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Previous"
                      variant="secondary"
                      disabled={pageIndex === 0 || loadingMore}
                      onPress={() => changePage(pageIndex - 1, pageCursors[pageIndex - 1])}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      title={loadingMore ? "Loading…" : "Next"}
                      variant="secondary"
                      loading={loadingMore}
                      disabled={!visibleNextCursor || loadingMore}
                      onPress={() => changePage(pageIndex + 1, visibleNextCursor ?? undefined)}
                    />
                  </View>
                </View>
              </Card>
          ) : null
        }
      />

    </Screen>
  );
}
