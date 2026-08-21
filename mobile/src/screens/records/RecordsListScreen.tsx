import { useCallback, useEffect, useState } from "react";
import {
  Alert as RNAlert,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, EmptyState, ErrorNote, Screen, ScreenHeader, SegmentedControl, SelectChip, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import { useDebounced } from "../../lib/useDebounced";
import { takeFlash } from "../../lib/flash";
import { SkeletonList } from "../../components/Skeleton";
import { DateField, DateRangeChips } from "../../components/DateField";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../../lib/haptics";
import { recordUpdatePath } from "../../lib/recordUpdate";
import { brand, font, ink, radius, space, TAP, typeScale } from "../../theme/tokens";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../../lib/types";
import { RecordCard } from "./RecordCard";
import { type ImportBatchSummary } from "./shared";

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

export function RecordsScreen({ navigation, route }: any) {
  const { selected, categories } = useBusinessProfiles();
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
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
  const [error, setError] = useState<string | null>(null);
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

  // Typing "groceries" used to fire nine requests, each racing the last.
  const searchTerm = useDebounced(keyword);
  /** Only send a date once it is actually a date, or the server answers 400. */
  const isCompleteDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

  const load = useCallback(
    async (isRefresh = false, cursor?: string) => {
      if (!selected) return;
      if (cursor) {
        setLoadingMore(true);
      } else if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const page = await api.get<{ items: RecordItem[]; nextCursor: string | null }>("/records/search", {
            businessProfileId: selected.id,
            type,
            keyword: searchTerm || undefined,
            categoryId: categoryId ?? undefined,
            source: source ?? undefined,
            // Sent only alongside its source, so a batch chosen and then left
            // behind by a source change cannot silently keep scoping results.
            importBatchId: source === "CSV_UPLOAD" && importBatchId ? importBatchId : undefined,
            dateFrom: isCompleteDate(dateFrom) ? dateFrom : undefined,
            dateTo: isCompleteDate(dateTo) ? dateTo : undefined,
            limit: 50,
            cursor,
          });
        setRecords((current) => (cursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [selected, type, searchTerm, categoryId, source, importBatchId, dateFrom, dateTo]
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

  useFocusEffect(useCallback(() => { load(); }, [load]));

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
  function confirmDelete(record: RecordItem) {
    RNAlert.alert(
      "Delete this record?",
      `"${record.description}" will be removed. This cannot be undone.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            // Optimistic: the row leaves immediately and comes back if the
            // server refuses, rather than the owner watching a spinner over a
            // row they have already decided about.
            const previous = records;
            setRecords((rows) => rows.filter((x) => !(x.type === record.type && x.id === record.id)));
            try {
              await api.delete(recordUpdatePath(record.type, record.id));
              haptics.committed();
            } catch (err) {
              setRecords(previous);
              setError(errorMessage(err));
              haptics.failed();
            }
          },
        },
      ],
    );
  }

  /** Clears a flag from the list, without a trip to the review screen. */
  async function resolve(record: RecordItem) {
    const previous = records;
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
      });
      haptics.succeeded();
      // This one stays on the list, so it needs no hand-off — the same Callout,
      // set directly.
      setNotice("Marked reviewed and not a duplicate.");
    } catch (err) {
      setRecords(previous);
      setError(errorMessage(err));
      haptics.failed();
    }
  }

  if (!selected) {
    return (
      <Screen>
        <View style={{ padding: space.lg }}>
          <EmptyState title="Set up a business first" body="Records belong to a business profile." />
        </View>
      </Screen>
    );
  }

  const categoryName = (id?: number) => categories.find((c) => c.id === id)?.name ?? "—";

  return (
    <Screen safeTop>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingTop: space.md, paddingBottom: space.xxl * 2 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={brand[600]} />}
      >
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
                : loading
                  ? ""
                  : `${records.length}${nextCursor ? "+" : ""} record${records.length === 1 ? "" : "s"}`}
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

        {loading ? (
          <SkeletonList />
        ) : records.length === 0 ? (
          <EmptyState
            title={keyword ? "No records match that search" : "You haven't added any records yet"}
            body={
              keyword
                ? "Try a different word, or clear the search box."
                : "Start with what you spent today — even one entry is enough for FinSight to begin showing you something."
            }
            action={!keyword ? <Button title="Add your first expense" variant="primary" onPress={() => navigation.navigate("AddExpense")} /> : undefined}
          />
        ) : (
          <>
            {records.map((r) => (
              <RecordCard
                key={`${r.type}-${r.id}`}
                r={r}
                categoryName={categoryName(r.categoryId)}
                onPress={() => navigation.navigate("EditRecord", { record: r })}
                onDelete={() => confirmDelete(r)}
                onResolve={() => resolve(r)}
              />
            ))}
            {nextCursor ? (
              <Button
                title={loadingMore ? "Loading…" : "Load more records"}
                variant="secondary"
                loading={loadingMore}
                onPress={() => load(false, nextCursor)}
              />
            ) : null}
          </>
        )}
      </ScrollView>

    </Screen>
  );
}
