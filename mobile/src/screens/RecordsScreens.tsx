import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert as RNAlert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Alert as AlertBanner, AlertBadge, Button, Callout, Card, CategorySelect, EmptyState, ErrorNote, Field, Money, Screen, ScreenHeader, SegmentedControl, SelectChip, T } from "../components/ui";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import {
  buildItemisedConfirmPayload,
  buildReceiptConfirmPayload,
  gapCentavos,
  type ReconciliationPlan,
} from "../lib/receiptConfirm";
import { rowsToApplySuggestionTo, suggestedNewCategory } from "../lib/categorySuggestion";
import { classifyTypeValue, parseSignedAmount, type RowRecordType } from "../lib/recordTypeDetection";
import { ReceiptCamera } from "../components/receipt-camera";
import { takeHandedOffSections } from "../lib/receiptHandoff";
import {
  canAddSection,
  CAPTURE_QUALITY,
  type ReceiptSection,
  type SectionQuality,
} from "../lib/receiptCapture";
import { formatMoney } from "../lib/money";
import { useDebounced } from "../lib/useDebounced";
import { setFlash, takeFlash } from "../lib/flash";
import { SkeletonBox, SkeletonCard, SkeletonList } from "../components/Skeleton";
import { DateField, DateRangeChips } from "../components/DateField";
import { Swipeable } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../lib/haptics";
import { RecordOriginPanel, type RecordOrigin } from "../components/RecordOrigin";
import {
  buildExpenseUpdatePayload,
  buildSalesUpdatePayload,
  recordUpdatePath,
} from "../lib/recordUpdate";
import { brand, font, ink, paper, radius, space, status, statusText, TAP, typeScale } from "../theme/tokens";
import { RECORD_SOURCE_LABELS, type ExpenseCategory, type RecordItem, type RecordSource } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";

const todayISO = () => new Date().toISOString().slice(0, 10);

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

/** Status badges, shared by the list and the review queue. */
/** The surface behind an expense medallion. See STATUS_SURFACE in Insights. */
const STATUS_SURFACE_SERIOUS = "#fdf0ea";

/**
 * One glyph per way a record can have arrived.
 *
 * Keyed by the SOURCE enum, not by its label. `RECORD_SOURCE_LABELS` maps
 * `MANUAL_ENTRY` to the words "Manual Entry", and keying on the words would
 * have missed on every row and quietly fallen through to the default glyph —
 * a lookup that never throws and is never right.
 */
const SOURCE_ICONS: Record<RecordSource, keyof typeof Ionicons.glyphMap> = {
  MANUAL_ENTRY: "create-outline",
  RECEIPT_SCAN: "camera-outline",
  CSV_UPLOAD: "cloud-upload-outline",
};

function badges(r: RecordItem) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: space.sm }}>
      {r.duplicateStatus === "Flagged" ? <AlertBadge kind="duplicate" /> : null}
      {r.reviewStatus === "Needs Review" ? <AlertBadge kind="needs-review" /> : null}
      {r.largeExpenseFlag ? <AlertBadge kind="large-expense" /> : null}
    </View>
  );
}

/**
 * The action revealed behind a swiped row.
 *
 * Full-height and colour-filled so the gesture reads as uncovering something
 * rather than dragging the card off its own background.
 */
function SwipeAction({
  label,
  icon,
  colour,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  colour: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 84,
        marginBottom: space.sm,
        backgroundColor: colour,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.lg,
      }}
    >
      <Ionicons name={icon} size={20} color="#fff" />
      <T style={{ color: "#fff", fontSize: typeScale.micro, marginTop: 2 }}>{label}</T>
    </Pressable>
  );
}

function RecordCard({
  r,
  categoryName,
  onPress,
  onDelete,
  onResolve,
}: {
  r: RecordItem;
  categoryName: string;
  onPress?: () => void;
  onDelete?: () => void;
  onResolve?: () => void;
}) {
  /*
   * Swipe reveals; it never acts on its own.
   *
   * A swipe that deleted on release would be a destructive action triggered by
   * a gesture people make accidentally while scrolling a list. Revealing a
   * button that must then be tapped keeps the shortcut without the hazard —
   * and `onDelete` still asks for confirmation on top of that.
   */
  /*
   * What this card says when it is read rather than seen.
   *
   * Left to itself it is announced as its children fall out of the layout:
   * description, then the date line with its middle dots, then the amount,
   * then each badge with its glyph, then the source. Nothing is missing from
   * that — it is just in layout order rather than reading order, and it
   * speaks separators that only exist to hold a row together. So the same
   * content is composed here in the order it matters: what the record is,
   * what it cost, when and under what, then anything flagged on it, then
   * where it came from. Same facts, no glyphs, figure second instead of third.
   *
   * This is the app's second composed label, after CategoryChips, and for the
   * same reason: the useful spoken form is not the visible arrangement.
   */
  const spoken = [
    r.description,
    formatMoney(r.amount),
    `${r.date.slice(0, 10)}, ${r.type === "expense" ? `expense, ${categoryName}` : "sales"}`,
    r.duplicateStatus === "Flagged" ? "possible duplicate" : null,
    r.reviewStatus === "Needs Review" ? "needs review" : null,
    r.largeExpenseFlag ? "large expense" : null,
    RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source,
  ]
    .filter(Boolean)
    .join(", ");

  const card = (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      // A card with nothing wired to it is not a button, and saying it is
      // would promise a tap that does nothing. Both props hang off the same
      // condition as `disabled` so the three cannot disagree.
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? spoken : undefined}
    >
      <Card style={{ marginBottom: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.md }}>
          {/*
            A medallion, coloured by what the row IS rather than by its
            category. Sales rise and expenses leave, and that difference is
            the one an owner scanning a mixed list needs first — the category
            is written on the line below, where reading it is cheap.
          */}
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: r.type === "expense" ? STATUS_SURFACE_SERIOUS : brand[50],
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons
              name={r.type === "expense" ? "bag-handle-outline" : "trending-up-outline"}
              size={19}
              color={r.type === "expense" ? statusText.serious : brand[700]}
            />
          </View>

          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <T style={{ flex: 1, fontFamily: font.sansMedium, color: ink[900] }} numberOfLines={2}>
                {r.description}
              </T>
              <Money
                value={r.amount}
                size={15}
                weight="semibold"
                decimals
                color={r.type === "expense" ? ink[900] : brand[700]}
              />
            </View>
            <T variant="caption" style={{ marginTop: 2 }}>
              {r.date.slice(0, 10)} · {r.type === "expense" ? `Expense · ${categoryName}` : "Sales"}
            </T>
            {badges(r)}
            {/*
              How the record got here, with the glyph that says it. Three
              sources look alike as words in a caption and quite different as
              icons, which is what makes "was this scanned or typed?"
              answerable at a glance.
            */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: space.sm }}>
              <Ionicons name={SOURCE_ICONS[r.source as RecordSource] ?? "ellipse-outline"} size={13} color={ink[400]} />
              <T variant="caption">{RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source}</T>
            </View>
          </View>

          {onPress ? (
            <Ionicons name="chevron-forward" size={16} color={ink[300]} style={{ alignSelf: "center" }} />
          ) : null}
        </View>
      </Card>
    </Pressable>
  );

  // No actions wired means no gesture layer at all — a swipe that reveals
  // nothing is worse than a row that does not swipe.
  if (!onDelete && !onResolve) return card;

  const needsResolving = r.reviewStatus === "Needs Review" || r.duplicateStatus === "Flagged";

  return (
    <Swipeable
      overshootRight={false}
      overshootLeft={false}
      onSwipeableWillOpen={() => haptics.tapped()}
      renderRightActions={
        onDelete
          ? () => <SwipeAction label="Delete" icon="trash-outline" colour={statusText.critical} onPress={onDelete} />
          : undefined
      }
      renderLeftActions={
        onResolve && needsResolving
          ? () => (
              <SwipeAction
                label="Resolve"
                icon="checkmark-circle-outline"
                colour={statusText.good}
                onPress={onResolve}
              />
            )
          : undefined
      }
    >
      {card}
    </Swipeable>
  );
}

// ---------------------------------------------------------------- List

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
      cursor ? setLoadingMore(true) : isRefresh ? setRefreshing(true) : setLoading(true);
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
    [selected?.id, type, searchTerm, categoryId, source, importBatchId, dateFrom, dateTo]
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

// ---------------------------------------------------------------- Category picker

/**
 * The category for one line of a receipt, as a dropdown.
 *
 * It was a row of chips, and chips were the wrong control here. Every
 * category the business has rendered as a chip, wrapping over three or four
 * lines — and then again for the next item, and the next. A nine-line receipt
 * against a dozen categories put over a hundred chips on one screen, all of
 * them looking alike, which is a large part of why that screen was
 * unreadable.
 *
 * A dropdown costs one tap and gives back a constant-height row that states
 * the current answer. No create field, deliberately: CategoryPicker carries
 * one, which is right when it appears once on a form and wrong when it
 * appears on every row of an itemised receipt.
 */
function CategoryChips({
  categories,
  value,
  onChange,
  label,
}: {
  categories: ExpenseCategory[];
  value: number | null;
  onChange: (id: number) => void;
  label: string;
}) {
  return (
    <CategorySelect
      options={categories}
      value={value}
      onChange={onChange}
      // These rows repeat down an itemised receipt, so "Food" on its own
      // tells a screen reader nothing about WHICH line it would file.
      accessibilityContext={label}
      sheetTitle={label ? `Category for ${label}` : "Choose a category"}
    />
  );
}

/**
 * A heading for one section of the receipt review.
 *
 * The review used to be a single card holding six warnings, four fields, a
 * row per item, a summary and a reconciliation question — roughly six hundred
 * lines of interface with nothing dividing it. Everything was legible and
 * nothing was findable: an owner looking for "why doesn't this add up"
 * scrolled past the same undifferentiated column every time.
 *
 * Splitting it into titled sections costs a little vertical space and buys
 * the one thing the screen most needed, which is somewhere for the eye to
 * stop.
 */
function ReviewSection({
  title,
  caption,
  children,
  style,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
  style?: ViewStyle;
}) {
  return (
    <Card style={style}>
      <T variant="heading" accessibilityRole="header" style={{ color: brand[900], marginBottom: caption ? 2 : space.md }}>
        {title}
      </T>
      {caption ? (
        <T variant="caption" style={{ marginBottom: space.md }}>
          {caption}
        </T>
      ) : null}
      {children}
    </Card>
  );
}

/** One thing the owner should look at before saving. */
interface ReviewNotice {
  tone: "warn" | "info";
  text: string;
}

/**
 * Everything worth checking, gathered into one place.
 *
 * WHY THEY ARE NO LONGER SIX SEPARATE CALLOUTS. A blurry photo, a blurry
 * PAGE, a duplicated page, an overlapping section, two receipts in one shot
 * and an AI-assisted read are all possible at once, and on a bad scan several
 * fire together. Stacked, each in its own tinted panel with its own border
 * and its own icon, they filled the screen before a single figure was
 * visible — and a wall of warnings is read as one undifferentiated blob or
 * skipped entirely, which is the failure mode a warning can least afford.
 *
 * The wording of each is unchanged: they were written to say what to DO, and
 * shortening them to fit a tidier layout would trade the useful half for the
 * decorative one. What changes is that they share one panel, are counted, and
 * sit under a heading that says what they are.
 */
function ReviewNotices({ notices }: { notices: ReviewNotice[] }) {
  if (notices.length === 0) return null;

  const worst = notices.some((n) => n.tone === "warn") ? "warn" : "info";
  const tint = worst === "warn" ? statusText.warning : brand[700];

  return (
    <Card style={{ borderColor: worst === "warn" ? status.warning : brand[200] }}>
      <T variant="heading" accessibilityRole="header" style={{ color: tint, marginBottom: space.sm }}>
        {notices.length === 1 ? "Worth checking" : `Worth checking (${notices.length})`}
      </T>
      <View style={{ gap: space.sm }}>
        {notices.map((notice, i) => (
          <View
            key={i}
            style={{
              flexDirection: "row",
              gap: space.sm,
              // A rule between entries rather than a box around each: they are
              // a list of related remarks, not six unrelated alerts.
              paddingTop: i === 0 ? 0 : space.sm,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: paper[200],
            }}
          >
            <T
              style={{
                fontSize: typeScale.label,
                fontFamily: font.sansSemibold,
                color: notice.tone === "warn" ? statusText.warning : brand[700],
              }}
            >
              {notice.tone === "warn" ? "⚠" : "ⓘ"}
            </T>
            <T style={{ flex: 1, fontSize: typeScale.label, lineHeight: 19, color: ink[700] }}>{notice.text}</T>
          </View>
        ))}
      </View>
    </Card>
  );
}

/**
 * One answer to "what is this difference".
 *
 * A single decision with mutually exclusive answers, so it behaves as a radio
 * for assistive tech rather than as three unrelated buttons.
 */
function GapOption({
  selected,
  onPress,
  title,
  detail,
  children,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{
        borderWidth: 1,
        borderColor: selected ? brand[600] : ink[200],
        backgroundColor: selected ? brand[50] : paper.DEFAULT,
        borderRadius: radius.md,
        padding: space.md,
        marginBottom: space.sm,
      }}
    >
      <T style={{ fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansMedium }}>{title}</T>
      <T variant="caption" style={{ marginTop: 2 }}>{detail}</T>
      {children}
    </Pressable>
  );
}

function CategoryPicker({
  categories,
  value,
  onChange,
  onCreated,
}: {
  categories: ExpenseCategory[];
  value: number | null;
  onChange: (id: number) => void;
  onCreated: () => void;
}) {
  // The business is read from context rather than passed in: the write itself
  // moved to createCategory, which is already scoped to the selected business,
  // so a prop naming it here would be a second source for the same fact.
  const { createCategory } = useBusinessProfiles();
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Raw TextInput, so the focus border `Field` gives every other input is
   *  wired here by hand rather than inherited. */
  const [nameFocused, setNameFocused] = useState(false);

  async function create() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const c = await createCategory({ name: newName.trim() });
      setNewName("");
      onCreated();
      onChange(c.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ marginBottom: space.md }}>
      <T variant="label" style={{ marginBottom: 4, color: ink[700] }}>Category</T>
      {categories.length > 0 ? (
        /*
          A dropdown rather than a row of chips, matching the per-item control
          on an itemised receipt. Two ways of choosing the same thing on one
          screen is the kind of difference that reads as a bug.
        */
        <View style={{ marginBottom: space.sm }}>
          <CategorySelect options={categories} value={value} onChange={onChange} />
        </View>
      ) : (
        // Create-on-the-fly when the list is empty, same as web — a brand-new
        // business would otherwise hit a dead end on its very first expense.
        <T variant="caption" style={{ marginBottom: space.sm }}>
          No categories yet. Add your first one below (e.g. Inventory, Utilities, Rent).
        </T>
      )}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="New category name"
          placeholderTextColor={ink[400]}
          // Deliberately NOT part of the surrounding form's next-field chain.
          // This box belongs to a side errand — naming a category — and its
          // return key does what the "Add" button beside it does. Handing the
          // keyboard on to Description instead would abandon a half-typed
          // category name. The guard mirrors the button's own
          // `loading` / `disabled` so return cannot post a second time.
          returnKeyType="done"
          onSubmitEditing={() => {
            if (!busy && newName.trim()) create();
          }}
          onFocus={() => setNameFocused(true)}
          onBlur={() => setNameFocused(false)}
          style={{
            flex: 1,
            minHeight: TAP,
            borderWidth: 1,
            borderColor: nameFocused ? brand[600] : ink[200],
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            fontSize: typeScale.body,
            color: ink[900],
          }}
        />
        <Button title="Add" variant="secondary" onPress={create} loading={busy} disabled={!newName.trim()} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Add expense

export function AddExpenseScreen({ navigation }: any) {
  const { selected, categories, refreshCategories } = useBusinessProfiles();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * The category picker and the date field are pressables, not text inputs —
   * they cannot carry a return key at all. So the keyboard chain starts at the
   * first field that actually has one and runs to the end of the form.
   */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);

  if (!selected) return null;

  async function submit() {
    if (!categoryId) return setError("Choose a category first.");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setError(null);
    setBusy(true);
    try {
      await api.post("/records/expenses", {
        businessProfileId: selected!.id,
        categoryId,
        date,
        description: description.trim(),
        vendor: vendor.trim() || undefined,
        amount: value,
      });
      haptics.succeeded();
      // The haptic is silent for anyone who has haptics off; the flash is what
      // the owner actually sees once the list comes back.
      setFlash("Expense saved.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {/*
        Amount is the last field on the card and the keyboard is tall, so
        without this it opens straight over the field being typed into. Same
        shell AuthShell uses: `padding` on iOS, nothing on Android, where the
        system already resizes the window.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
            <T variant="title" style={{ marginBottom: space.md }}>Add expense</T>
            <CategoryPicker
              categories={categories}
              value={categoryId}
              onChange={setCategoryId}
              onCreated={refreshCategories}
            />
            <DateField label="Date" value={date} onChange={setDate} />
            {/*
              `submitBehavior="submit"` keeps the keyboard up between fields so
              it does not flicker shut and open on every hop. It is the
              replacement for the prop React Native 0.86 deprecated; see the
              same note on the login form in AuthScreens.
            */}
            <Field
              label="Description"
              value={description}
              maxLength={FIELD_LIMITS.recordDescription}
              onChangeText={setDescription}
              placeholder="e.g. Rice sacks"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => vendorRef.current?.focus()}
            />
            <Field
              ref={vendorRef}
              label="Vendor (optional)"
              value={vendor}
              onChangeText={setVendor}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => amountRef.current?.focus()}
            />
            {/*
              A decimal keypad has no return key on iOS, so this hand-off only
              fires on Android. Wired anyway: it costs nothing where it does
              not apply, and the Save button is the reliable path on both.
            */}
            <Field
              ref={amountRef}
              label="Amount (PHP)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              returnKeyType="done"
              // Mirrors the button's own `loading` guard, so a return key
              // pressed twice cannot post the expense twice.
              onSubmitEditing={() => {
                if (!busy) submit();
              }}
            />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button title="Save expense" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Add sales

export function AddSalesScreen({ navigation }: any) {
  const { selected } = useBusinessProfiles();
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("Daily sales");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The date field is a pressable, so the chain is Description → Amount.
  const amountRef = useRef<TextInput>(null);

  if (!selected) return null;

  async function submit() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setError(null);
    setBusy(true);
    try {
      await api.post("/records/sales", {
        businessProfileId: selected!.id,
        date,
        description: description.trim(),
        amount: value,
      });
      haptics.succeeded();
      setFlash("Sales record saved.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>Add sales reference</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              A sales figure you record for monitoring — not a receipt for a customer.
            </T>
            <DateField label="Date" value={date} onChange={setDate} />
            <Field
              label="Description"
              value={description}
              maxLength={FIELD_LIMITS.recordDescription}
              onChangeText={setDescription}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => amountRef.current?.focus()}
            />
            {/* Decimal keypad: the return key exists on Android only. */}
            <Field
              ref={amountRef}
              label="Amount (PHP)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!busy) submit();
              }}
            />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button title="Save sales record" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Receipt scan

/**
 * Capture in FinSight's own camera → approve each section → upload to the
 * existing backend receipt endpoint → editable review → confirm.
 *
 * WHAT THE CAMERA CHANGED, AND WHAT IT DID NOT. Photographs now come from
 * components/receipt-camera rather than from the system camera app: a receipt
 * frame to line the paper up in, a section counter that says these are parts
 * of ONE receipt, an overlap guide for long ones, an approval step before
 * anything is uploaded, and a crop editor. None of that reaches the server.
 * `scanPages` below sends the same `files` array in the same order to the
 * same endpoint it always has — see pagesFromSections for the seam. The
 * gallery path is untouched and remains the fallback for a phone whose owner
 * will not grant camera access.
 *
 * SECTION 0 DECISION: OCR runs SERVER-SIDE (Tesseract, already built and
 * accuracy-measured at 100% date / 95% vendor / 100% amount on a 20-image
 * corpus). Google ML Kit's on-device OCR needs native modules that don't run in
 * Expo Go, so adopting it would mean a dev-client or bare-workflow migration —
 * a large change for a capability the backend already provides and that has
 * measured accuracy behind it. On-device OCR is documented as a future
 * improvement instead.
 *
 * THE SAME CONSTRAINT DECIDED EDGE DETECTION. Every way of finding a
 * receipt's corners on the phone — a document-scanner library, a custom
 * native module, OpenCV — needs a development build for exactly the reason
 * ML Kit did. So detection runs server-side, after the shutter, on the same
 * still the readability check already looks at, and it only ever proposes
 * corners the owner drags. Nothing is detected from live frames, which is why
 * there is no real-time outline and no automatic shutter.
 *
 * The one real difference from a browser upload: a phone camera returns a large,
 * possibly rotated JPEG. That is exactly why the review step below is editable
 * and nothing is saved until the owner confirms.
 */
/**
 * What POST /records/receipts returns.
 *
 * Typed rather than `any` because `any` is precisely how this screen drifted
 * off the API contract: the confirm call below sent a field the server had
 * stopped accepting, and nothing anywhere could tell. Naming the shape is the
 * cheapest guard against the next round of that.
 */
interface ReceiptScanResult {
  id: number;
  extractedDate: string | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: number | null;
  /**
   * True when the server could not read the receipt's TEXT and had a vision
   * model interpret the photograph instead. These values are a machine's
   * reading of a picture, and the screen has to say so.
   */
  visionAssisted?: boolean;
  /**
   * How readable the photograph itself was. Only present on the upload
   * response — it answers "should you take another one?", which is only worth
   * asking while the owner still has the receipt in front of them. On a phone
   * that is the whole point: the camera is right there.
   */
  captureQuality?: { sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null;
  /** How sure OCR was about this page, 0-100. Null when not measured. */
  ocrConfidence?: number | null;
  /** The line most likely misread, when the items don't add up to the total. */
  suspectItemId?: number | null;
  /**
   * True when the photograph appears to hold more than one receipt.
   *
   * Advisory only, and one-directional: false means "no evidence of a second
   * receipt", not "definitely one". The server cannot tell which items belong
   * to which receipt, so it says what it noticed and the owner — who is
   * holding the paper — decides.
   */
  looksLikeMultipleReceipts?: boolean;
  /**
   * Every page's own quality reading, in the order they were photographed.
   * Present only on the upload response, for the same reason captureQuality
   * is — it stops mattering once the scan is confirmed or abandoned.
   */
  pageQualities?: ({ sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null)[];
  /**
   * 1-indexed page numbers that read as the same page photographed twice.
   * Empty on a single-page scan.
   */
  duplicatePages?: number[];
  /**
   * 1-indexed sections whose first lines repeat the previous section's last
   * ones — the overlap the capture guide asks for on a long receipt.
   *
   * Expected rather than wrong, which is why it is worded and toned
   * differently from duplicatePages above. Empty on a single-section scan.
   */
  overlappingPages?: number[];
  /**
   * How far the server has got READING this scan: "Processing" | "Complete" |
   * "Failed". Distinct from confirmationStatus, which is the owner's own
   * decision afterwards. The upload responds before the read finishes, so
   * this is what pollUntilRead waits on.
   */
  processingStatus?: "Processing" | "Complete" | "Failed";
  /** Why the read failed. Present only when processingStatus is "Failed". */
  processingError?: string | null;
  /**
   * The individual lines the server read, each with the category it assigned.
   * A receipt with more than one is reviewed line by line below; anything
   * less keeps the single-category flow.
   */
  items?: {
    id: number;
    name: string;
    quantity: number | null;
    amount: number;
    /** What FinSight assigned. Null when nothing on the list fitted. */
    categoryId: number | null;
    /** True for a line a vision model produced rather than OCR text. */
    extractedByVision?: boolean;
    /** A category FinSight thinks is missing. Only ever an offer. */
    suggestedCategoryName?: string | null;
    /** How sure OCR was about THIS amount, 0-100, or null if not measured. */
    amountConfidence?: number | null;
  }[];
}

/** One photograph in a capture session, before it has been scanned. */
/**
 * How often, and for how long, to ask whether a scan has finished reading.
 *
 * Matches the web client's figures deliberately — the same server work is
 * being waited on, and two different cadences would be two numbers to keep
 * in step for no reason. The endpoint polled runs two indexed queries and no
 * OCR, so this is cheap; the generous ceiling exists to end a wait that will
 * never finish (a server restart mid-read strands a scan on "Processing"),
 * not to cut short one that is merely slow.
 */
const SCAN_POLL_INTERVAL_MS = 1500;
const SCAN_POLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Waits for a scan the server has accepted but not yet finished reading.
 *
 * Throws on a failed or never-finishing read rather than returning a
 * half-empty scan — scanPages' existing catch then shows the reason and
 * leaves the owner on the capture screen with their photos intact, which is
 * the same outcome any other failed scan has always had.
 */
async function pollUntilRead(initial: ReceiptScanResult, mayRetry = true): Promise<ReceiptScanResult> {
  if (initial.processingStatus && initial.processingStatus !== "Processing") {
    if (initial.processingStatus === "Failed") {
      if (mayRetry) {
        const retried = await api.post<ReceiptScanResult>(`/records/receipts/${initial.id}/retry`);
        return pollUntilRead(retried, false);
      }
      throw new Error(initial.processingError ?? "This receipt could not be read. Try scanning it again.");
    }
    return initial;
  }

  const deadline = Date.now() + SCAN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_INTERVAL_MS));
    const next = await api.get<ReceiptScanResult>(`/records/receipts/${initial.id}`);
    if (next.processingStatus === "Failed") {
      if (mayRetry) {
        const retried = await api.post<ReceiptScanResult>(`/records/receipts/${initial.id}/retry`);
        return pollUntilRead(retried, false);
      }
      throw new Error(next.processingError ?? "This receipt could not be read. Try scanning it again.");
    }
    if (next.processingStatus === "Complete") return next;
  }
  throw new Error("This receipt is taking longer than expected to read. Try scanning it again.");
}

interface CapturedPage {
  /** Local only, for list keys and edits — the server assigns nothing yet. */
  key: string;
  uri: string;
  fileName: string;
  mimeType: string;
  /** Null while checkingQuality is true, or if the check failed silently. */
  quality: SectionQuality | null;
  checkingQuality: boolean;
  /**
   * The photograph's own pixels.
   *
   * Carried so a page can be handed BACK to the camera when the owner reopens
   * it to add another section — the crop editor cannot map a handle to a file
   * whose dimensions it does not know. Zero for pages captured before this
   * existed, which the camera reads as "not croppable" rather than crashing.
   */
  width: number;
  height: number;
  /** The uncropped original, when one is still around. */
  originalUri?: string;
}

/**
 * Turns a finished capture session into the page list this screen already
 * uploads.
 *
 * A DELIBERATE SEAM. The camera is new; the upload is not. `scanPages` below
 * has always sent a `files` array in page order and the server has always
 * read one, and none of that changes because the photographs now arrive from
 * a different screen. Everything the new camera knows that the old flow did
 * not — crop corners, edge confidence — stops here, because the request
 * format is a contract with a server that never asked for it.
 *
 * The readability reading DOES cross over, already measured, so a section
 * approved in the camera is not sent for the same check twice.
 */
function pagesFromSections(sections: ReceiptSection[]): CapturedPage[] {
  return sections.map((section, index) => ({
    key: section.localId,
    uri: section.processedUri,
    fileName: `receipt-section-${index + 1}-${Date.now()}.jpg`,
    // Always JPEG: the camera saves JPEG and every crop re-renders as JPEG.
    // The server's upload filter accepts jpeg|png|webp, so this is inside
    // what it allows rather than a new claim about what it takes.
    mimeType: "image/jpeg",
    quality: section.quality,
    checkingQuality: false,
    width: section.width,
    height: section.height,
    originalUri: section.originalUri,
  }));
}

/**
 * The same conversion backwards, for reopening the camera on a session that
 * is already part-photographed.
 *
 * Without this, tapping "Add another section" from the capture card would
 * open a camera holding nothing, and finishing it would replace the sections
 * already taken instead of extending them — a long receipt losing its first
 * two pages to the act of photographing its third. The camera owns the whole
 * ordered session while it is open, so it has to be given the whole session.
 */
function sectionsFromPages(pages: CapturedPage[]): ReceiptSection[] {
  return pages.map((page) => ({
    localId: page.key,
    originalUri: page.originalUri ?? page.uri,
    processedUri: page.uri,
    width: page.width,
    height: page.height,
    quality: page.quality,
  }));
}

export function ScanReceiptScreen({ navigation, route }: any) {
  const { selected, categories, refreshCategories, createCategory } = useBusinessProfiles();
  const [scan, setScan] = useState<ReceiptScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Photos captured so far in this session, before the receipt is scanned.
   *
   * A long receipt is photographed a page at a time via `capturePage`, which
   * appends here rather than uploading immediately — the whole session is
   * sent as one scan only once the owner taps "Scan this receipt". A single
   * photo is simply a one-page session; there is no separate code path for
   * the common case.
   */
  /**
   * Sections photographed in the tab bar's camera before this screen existed.
   *
   * Taken once, in a lazy initialiser, because `takeHandedOffSections` clears
   * as it reads — calling it during an ordinary render would consume the
   * session on the first render and find nothing on the second.
   */
  const [handedOff] = useState(() => takeHandedOffSections());

  const [pages, setPages] = useState<CapturedPage[]>(() =>
    handedOff ? pagesFromSections(handedOff) : [],
  );

  /**
   * Whether FinSight's own camera is up.
   *
   * Open unless the owner arrives with photographs already taken. There are
   * two ways in and they want opposite things:
   *
   *   - from the tab bar's Scan button, the camera has ALREADY run and handed
   *     its sections over; reopening it here would put a viewfinder in front
   *     of someone who has just finished photographing;
   *   - from "Scan receipt" on the records list, nothing has been captured,
   *     and the screen's whole purpose is to capture something. Landing on a
   *     card whose only content is a button saying "Open the camera" asks
   *     someone to confirm the thing they just asked for.
   *
   * A full-screen state rather than a route of its own, so backing out of the
   * camera is this screen's decision to make (see `onCancel`) rather than
   * something the Android back button and the header's back arrow each get
   * their own opinion about. It also means the preview unmounts the moment
   * this flips false, which keeps the sensor and torch from running behind
   * the review form.
   */
  const [cameraOpen, setCameraOpen] = useState(handedOff === null);

  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");

  /**
   * The owner's category for each extracted line, keyed by item id.
   *
   * Seeded from what the server assigned automatically, then owned by the
   * owner — every row is editable and nothing is written until Confirm.
   */
  const [itemCategories, setItemCategories] = useState<Record<number, number | null>>({});
  /** How they want to account for any difference between items and total. */
  const [plan, setPlan] = useState<ReconciliationPlan>(null);
  /** The category for the "file it on its own" plan. */
  const [gapCategoryId, setGapCategoryId] = useState<number | null>(null);
  /** The proposed category currently being created, so its row can show progress. */
  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);
  /**
   * Lines the owner is adding because OCR missed them.
   *
   * Held here until Confirm, like every other answer on this screen — nothing
   * is written until they accept the whole receipt.
   */
  const [addedItems, setAddedItems] = useState<
    { key: string; name: string; amount: string; categoryId: number | null }[]
  >([]);
  /** The extracted line currently being removed, so its row can show progress. */
  const [removingItemId, setRemovingItemId] = useState<number | null>(null);

  /** The review form's chain: Description → Vendor → Amount. */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);
  /**
   * The added-item rows chain within themselves — name hands off to the
   * amount on the SAME row, never to the next row's.
   *
   * One ref per row, held in a map keyed by the row's own `key`, because the
   * rows are produced by a `.map()`: a single shared ref would be overwritten
   * by every row rendered after the first, and typing in row one would jump
   * the cursor to the bottom of the receipt. The callback clears its entry on
   * unmount so removing a row does not leave a dead node behind.
   */
  const addedAmountRefs = useRef<Record<string, TextInput | null>>({});

  /*
   * The camera never outlives this screen.
   *
   * Opening the Modal does not blur the screen — it is part of it — so this
   * cleanup only fires when the owner genuinely navigates away: a tab press
   * that pops the stack, a notification, a deep link. Without it an
   * unmounting screen could leave an Android modal window behind with no
   * component left to close it, which shows up as an app that has quietly
   * become unresponsive.
   */
  useFocusEffect(useCallback(() => () => setCameraOpen(false), []));

  /*
   * A handed-over session is already photographed and already approved — the
   * owner pressed "Scan" on the capture preview, not "hold this for me". So
   * the read starts on arrival rather than behind one more button on a screen
   * that would otherwise show them their own photographs and ask again.
   *
   * Mount-only. `scanPages` is given the pages explicitly because the state
   * holding them was set in the same render this effect follows, and reading
   * it through the closure would be reading it before React has committed.
   */
  useEffect(() => {
    if (handedOff && handedOff.length > 0) void scanPages(pagesFromSections(handedOff));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!selected) return null;

  /**
   * Adds one photograph to the session and checks its own readability
   * immediately — the point of doing this now rather than after the whole
   * set uploads is that catching a blurry PAGE 2 while the camera is still
   * open costs a tap, and catching it after costs an OCR pass, a possible
   * vision call, and a wrong set of figures the owner has to notice and undo.
   *
   * The check runs against a DIFFERENT, lightweight endpoint
   * (/records/receipts/quality-check) that does no OCR and writes nothing —
   * it exists purely so this can be cheap enough to fire on every shutter
   * press. Failing silently here is deliberate: a blur check that could not
   * run is a missed nicety, not a reason to stop the owner from adding the
   * page they just photographed.
   */
  async function addPage(asset: ImagePicker.ImagePickerAsset) {
    const key = `${Date.now()}-${Math.random()}`;
    const uri = asset.uri;
    const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? "image/jpeg";
    setPages((prev) => [
      ...prev,
      {
        key,
        uri,
        fileName,
        mimeType,
        quality: null,
        checkingQuality: true,
        width: asset.width,
        height: asset.height,
      },
    ]);
    setError(null);

    try {
      const form = new FormData();
      // React Native's FormData takes this {uri,name,type} shape rather than
      // a Blob — the browser's File API isn't available here.
      form.append("file", { uri, name: fileName, type: mimeType } as any);
      const quality = await api.upload<CapturedPage["quality"]>("/records/receipts/quality-check", form);
      setPages((prev) => prev.map((p) => (p.key === key ? { ...p, quality, checkingQuality: false } : p)));
    } catch {
      setPages((prev) => prev.map((p) => (p.key === key ? { ...p, checkingQuality: false } : p)));
    }
  }

  function removePage(key: string) {
    setPages((prev) => prev.filter((p) => p.key !== key));
  }

  /** Moves a page earlier (delta -1) or later (delta +1) in the sequence. */
  function movePage(key: string, delta: number) {
    setPages((prev) => {
      const index = prev.findIndex((p) => p.key === key);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }

  /**
   * Sends every captured page as ONE scan. A single photo is simply a
   * one-element page list — there is no separate upload path for it.
   */
  async function scanPages(list: CapturedPage[] = pages) {
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("businessProfileId", String(selected!.id));
      // "files" — plural — repeated once per page: the server has one
      // upload route for both a single photo and a long receipt's pages,
      // and it reads this field name for either.
      for (const p of list) {
        form.append("files", { uri: p.uri, name: p.fileName, type: p.mimeType } as any);
      }

      const accepted = await api.upload<ReceiptScanResult>("/records/receipts", form);
      // The upload returns as soon as the photos are stored; the read itself
      // finishes behind it. See pollUntilRead.
      const result = await pollUntilRead(accepted);
      setScan(result);
      // Pre-fill from OCR — as a draft the owner checks, never as truth.
      if (result.extractedDate) setDate(String(result.extractedDate).slice(0, 10));
      if (result.extractedVendor) setVendor(result.extractedVendor);
      if (result.extractedDescription) setDescription(result.extractedDescription);
      /*
        Two decimal places, always. `String(1475.5)` is "1475.5", which reads
        as an amount somebody typed carelessly rather than one read off a
        receipt — and it is the field the owner is asked to check against
        printed centavos.
      */
      if (result.extractedAmount != null) setAmount(result.extractedAmount.toFixed(2));
      // Seed the per-item categories from what FinSight assigned. A starting
      // point, not a decision — every row stays editable below.
      setItemCategories(
        Object.fromEntries((result.items ?? []).map((i) => [i.id, i.categoryId ?? null])),
      );
      setPlan(null);
      setGapCategoryId(null);
      // A vision-assisted read is a guess, not a reading — it deserves a
      // different signal from a clean scan, so the owner is primed to check
      // it before they even look down.
      result.visionAssisted ? haptics.warned() : haptics.succeeded();
    } catch (err) {
      haptics.failed();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opens FinSight's own camera.
   *
   * Permission is NOT requested here any more. The camera screen owns that
   * conversation, because it is the thing that can explain what the camera is
   * for, offer the gallery instead, and point at Settings once the system has
   * stopped asking — none of which a one-line error on this card could do.
   */
  function capturePage() {
    haptics.committed();
    setError(null);
    setCameraOpen(true);
  }

  /**
   * The gallery fallback, unchanged in behaviour and deliberately kept.
   *
   * A receipt someone already photographed, a screenshot of an e-receipt, and
   * a phone whose owner will not grant camera access are all real, and none
   * of them is served by a scanner. This is also the path that keeps working
   * if anything about the new camera turns out to be wrong on a device — the
   * reason it was preserved before the camera was touched at all.
   *
   * Quality is raised to match the camera's: it is the same OCR reading the
   * same faint thermal print, and there is no reason a gallery image should
   * arrive more compressed than a captured one.
   */
  async function pickPage() {
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: CAPTURE_QUALITY,
      mediaTypes: ["images"],
    });
    if (!res.canceled && res.assets[0]) await addPage(res.assets[0]);
  }

  /*
   * Two review modes, exactly as web has.
   *
   * A receipt whose lines FinSight could read is reviewed ITEM BY ITEM — that
   * is the point of the feature, and it is what lets "buns" land in
   * Ingredients while "rice cooker" lands in Equipment without the owner
   * deciding anything up front. A receipt with one line or none keeps the
   * single-category flow: a grouping UI for one item would be ceremony around
   * a decision the category picker already makes.
   */
  const items = scan?.items ?? [];
  const isItemised = items.length > 1;
  /** An added line only counts once it is actually usable. */
  const usableAddedItems = addedItems.filter(
    (a) => a.name.trim() !== "" && Number(a.amount) > 0 && a.categoryId != null,
  );
  // Added lines count toward the items' total the moment they are complete, so
  // adding a missed line closes the gap immediately rather than after saving.
  const itemsTotal =
    items.reduce((sum, i) => sum + i.amount, 0) +
    usableAddedItems.reduce((sum, a) => sum + Number(a.amount), 0);
  const totalValue = Number(amount);
  const gap = Number.isFinite(totalValue) ? gapCentavos(totalValue, itemsTotal) : 0;
  const everyItemHasCategory =
    items.every((i) => itemCategories[i.id] != null) &&
    // A half-typed added row must not enable Confirm.
    addedItems.length === usableAddedItems.length;
  // A discount can't become its own expense record — that would be a negative
  // expense, which nothing downstream understands. The server refuses it too.
  const canFileGapOnItsOwn = gap > 0;
  const planResolved =
    gap === 0 ||
    plan === "proportional" ||
    plan === "shrink" ||
    (plan === "category" && canFileGapOnItsOwn && gapCategoryId != null);

  async function confirm() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (isItemised) {
      if (!everyItemHasCategory) return setError("Every item needs a category before this can be saved.");
      if (!planResolved) return setError("Choose how to account for the difference first.");
    } else if (!categoryId) {
      return setError("Choose a category first.");
    }

    setBusy(true);
    setError(null);
    try {
      // Both shapes and their rules live in lib/receiptConfirm, where they can
      // be tested against the server's schema — this call is what silently
      // broke against it before.
      const payload = isItemised
        ? buildItemisedConfirmPayload({
            date,
            description,
            vendor,
            totalAmount: value,
            itemsTotal,
            itemAssignments: items.map((i) => ({ itemId: i.id, categoryId: itemCategories[i.id]! })),
            additionalItems: usableAddedItems.map((a) => ({
              name: a.name.trim(),
              amount: Number(a.amount),
              categoryId: a.categoryId!,
            })),
            plan,
            gapCategoryId,
          })
        : buildReceiptConfirmPayload({ date, description, vendor, amount: value, categoryId: categoryId! });

      await api.post(`/records/receipts/${scan!.id}/confirm`, payload);
      haptics.succeeded();
      setFlash("Receipt saved to your records.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The standing "nothing fitted this" category, if this business has one.
   *
   * Created server-side on demand during a scan, so it may not exist at all,
   * and matched case-insensitively because an owner who already had their own
   * keeps it — the same rule the server follows.
   */
  const uncategorisedId = categories.find((c) => c.name.toLowerCase() === "uncategorized")?.id ?? null;

  /** See lib/categorySuggestion — the rule has edge cases worth testing. */
  function suggestedNewCategoryFor(item: { id: number; suggestedCategoryName?: string | null }): string | null {
    return suggestedNewCategory(
      item,
      itemCategories[item.id] ?? null,
      uncategorisedId,
      categories.map((c) => c.name),
    );
  }

  /**
   * Accepts a category FinSight proposed for items nothing existing fitted.
   *
   * Creates it, then files every UNPLACED row it was proposed for — not only
   * the row that was tapped. A grocery run proposes "Packaging" on all four
   * packaging lines, and making the owner create it once then assign it three
   * more times by hand would be busywork on a decision already made. Rows they
   * placed themselves are left alone, and everything stays editable.
   */
  async function acceptSuggestedCategory(name: string) {
    setCreatingCategoryFor(name);
    setError(null);
    try {
      // createCategory puts the new row into the shared list itself, so the
      // refreshCategories() that used to follow this is gone — it was a second
      // round trip to learn what the response already said.
      const created = await createCategory({ name });
      setItemCategories((prev) => {
        const next = { ...prev };
        for (const id of rowsToApplySuggestionTo(items, name, prev, uncategorisedId)) {
          next[id] = created.id;
        }
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreatingCategoryFor(null);
    }
  }

  /**
   * Drops a line OCR read that was never a purchase.
   *
   * Deleted on the SERVER rather than hidden here, because confirmation
   * requires every stored item to carry a category — a row this screen merely
   * stopped showing would still be on the scan and would block Confirm with a
   * message about an item the owner can no longer see.
   *
   * Widening the gap against the total is the intended consequence, not a
   * side effect: the reconciliation question below already exists to answer
   * exactly that.
   */
  async function removeScannedItem(itemId: number) {
    if (!scan) return;
    setRemovingItemId(itemId);
    setError(null);
    try {
      const updated = await api.delete<ReceiptScanResult>(`/records/receipts/${scan.id}/items/${itemId}`);
      setScan(updated);
      setItemCategories((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRemovingItemId(null);
    }
  }

  /**
   * Everything worth checking about this reading, in the order it matters.
   *
   * Gathered into one list rather than rendered as six separate callouts —
   * see ReviewNotices for why. The ORDER is the argument: the photograph
   * comes first because it has the cheapest answer on the screen and the
   * camera is one tap away, then the things that make figures wrong, then the
   * things that only make them uncertain.
   *
   * Every sentence is the one that was there before. They were written to say
   * what to DO about each case, and the reason to group them was never that
   * they were too wordy.
   */
  const reviewNotices: ReviewNotice[] = (() => {
    if (!scan) return [];
    const notices: ReviewNotice[] = [];

    if (scan.captureQuality?.tooBlurredToTrust) {
      notices.push({
        tone: "warn",
        text:
          "This photo came out blurry. FinSight read it anyway, but blurred print is where it makes the " +
          "most mistakes — if you still have the receipt, taking another picture is usually quicker than " +
          "correcting the figures below.",
      });
    }

    // Page 1's own reading is already covered by captureQuality above.
    const blurryPages = (scan.pageQualities ?? [])
      .map((q, i) => (q?.tooBlurredToTrust ? i + 1 : null))
      .filter((n): n is number => n !== null && n !== 1);
    if ((scan.pageQualities?.length ?? 0) > 1 && blurryPages.length > 0) {
      notices.push({
        tone: "warn",
        text:
          `Page${blurryPages.length === 1 ? "" : "s"} ${blurryPages.join(", ")} came out blurry. Check the ` +
          `figures from ${blurryPages.length === 1 ? "that page" : "those pages"} carefully below.`,
      });
    }

    const duplicates = scan.duplicatePages ?? [];
    if (duplicates.length > 0) {
      notices.push({
        tone: "warn",
        text:
          `Page${duplicates.length === 1 ? "" : "s"} ${duplicates.map((p) => `${p - 1} and ${p}`).join(", ")} ` +
          "look the same. If one is a repeat photo of the other, the figures below may be double-counted — " +
          "check the items against the photos, or rescan without the repeat.",
      });
    }

    /*
     * Suppressed when duplicatePages already fired: a page flagged as a
     * repeat of its neighbour will also, necessarily, overlap it, and two
     * remarks about one pair of photographs read as two separate problems.
     */
    const overlaps = scan.overlappingPages ?? [];
    if (overlaps.length > 0 && duplicates.length === 0) {
      notices.push({
        tone: "info",
        text:
          `Section${overlaps.length === 1 ? "" : "s"} ${overlaps.map((p) => `${p - 1} and ${p}`).join(", ")} ` +
          "share a few lines, which is the overlap the camera asked for. FinSight counted them once. If you " +
          "see a line twice below, delete the repeat.",
      });
    }

    if (scan.looksLikeMultipleReceipts) {
      notices.push({
        tone: "warn",
        text:
          "This photo may hold two receipts. If it does, saving now would put both purchases into one " +
          "record and the items won't add up to the total. Photograph each receipt on its own and they'll " +
          "be recorded separately — if it really is one receipt, carry on.",
      });
    }

    /*
     * Three-way split, same as the web confirm screen. The amounts on a
     * merely vision-ASSISTED read were still read off the paper and add up to
     * the printed total; only the wording came from a model. Showing the
     * stronger warning there would be false, and false in the direction that
     * teaches owners to skip warnings.
     */
    if (scan.items?.some((i) => i.extractedByVision)) {
      notices.push({
        tone: "warn",
        text:
          "FinSight couldn't read this receipt's text. These values were interpreted from the photo by AI, " +
          "so treat them as a first guess rather than something read off the paper — check every one, " +
          "including the total, against the photo.",
      });
    } else if (scan.visionAssisted) {
      notices.push({
        tone: "warn",
        text:
          "Some item names were filled in by AI. The amounts were read from the receipt and match its " +
          "total, but the printing was faint enough that FinSight wasn't sure of the wording — check the " +
          "item names against the photo.",
      });
    }

    return notices;
  })();

  /** Items and completed added lines, grouped by category with a subtotal each. */
  const itemGroups = (() => {
    const groups = new Map<number | null, { total: number; count: number }>();
    const add = (key: number | null, amount: number) => {
      const g = groups.get(key) ?? { total: 0, count: 0 };
      g.total += amount;
      g.count += 1;
      groups.set(key, g);
    };
    for (const item of items) add(itemCategories[item.id] ?? null, item.amount);
    for (const a of usableAddedItems) add(a.categoryId, Number(a.amount));
    return [...groups.entries()];
  })();

  /*
   * The camera takes the WHOLE screen — a Modal, not an early return.
   *
   * An early return was the first attempt and it was wrong on a device. This
   * screen sits inside a navigation stack with a "Scan receipt" header and
   * under a tab bar, and returning a view from here renders it BETWEEN them:
   * the viewfinder lost roughly a fifth of its height to chrome, and the
   * receipt guide inside it came out as a small box floating in the middle.
   * The frame then implied the receipt had to fit in a quarter of the screen,
   * which is the opposite of what it is for — a receipt should fill the
   * picture, because resolution is the one thing OCR cannot get back.
   *
   * A Modal escapes both the header and the tab bar without touching
   * navigation options, so nothing has to be restored afterwards — a
   * `setOptions` approach has to put the tab bar back on every exit path, and
   * the one that gets missed leaves the app with no navigation at all.
   *
   * `statusBarTranslucent` lets the preview run under the status bar; the
   * camera's own SafeAreaView keeps the controls clear of it.
   *
   * `onRequestClose` is the Android back button, and it must be handled here.
   * Without it, back dismisses the modal without telling this screen, and
   * `cameraOpen` stays true — so the camera can never be reopened.
   */
  const camera = (
    <Modal
      visible={cameraOpen}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => setCameraOpen(false)}
    >
      {/*
        Mounted only while visible, so the sensor and the torch are not left
        running behind the review form.
      */}
      {cameraOpen ? (
        <ReceiptCamera
          initialSections={sectionsFromPages(pages)}
          onCancel={() => {
            setCameraOpen(false);
            /*
             * Closing the camera with nothing photographed leaves this screen
             * entirely, rather than revealing the capture card behind it.
             *
             * There is nothing on that card worth stopping at: no sections to
             * review, no scan to check — just the "Open the camera" button the
             * owner already pressed. Backing out of a scan should undo the
             * scan, not park them one tap away from starting it again.
             *
             * Sections already captured are the opposite case and are left
             * alone: those are work, and the card is where they get reviewed,
             * reordered and sent.
             */
            if (pages.length === 0 && navigation.canGoBack()) navigation.goBack();
          }}
          onDone={(sections) => {
            setPages(pagesFromSections(sections));
            setCameraOpen(false);
          }}
        />
      ) : null}
    </Modal>
  );

  return (
    <Screen>
      {camera}
      {/*
        Nothing is rendered behind the camera.

        The screen opens straight into it, so anything here would be a card
        flashing up for the length of the modal's fade and then being covered
        — and on the way back out it would appear for an instant before this
        screen pops. Rendering nothing is also rendering nothing to lay out,
        which keeps the preview's first frame from competing with a form for
        the same window insets.
      */}
      {cameraOpen ? null : (
      /*
        The longest form in the app: a review card, then a row per item, then
        the reconciliation question. Typing into a field near the bottom used
        to put it behind the keyboard with no way to scroll it back into view.
        The ScrollView keeps its own contentContainerStyle and paddingBottom —
        this only wraps it, so scrolling behaves exactly as before when no
        keyboard is up.
      */
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
          {!scan ? (
            <Card>
              <T variant="title" style={{ marginBottom: 4 }}>Scan a receipt</T>
              <T variant="caption" style={{ marginBottom: space.lg }}>
                {pages.length === 0
                  ? "Photograph a receipt and FinSight will read the date, store and amount. You check them before anything is saved."
                  : "Add another section only if this receipt didn't fit in one — otherwise scan what you have."}
              </T>

              {busy ? (
                // The OCR wait is the app's slowest interaction — commit to
                // the shape of the answer instead of a bare spinner, same
                // reasoning as web's ScanReceipt read skeleton.
                <View style={{ gap: space.sm, paddingVertical: space.md }}>
                  <T variant="caption" style={{ marginBottom: space.xs }}>Reading the receipt…</T>
                  <SkeletonBox width="40%" height={14} />
                  <SkeletonBox height={14} />
                  <SkeletonBox width="70%" height={14} />
                  <SkeletonBox width="55%" height={14} />
                </View>
              ) : (
                <>
                  {/*
                    The filmstrip, shown once there is something to show. A
                    single photo never reaches this — pressing "Scan this
                    receipt" fires the instant one page exists, same as the
                    old single-tap flow, so the common case gains no step.
                  */}
                  {pages.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        {pages.map((p, i) => (
                          <View key={p.key} style={{ width: 84 }}>
                            <View
                              style={{
                                width: 84,
                                height: 112,
                                borderRadius: radius.sm,
                                overflow: "hidden",
                                backgroundColor: paper[100],
                                borderWidth: 1,
                                borderColor: ink[200],
                              }}
                            >
                              <Image source={{ uri: p.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                              <View
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  left: 4,
                                  backgroundColor: "rgba(255,255,255,0.9)",
                                  borderRadius: radius.full,
                                  paddingHorizontal: 6,
                                  paddingVertical: 1,
                                }}
                              >
                                <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink[700] }}>{i + 1}</T>
                              </View>
                              <Pressable
                                onPress={() => removePage(p.key)}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove page ${i + 1}`}
                                hitSlop={8}
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  width: 22,
                                  height: 22,
                                  borderRadius: radius.full,
                                  backgroundColor: "rgba(255,255,255,0.9)",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Ionicons name="close" size={14} color={ink[700]} />
                              </Pressable>
                              {p.checkingQuality ? (
                                <View style={{ position: "absolute", bottom: 4, right: 4 }}>
                                  <ActivityIndicator size="small" color={brand[600]} />
                                </View>
                              ) : null}
                            </View>
                            {/*
                              Caught at capture, not after the whole session
                              uploads — see addPage's own comment for why that
                              order matters.
                            */}
                            {p.quality?.tooBlurredToTrust ? (
                              <T style={{ fontSize: typeScale.axis, color: statusText.warning, marginTop: 2, textAlign: "center" }}>
                                ⚠ blurry
                              </T>
                            ) : null}
                            <View style={{ flexDirection: "row", justifyContent: "center", gap: 2, marginTop: 2 }}>
                              <Pressable
                                onPress={() => movePage(p.key, -1)}
                                disabled={i === 0}
                                accessibilityRole="button"
                                accessibilityLabel={`Move page ${i + 1} earlier`}
                                hitSlop={8}
                                style={{ padding: 4, opacity: i === 0 ? 0.3 : 1 }}
                              >
                                <Ionicons name="chevron-up" size={16} color={ink[600]} />
                              </Pressable>
                              <Pressable
                                onPress={() => movePage(p.key, 1)}
                                disabled={i === pages.length - 1}
                                accessibilityRole="button"
                                accessibilityLabel={`Move page ${i + 1} later`}
                                hitSlop={8}
                                style={{ padding: 4, opacity: i === pages.length - 1 ? 0.3 : 1 }}
                              >
                                <Ionicons name="chevron-down" size={16} color={ink[600]} />
                              </Pressable>
                            </View>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  ) : null}

                  <View style={{ gap: space.sm }}>
                    {pages.length === 0 ? (
                      <>
                        <Button title="Open the camera" variant="primary" onPress={capturePage} />
                        <Button title="Choose from gallery" variant="secondary" onPress={pickPage} />
                      </>
                    ) : (
                      <>
                        <Button
                          title={
                            pages.length === 1 ? "Scan this receipt" : `Scan these ${pages.length} sections`
                          }
                          variant="primary"
                          onPress={() => void scanPages()}
                        />
                        {/*
                          Reopens the camera on the session already captured,
                          rather than starting an empty one — see
                          sectionsFromPages. Hidden at the ceiling because the
                          server refuses a ninth page, and a button that can
                          only produce a 400 is worse than no button.
                        */}
                        {canAddSection(pages.length) ? (
                          <Button title="Add another section" variant="secondary" onPress={capturePage} />
                        ) : null}
                      </>
                    )}
                  </View>
                </>
              )}
              {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
            </Card>
          ) : (
            <>
              {/*
                THE PHOTOGRAPH FIRST.

                Nearly every sentence on this screen ends in "against the
                photo" — check the amounts against it, check the item names
                against it, check whether it holds two receipts. The photo was
                the one thing the screen never showed. These are the local
                files the capture session produced, so they cost nothing to
                display and are already the exact images that were read.
              */}
              {pages.length > 0 ? (
                <Card>
                  <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
                  <T variant="caption" style={{ marginBottom: space.md }}>
                    {pages.length === 1
                      ? "Compare what FinSight read against the photo. Nothing is saved until you confirm."
                      : `Compare what FinSight read against the ${pages.length} sections. Nothing is saved until you confirm.`}
                  </T>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: "row", gap: space.sm }}>
                      {pages.map((p, i) => (
                        <View
                          key={p.key}
                          style={{
                            width: 96,
                            height: 128,
                            borderRadius: radius.sm,
                            overflow: "hidden",
                            backgroundColor: paper[100],
                            borderWidth: 1,
                            borderColor: ink[200],
                          }}
                        >
                          <Image
                            source={{ uri: p.uri }}
                            style={{ width: "100%", height: "100%" }}
                            resizeMode="cover"
                            accessibilityRole="image"
                            accessibilityLabel={
                              pages.length === 1 ? "The receipt you photographed" : `Section ${i + 1} of ${pages.length}`
                            }
                            accessibilityIgnoresInvertColors
                          />
                          {pages.length > 1 ? (
                            <View
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                backgroundColor: "rgba(255,255,255,0.9)",
                                borderRadius: radius.full,
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                              }}
                            >
                              <T style={{ fontSize: typeScale.micro, fontFamily: font.monoMedium, color: ink[700] }}>{i + 1}</T>
                            </View>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </Card>
              ) : (
                <Card>
                  <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
                  <T variant="caption">
                    FinSight filled these in from the photo. Correct anything that's wrong — nothing is
                    saved until you confirm.
                  </T>
                </Card>
              )}

              <ReviewNotices notices={reviewNotices} />

              <ReviewSection
                title={isItemised ? "Receipt totals" : "This expense"}
                caption={
                  isItemised
                    ? "The date, store and total for the whole receipt. Each line gets its own category below."
                    : undefined
                }
              >
              {!isItemised ? (
                <CategoryPicker
                  categories={categories}
                  value={categoryId}
                  onChange={setCategoryId}
                  onCreated={refreshCategories}
                />
              ) : null}
              <DateField label="Date" value={date} onChange={setDate} />
              <Field
                label="Description"
                value={description}
                maxLength={FIELD_LIMITS.recordDescription}
                onChangeText={setDescription}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => vendorRef.current?.focus()}
              />
              <Field
                ref={vendorRef}
                label="Vendor"
                value={vendor}
                maxLength={FIELD_LIMITS.vendor}
                onChangeText={setVendor}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => amountRef.current?.focus()}
              />
              {/*
                "done" closes the keyboard rather than confirming. Amount is the
                last thing to TYPE but not the last thing to decide — an itemised
                receipt still has a category per line and possibly a difference to
                account for below. A return key that saved here would skip past
                the review this screen exists for.
              */}
              <Field
                ref={amountRef}
                label="Amount (PHP)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />
              </ReviewSection>

              {isItemised ? (
                <ReviewSection
                  title={`Items (${items.length})`}
                  caption={`FinSight ${items.some((i) => i.extractedByVision) ? "found" : "read"} ${items.length} items. Put each one in a category — check them against the photo and change any that are wrong.`}
                >

                  {items.map((item) => (
                    <View
                      key={item.id}
                      /*
                        A rule ABOVE each row and generous padding, rather than
                        a box per item. A receipt can carry a dozen lines and
                        boxing each one turns the list into a stack of cards
                        inside a card; a rule separates them at a fraction of
                        the visual weight.
                      */
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: paper[200],
                        paddingTop: space.md,
                        paddingBottom: space.md,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                        <T style={{ flex: 1, fontSize: typeScale.bodySm, color: ink[900], lineHeight: 20 }} numberOfLines={2}>
                          {item.name}
                          {item.quantity != null ? (
                            <T variant="caption"> × {item.quantity}</T>
                          ) : null}
                        </T>
                        {/*
                          `decimals` is not cosmetic here. Without it
                          toLocaleString ROUNDS to whole pesos, so a 123.50
                          line printed as "PHP 124" — a figure that appears
                          nowhere on the receipt — and a column of them stopped
                          adding up to the total shown above. Whole pesos are
                          right for a summary; they are wrong for a line the
                          owner is checking against paper. Web's own scan
                          review passes it on every amount for this reason.
                        */}
                        <Money value={item.amount} size={14} weight="semibold" decimals />
                        {/* Removing a line OCR should never have read. */}
                        <Pressable
                          onPress={() => removeScannedItem(item.id)}
                          disabled={removingItemId === item.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${item.name} — this was not a purchase`}
                          hitSlop={6}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: radius.full,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: paper[100],
                            opacity: removingItemId === item.id ? 0.4 : 1,
                          }}
                        >
                          {/*
                            An icon rather than a "×" glyph: the glyph rendered
                            at whatever weight the system font gave it, which
                            beside a bold amount read as punctuation rather
                            than as a control.
                          */}
                          <Ionicons name="close" size={13} color={ink[500]} />
                        </Pressable>
                      </View>

                      {/*
                        A line a model inferred from a photograph must not look
                        like one read off text. Marked per row, because the row
                        is where the owner actually decides.
                      */}
                      {item.extractedByVision ? (
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          ✦ AI read this from the photo
                        </T>
                      ) : null}

                      {/*
                        The server names the line it is least sure of when the
                        items do not add up. Pointing at one row beats asking the
                        owner to re-read all nine.
                      */}
                      {scan.suspectItemId === item.id ? (
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          ⚠ Check this one first — the items don't add up to the total
                        </T>
                      ) : typeof item.amountConfidence === "number" && item.amountConfidence < 75 ? (
                        <T variant="caption" style={{ marginTop: 2 }}>
                          FinSight was {item.amountConfidence}% sure of this amount
                        </T>
                      ) : null}

                      <View style={{ marginTop: space.sm }}>
                        <CategoryChips
                          categories={categories}
                          value={itemCategories[item.id] ?? null}
                          // No haptic here: the chip fires its own, and firing a
                          // second would buzz twice for one tap.
                          onChange={(id) => setItemCategories((prev) => ({ ...prev, [item.id]: id }))}
                          label={item.name}
                        />
                      </View>

                      {/*
                        A category FinSight thinks is missing.

                        Phrased as an offer rather than an assignment, because
                        nothing is created until the owner says so — inventing
                        categories in someone's books is not FinSight's call.
                      */}
                      {suggestedNewCategoryFor(item) ? (
                        <Pressable
                          onPress={() => acceptSuggestedCategory(item.suggestedCategoryName!)}
                          disabled={creatingCategoryFor !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Create the category ${item.suggestedCategoryName} and file ${item.name} under it`}
                          style={{ marginTop: space.sm, opacity: creatingCategoryFor !== null ? 0.5 : 1 }}
                        >
                          <T variant="caption" style={{ color: brand[700] }}>
                            {creatingCategoryFor === item.suggestedCategoryName
                              ? "Creating…"
                              : `✦ Nothing fits this. Create "${item.suggestedCategoryName}"?`}
                          </T>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}

                  {/*
                    Lines the owner is adding because OCR missed them.

                    Kept visually distinct from the extracted rows: the text
                    above claims FinSight READ these items, and that claim must
                    not quietly extend to a row a human typed. The same
                    distinction is stored server-side (addedByOwner) so it
                    survives onto the saved record.
                  */}
                  {addedItems.map((added, i) => (
                    <View
                      key={added.key}
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: paper[100],
                        backgroundColor: paper[50],
                        paddingVertical: space.sm,
                        paddingHorizontal: space.sm,
                      }}
                    >
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <T variant="caption">You're adding this line</T>
                        <Pressable
                          onPress={() => setAddedItems((prev) => prev.filter((x) => x.key !== added.key))}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove added item ${i + 1}`}
                          style={{ minWidth: TAP - 12, minHeight: TAP - 16, alignItems: "flex-end" }}
                        >
                          <T style={{ fontSize: typeScale.bodyLg, color: ink[400] }}>×</T>
                        </Pressable>
                      </View>
                      <Field
                        label="Item name"
                        value={added.name}
                        onChangeText={(v: string) =>
                          setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, name: v } : x)))
                        }
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => addedAmountRefs.current[added.key]?.focus()}
                      />
                      <Field
                        ref={(el) => {
                          if (el) addedAmountRefs.current[added.key] = el;
                          else delete addedAmountRefs.current[added.key];
                        }}
                        label="Amount (PHP)"
                        value={added.amount}
                        keyboardType="decimal-pad"
                        // The row ends at its category chips, which are pressables
                        // and cannot be focused from a keyboard — so this closes
                        // the keyboard and leaves the chips visible underneath.
                        returnKeyType="done"
                        onChangeText={(v: string) =>
                          setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, amount: v } : x)))
                        }
                      />
                      <CategoryChips
                        categories={categories}
                        value={added.categoryId}
                        onChange={(id) =>
                          setAddedItems((prev) =>
                            prev.map((x) => (x.key === added.key ? { ...x, categoryId: id } : x)),
                          )
                        }
                        label={added.name || `added item ${i + 1}`}
                      />
                    </View>
                  ))}

                  <Pressable
                    onPress={() =>
                      setAddedItems((prev) => [
                        ...prev,
                        { key: `added-${Date.now()}-${prev.length}`, name: "", amount: "", categoryId: null },
                      ])
                    }
                    accessibilityRole="button"
                    style={{ paddingVertical: space.sm }}
                  >
                    <T variant="caption" style={{ color: brand[700] }}>
                      + An item is missing — add it to the list
                    </T>
                  </Pressable>
                </ReviewSection>
              ) : null}

              {/*
                WHAT ACTUALLY GETS SAVED — one record per category group.

                Its own section, and the last one before the button. It used to
                be a tinted panel at the bottom of the item list, which put the
                answer to "what am I about to agree to" inside the list of
                things being agreed to. It is the only part of this screen that
                describes the OUTCOME rather than the reading.
              */}
              {isItemised ? (
                <Card emphasis>
                  <View>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: space.sm,
                        marginBottom: space.sm,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <T variant="heading" accessibilityRole="header" style={{ color: brand[900] }}>
                          What gets saved
                        </T>
                        {scan.ocrConfidence != null ? (
                          <T variant="caption">Reading confidence {scan.ocrConfidence}%</T>
                        ) : null}
                      </View>
                      {/*
                        Whether the receipt balances, stated as a badge rather
                        than left for the owner to work out by comparing two
                        numbers in different places. Colour is never the only
                        signal — the badge carries a glyph and words.
                      */}
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          paddingHorizontal: space.sm,
                          paddingVertical: 3,
                          borderRadius: radius.full,
                          backgroundColor: gap === 0 ? "#eafaf1" : "#fffbeb",
                        }}
                      >
                        <T
                          style={{
                            fontSize: typeScale.micro,
                            color: gap === 0 ? statusText.good : statusText.warning,
                          }}
                        >
                          {gap === 0
                            ? "✓ Balances"
                            : `⚠ ${gap > 0 ? "Short" : "Over"} PHP ${(Math.abs(gap) / 100).toFixed(2)}`}
                        </T>
                      </View>
                    </View>
                    {itemGroups.map(([catId, g]) => (
                      <View
                        key={String(catId)}
                        style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm, marginTop: 2 }}
                      >
                        <T style={{ flex: 1, fontSize: typeScale.label, color: catId == null ? statusText.warning : ink[700] }}>
                          {catId == null
                            ? "Not categorised yet"
                            : (categories.find((c) => c.id === catId)?.name ?? "Category")}
                          <T variant="caption"> ({g.count} item{g.count === 1 ? "" : "s"})</T>
                        </T>
                        <Money value={g.total} size={13} decimals />
                      </View>
                    ))}
                    <T
                      variant="caption"
                      style={{ marginTop: space.sm, color: everyItemHasCategory && planResolved ? statusText.good : statusText.warning }}
                    >
                      {!everyItemHasCategory
                        ? "⚠ Every item needs a category before this can be saved."
                        : gap === 0
                          ? `✓ ${itemGroups.length} record${itemGroups.length === 1 ? "" : "s"} will be saved, adding up to the receipt total.`
                          : plan === "shrink"
                            ? `✓ The receipt will be saved as PHP ${itemsTotal.toFixed(2)} — the items' own total.`
                            : planResolved
                              ? "✓ Ready to save."
                              : gap > 0
                                ? `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(gap / 100).toFixed(2)} less than the total above.`
                                : `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(-gap / 100).toFixed(2)} more than the total above.`}
                    </T>
                  </View>

                  {/*
                    Accounting for the difference.

                    A gap is normal rather than a mistake: a VAT-exclusive
                    register adds tax on top of the printed lines, a discount
                    takes money off, and OCR sometimes just misses a line. So the
                    screen asks what the difference IS instead of blocking until
                    the arithmetic works — which, on a VAT-exclusive receipt, it
                    never would. The total never changes on its own; only the
                    last option touches it, and only to figures read off the
                    receipt.
                  */}
                  {everyItemHasCategory && gap !== 0 ? (
                    <View style={{ marginTop: space.md }}>
                      <T variant="label" style={{ color: ink[700], marginBottom: 4 }}>
                        {gap > 0
                          ? `What is the missing PHP ${(gap / 100).toFixed(2)}?`
                          : `What is the extra PHP ${(-gap / 100).toFixed(2)}?`}
                      </T>
                      <T variant="caption" style={{ marginBottom: space.sm }}>
                        {gap > 0
                          ? "Receipts often add tax or a service charge on top of the item prices, and sometimes a line just doesn't scan."
                          : "A discount or a voided line usually explains this."}
                      </T>

                      <GapOption
                        selected={plan === "proportional"}
                        onPress={() => {
                          haptics.tapped();
                          setPlan("proportional");
                        }}
                        title={gap > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
                        detail="Split across the categories above, in proportion to what each came to. Keeps every category's spending accurate."
                      />
                      {canFileGapOnItsOwn ? (
                        <GapOption
                          selected={plan === "category"}
                          onPress={() => {
                            haptics.tapped();
                            setPlan("category");
                          }}
                          title="A separate charge to track on its own"
                          detail="Saved as its own expense record under one category."
                        >
                          {plan === "category" ? (
                            <View style={{ marginTop: space.sm }}>
                              <CategoryChips
                                categories={categories}
                                value={gapCategoryId}
                                onChange={setGapCategoryId}
                                label="the remaining amount"
                              />
                            </View>
                          ) : null}
                        </GapOption>
                      ) : null}
                      <GapOption
                        selected={plan === "shrink"}
                        onPress={() => {
                          haptics.tapped();
                          setPlan("shrink");
                        }}
                        title="FinSight misread the receipt total"
                        detail={`Save PHP ${itemsTotal.toFixed(2)} — the items' own total — instead of the amount above.`}
                      />
                    </View>
                  ) : null}
                </Card>
              ) : null}

              {/*
                The actions sit outside the sections rather than at the end of
                the last one. They apply to the whole review, and putting them
                inside "Items" made them look like part of the item list — on
                a long receipt they arrived after nine category pickers with
                nothing to say they had left that subject.
              */}
              <View>
                {error ? <View style={{ marginBottom: space.sm }}><ErrorNote>{error}</ErrorNote></View> : null}
                <Button
                  title={
                    isItemised && itemGroups.length > 1
                      ? `Save ${itemGroups.length} expenses`
                      : "Save this expense"
                  }
                  variant="primary"
                  onPress={confirm}
                  loading={busy}
                />
                <Button
                  title="Retake photo"
                  variant="ghost"
                  onPress={() => {
                    setScan(null);
                    // Rescan is a deliberate "start over" — the captured pages
                    // belonged to the receipt just reviewed, and carrying them
                    // into a new session would mean the next scan quietly
                    // starts with photos of the WRONG receipt already loaded.
                    setPages([]);
                  }}
                />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------- CSV import

export function ImportCsvScreen({ navigation }: any) {
  const { selected, categories } = useBusinessProfiles();
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  /**
   * The rows the preview returned, kept so the screen can say which category
   * names in the file this business does not have yet. Previously only
   * `headers` was read off the same response and the rows were discarded.
   */
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [mapping, setMapping] = useState({ date: "", description: "", amount: "", category: "", recordType: "" });
  /**
   * What the file is read as. Mobile could previously only import expenses —
   * `recordType` was hardcoded — so a phone could not bring in sales history at
   * all, and a combined sheet had to be split on a computer first.
   */
  const [recordType, setRecordType] = useState<"expense" | "sales" | "mixed">("expense");
  const [mixedStrategy, setMixedStrategy] = useState<"column" | "sign">("column");
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!selected) return null;

  const isMixed = recordType === "mixed";
  const usesCategory = recordType === "expense" || isMixed;

  /**
   * What each previewed row becomes, using the SAME readers the server will —
   * so the label against a row and the record it turns into cannot disagree.
   * `null` means the file does not say, and those rows are skipped rather than
   * guessed.
   */
  const previewRowTypes: (RowRecordType | null)[] | null = !isMixed
    ? null
    : previewRows.map((row) => {
        if (mixedStrategy === "sign") {
          const amount = mapping.amount ? parseSignedAmount(row[mapping.amount]) : null;
          if (amount === null || amount === 0) return null;
          return amount < 0 ? "expense" : "sales";
        }
        return mapping.recordType ? classifyTypeValue(row[mapping.recordType]) : null;
      });

  const typeSplit = previewRowTypes
    ? {
        sales: previewRowTypes.filter((t) => t === "sales").length,
        expenses: previewRowTypes.filter((t) => t === "expense").length,
        unknown: previewRowTypes.filter((t) => t === null).length,
      }
    : null;

  /**
   * Category names in the file that this business does not have yet.
   *
   * WHY THIS IS WORTH SAYING OUT LOUD: confirmImport CREATES every category
   * name it cannot match (resolveCategories), silently. That is the right
   * behaviour — an import must not fail because a category does not exist
   * yet — but it means one typo becomes a permanent second category. A file
   * reading "Inventroy" against a business that already has "Inventory"
   * imports perfectly cleanly, and the owner finds the near-duplicate weeks
   * later in a report that has quietly split their stock spending in two.
   *
   * Matched case-insensitively because resolveCategories matches that way; a
   * warning that flagged "inventory" as new when the server will match it to
   * "Inventory" would be a lie about what is about to happen.
   *
   * Computed from the rows on screen, not the whole file, which is why the
   * callout says so whenever the preview is truncated — a category first
   * appearing at row 300 of a 500-row file is not something this can see.
   */
  const newCategoryNames = (() => {
    if (!mapping.category) return [];
    const existing = new Set(categories.map((c) => c.name.trim().toLowerCase()));
    const seen = new Map<string, string>();
    for (const row of previewRows) {
      const raw = row[mapping.category]?.trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      // Deduplicated on the same key resolveCategories uses, so a file
      // spelling it "Inventory" and "inventory" reports one new category
      // rather than two — which is also what the server will create.
      if (!existing.has(key) && !seen.has(key)) seen.set(key, raw);
    }
    return [...seen.values()];
  })();

  function formFor(f: DocumentPicker.DocumentPickerAsset) {
    const form = new FormData();
    form.append("file", { uri: f.uri, name: f.name, type: "text/csv" } as any);
    return form;
  }

  async function pick() {
    const res = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "*/*"] });
    if (res.canceled || !res.assets?.[0]) return;
    const f = res.assets[0];
    setFile(f);
    setBusy(true);
    setError(null);
    try {
      const preview = await api.upload<{
        headers: string[];
        previewRows: Record<string, string>[];
        totalRows: number;
        detectedTypeColumn?: string | null;
        columnsWithNegatives?: string[];
      }>("/records/csv-imports/preview", formFor(f));
      setHeaders(preview.headers);
      setPreviewRows(preview.previewRows ?? []);
      setTotalRows(preview.totalRows ?? 0);
      // Best-effort auto-match, so the common case needs no tapping at all.
      const guess = (want: RegExp) => preview.headers.find((h) => want.test(h)) ?? "";
      const detectedType = preview.detectedTypeColumn ?? "";
      const amountCol = guess(/amount|cash|total/i);
      /*
       * A detected type column takes itself back from `category`, whose guess
       * matches /type/ — otherwise a Sale/Expense column would be imported as
       * category names and quietly create categories called "Sale" and
       * "Expense".
       */
      const categoryGuess = guess(/categ|class|type/i);
      setMapping({
        date: guess(/date/i),
        description: guess(/desc|particular|item/i),
        amount: amountCol,
        category: categoryGuess === detectedType ? "" : categoryGuess,
        recordType: detectedType,
      });

      // Offered, not applied silently: the owner still sees the choice, and
      // every row is labelled below before anything is written.
      if (detectedType) {
        setRecordType("mixed");
        setMixedStrategy("column");
      } else if (amountCol && (preview.columnsWithNegatives ?? []).includes(amountCol)) {
        setRecordType("mixed");
        setMixedStrategy("sign");
      } else {
        setRecordType("expense");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = formFor(file);
      form.append("businessProfileId", String(selected!.id));
      form.append("recordType", recordType);
      if (isMixed) form.append("mixedStrategy", mixedStrategy);
      form.append("title", file.name);
      // Optional fields are omitted rather than sent empty — the server's
      // schema takes them as absent, not as "".
      form.append(
        "columnMapping",
        JSON.stringify({
          date: mapping.date,
          description: mapping.description,
          amount: mapping.amount,
          ...(usesCategory && mapping.category ? { category: mapping.category } : {}),
          ...(isMixed && mixedStrategy === "column" && mapping.recordType
            ? { recordType: mapping.recordType }
            : {}),
        }),
      );
      setResult(await api.upload<any>("/records/csv-imports/confirm", form));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <Card>
          <T variant="title" style={{ marginBottom: 4 }}>Import a spreadsheet</T>
          <T variant="caption" style={{ marginBottom: space.lg }}>
            Bring in sales and expenses from a CSV you already keep — one file can hold both.
          </T>

          {result ? (
            <View style={{ gap: space.sm }}>
              <T style={{ fontSize: typeScale.body }}>
                Imported {result.imported} of {result.totalRows} rows.
                {result.importedExpenses > 0 && result.importedSales > 0
                  ? ` ${result.importedExpenses} as expenses, ${result.importedSales} as sales.`
                  : ""}
              </T>
              {result.uncategorised > 0 ? (
                <Callout tone="info">
                  {result.uncategorised} expense(s) had no category and went into "Uncategorised".
                  They're imported and counted — sorting them is what makes them show up in your
                  spending breakdown.
                </Callout>
              ) : null}
              {result.skipped?.length ? (
                <AlertBanner kind="needs-review" label="Some rows were skipped">
                  {result.skipped.map((s: any) => `Row ${s.row}: ${s.reason}`).join("\n")}
                </AlertBanner>
              ) : null}
              {result.flagged > 0 ? (
                <AlertBanner kind="duplicate">{result.flagged} row(s) look like possible duplicates.</AlertBanner>
              ) : null}
              {result.largeExpenseFlagged > 0 ? (
                <AlertBanner kind="large-expense">
                  {result.largeExpenseFlagged} row(s) were flagged as large expenses.
                </AlertBanner>
              ) : null}
              <Button title="Done" variant="primary" onPress={() => navigation.goBack()} />
            </View>
          ) : !file ? (
            <Button title="Choose a CSV file" variant="primary" onPress={pick} />
          ) : busy && headers.length === 0 ? (
            // Reading and mapping-guessing the file, before there's a mapping
            // screen to show — same reasoning as web's ImportCsv read
            // skeleton: commit to the shape of the mapping list about to
            // appear rather than leaving a bare spinner up.
            <View style={{ gap: space.md }}>
              <T variant="caption">Reading {file.name}…</T>
              <SkeletonList count={4} />
            </View>
          ) : (
            <View>
              <T variant="label" style={{ marginBottom: space.sm }}>{file.name}</T>
              <T variant="caption" style={{ marginBottom: space.md }}>
                Match your columns to FinSight's fields.
              </T>

              <T variant="label" style={{ marginBottom: 4 }}>
                Import as
              </T>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
                {(
                  [
                    ["expense", "Expenses"],
                    ["sales", "Sales"],
                    ["mixed", "Both in one file"],
                  ] as const
                ).map(([value, label]) => (
                  <SelectChip
                    key={value}
                    label={label}
                    selected={recordType === value}
                    onPress={() => setRecordType(value)}
                  />
                ))}
              </View>

              {/*
                Asked as a question about the FILE, not about FinSight: an owner
                knows whether their sheet has a "type" column or writes expenses
                with a minus sign; they do not know what a "strategy" is.
              */}
              {isMixed ? (
                <>
                  <T variant="label" style={{ marginBottom: 4 }}>
                    How does your file say which is which?
                  </T>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
                    <SelectChip
                      label={'A column says "sale" or "expense"'}
                      selected={mixedStrategy === "column"}
                      onPress={() => setMixedStrategy("column")}
                    />
                    <SelectChip
                      label="Expenses are negative (−)"
                      selected={mixedStrategy === "sign"}
                      onPress={() => setMixedStrategy("sign")}
                    />
                  </View>

                  {/*
                    The count is the check. A file the owner believes is half
                    sales that reads as all sales is a mapping mistake they can
                    see here in a second, rather than in their dashboard a week
                    later.
                  */}
                  {typeSplit ? (
                    <View style={{ marginBottom: space.md }}>
                      <Callout tone={typeSplit.unknown > 0 ? "warn" : "info"}>
                        {previewRows.length < totalRows
                          ? `In the first ${previewRows.length} rows: `
                          : "In this file: "}
                        {typeSplit.sales} sales · {typeSplit.expenses} expenses
                        {typeSplit.unknown > 0
                          ? ` · ${typeSplit.unknown} unrecognised. Rows FinSight can't read a type from are skipped, never guessed.`
                          : "."}
                      </Callout>
                    </View>
                  ) : null}
                </>
              ) : null}

              {(
                [
                  "date",
                  "description",
                  "amount",
                  // Sales rows carry no category, and a mixed file's expense
                  // rows fall back to "Uncategorised" when the column is absent.
                  ...(usesCategory ? (["category"] as const) : []),
                  ...(isMixed && mixedStrategy === "column" ? (["recordType"] as const) : []),
                ] as const
              ).map((field) => (
                <View key={field} style={{ marginBottom: space.md }}>
                  {/* Named for the owner, not for the payload key — "recordType"
                      through `capitalize` reads "Recordtype". */}
                  <T variant="label" style={{ marginBottom: 4, textTransform: "capitalize" }}>
                    {field === "recordType" ? "Sale or expense column" : field}
                  </T>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    {headers.map((h) => (
                      <SelectChip
                        key={h}
                        label={h}
                        selected={mapping[field] === h}
                        onPress={() => setMapping((m) => ({ ...m, [field]: h }))}
                        // Every column name appears once per field, so the
                        // chip has to say which field it would fill —
                        // otherwise four identical "Amount" chips read out
                        // identically.
                        accessibilityLabel={`${h}, for ${field}`}
                      />
                    ))}
                  </View>
                </View>
              ))}
              {/*
                What this import will ADD, not just what it will bring in.

                Creating a category is a side effect the owner never asked
                for and previously never saw — they asked to import expenses
                and got new entries in a list they curate elsewhere. Naming
                them here makes a typo obvious while the mapping can still be
                changed, which is the only moment it is cheap to fix.

                An observation, never a blocker: a genuinely new category is
                the normal case for a first import.
              */}
              {newCategoryNames.length > 0 ? (
                <View style={{ marginBottom: space.md }}>
                  <Callout tone="info">
                    This import will create {newCategoryNames.length} new categor
                    {newCategoryNames.length === 1 ? "y" : "ies"}: {newCategoryNames.join(", ")}.
                    {previewRows.length < totalRows
                      ? ` That is from the ${previewRows.length} rows checked — later rows may add more.`
                      : ""}{" "}
                    If one is a misspelling of a category you already have, change the Category column above,
                    or you'll end up with two categories for the same thing.
                  </Callout>
                </View>
              ) : null}
              {error ? <ErrorNote>{error}</ErrorNote> : null}
              <Button
                title="Import these rows"
                variant="primary"
                onPress={confirm}
                loading={busy}
                disabled={
                  !mapping.date ||
                  !mapping.description ||
                  !mapping.amount ||
                  // Required only for a pure expense import: a mixed file may
                  // legitimately have no category column at all.
                  (recordType === "expense" && !mapping.category) ||
                  (isMixed && mixedStrategy === "column" && !mapping.recordType)
                }
                style={{ marginTop: space.sm }}
              />
              {/* The insert is a batch write over every row, not instant for
                  a large file — the button's own spinner covers the tap
                  feedback, this covers the wait. */}
              {busy ? (
                <View style={{ marginTop: space.md }}>
                  <T variant="caption" style={{ marginBottom: space.sm }}>Importing your records…</T>
                  <SkeletonCard style={{ height: 90 }} />
                </View>
              ) : null}
              <Button
                title="Choose a different file"
                variant="ghost"
                onPress={() => {
                  setFile(null);
                  setHeaders([]);
                  // Cleared with the file they describe — leaving them behind
                  // would let the next file's callout be computed from the
                  // previous file's rows.
                  setPreviewRows([]);
                  setTotalRows(0);
                }}
              />
            </View>
          )}
          {error && !file ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
        </Card>
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Edit a record

/**
 * Editing and deleting a record the owner already saved.
 *
 * This screen was NAVIGATED TO but never existed: every card on the records
 * list called navigate("EditRecord") while no such screen was registered, so
 * tapping a record silently did nothing and a typo was permanent on mobile.
 * The list's tap affordance has been pointing at this for a while.
 *
 * The record travels in the route params rather than being re-fetched. The
 * list already holds the whole object, so refetching would trade an instant
 * render for a spinner and gain nothing — web fetches only because its URL
 * carries an id and nothing else.
 */
export function EditRecordScreen({ route, navigation }: any) {
  const { selected, categories, refreshCategories } = useBusinessProfiles();
  const record: RecordItem = route.params.record;
  const isExpense = record.type === "expense";
  // The same test the list applies before it offers the swipe, so a record
  // that can be resolved by gesture can be resolved by tap and vice versa.
  const needsResolving = record.reviewStatus === "Needs Review" || record.duplicateStatus === "Flagged";

  const [categoryId, setCategoryId] = useState<number | null>(record.categoryId ?? null);
  const [date, setDate] = useState(record.date.slice(0, 10));
  const [description, setDescription] = useState(record.description);
  const [vendor, setVendor] = useState(record.vendor ?? "");
  const [amount, setAmount] = useState(String(record.amount));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Vendor only exists on an expense — a sales record has no such field
   * server-side, so it is not rendered at all. The chain therefore has to be
   * decided at hand-off time rather than written down once: on an expense
   * Description goes to Vendor, on a sales record it goes straight to Amount.
   * A chain hard-wired to `vendorRef` would simply dead-end on half the
   * records this screen opens, with the return key doing nothing.
   */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);
  const afterDescription = () => (isExpense ? vendorRef : amountRef).current?.focus();

  /**
   * Where this record came from.
   *
   * Only the single-record endpoint carries it, so it is fetched here rather
   * than travelling in the route params with the rest of the record. A
   * failure is silent: the panel is context, and losing it should degrade the
   * screen rather than block editing.
   */
  const [origin, setOrigin] = useState<RecordOrigin | null>(null);
  const [loadingOrigin, setLoadingOrigin] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const detail = await api.get<{ origin: RecordOrigin | null }>(
            recordUpdatePath(record.type, record.id),
          );
          if (!cancelled) setOrigin(detail.origin ?? null);
        } catch {
          // Context only — a record with no visible provenance is still fully
          // editable, which is what this screen is for.
        } finally {
          if (!cancelled) setLoadingOrigin(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [record.type, record.id]),
  );

  if (!selected) return null;

  async function save() {
    const value = Number(amount);
    if (!description.trim()) return setError("Give this record a description.");
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (isExpense && !categoryId) return setError("Choose a category first.");

    setError(null);
    setBusy(true);
    try {
      const input = { date, description, amount: value, categoryId, vendor };
      await api.patch(
        recordUpdatePath(record.type, record.id),
        // Expense and sales take DIFFERENT fields — a sales record has no
        // category and no vendor server-side. Built in lib/recordUpdate so
        // that distinction is tested rather than remembered.
        isExpense ? buildExpenseUpdatePayload(input) : buildSalesUpdatePayload(input),
      );
      haptics.succeeded();
      setFlash("Record updated.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Clearing a flag without the swipe.
   *
   * On the list this is a left-swipe, which is a gesture some owners cannot
   * make at all — with a screen reader driving the phone there is nothing to
   * swipe. The review queue offers the same action, but only for the records
   * `/records/flagged` hands back; this screen opens for every record, which
   * makes it the one place the alternative works for all of them. The gesture
   * stays exactly as it was: this is a second route to the action, not a
   * replacement for the first.
   */
  async function resolve() {
    setError(null);
    setBusy(true);
    try {
      // The identical patch the swipe action and the review queue both send.
      await api.patch(recordUpdatePath(record.type, record.id), {
        duplicateStatus: "Not a Duplicate",
        reviewStatus: "Reviewed",
      });
      haptics.succeeded();
      // Word for word what the list says when the swipe does this, so the app
      // does not describe one action two ways.
      setFlash("Marked reviewed and not a duplicate.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
      // Only on failure: the success path has already left this screen.
      setBusy(false);
    }
  }

  /**
   * Deleting asks first, through the platform's own dialog.
   *
   * Web offers an undo toast instead; mobile has no toast system yet, so the
   * confirmation comes BEFORE the deletion rather than the reprieve after it.
   * Either way the owner gets one chance to stop — what must not happen is a
   * tap that destroys a record with neither.
   */
  function confirmDelete() {
    RNAlert.alert(
      "Delete this record?",
      `"${record.description}" will be removed. This cannot be undone.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await api.delete(recordUpdatePath(record.type, record.id));
              haptics.committed();
              // A deletion leaves the screen the same way a save does, and the
              // record it removed is gone from the list behind it — so without
              // a line here the only evidence is an absence.
              setFlash("Record deleted.");
              navigation.goBack();
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>
              {isExpense ? "Edit expense" : "Edit sales"}
            </T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              {RECORD_SOURCE_LABELS[record.source as RecordSource] ?? record.source} ·{" "}
              {record.date.slice(0, 10)}
            </T>

            {badges(record)}

            {/*
              The evidence behind this record — the lines read off the receipt,
              or the file it was imported from. Fetched rather than passed in
              route params, because the list endpoint does not carry it.
            */}
            {origin ? (
              <View style={{ marginTop: space.md }}>
                <RecordOriginPanel origin={origin} recordAmount={record.amount} />
              </View>
            ) : loadingOrigin ? (
              <View style={{ marginTop: space.md }}>
                <T variant="caption">Loading where this came from…</T>
              </View>
            ) : null}

            <View style={{ marginTop: space.md }}>
              {isExpense ? (
                <CategoryPicker
                  categories={categories}
                  value={categoryId}
                  onChange={setCategoryId}
                  onCreated={refreshCategories}
                />
              ) : null}
              <DateField label="Date" value={date} onChange={setDate} />
              <Field
                label="Description"
                value={description}
                maxLength={FIELD_LIMITS.recordDescription}
                onChangeText={setDescription}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={afterDescription}
              />
              {isExpense ? (
                <Field
                  ref={vendorRef}
                  label="Vendor"
                  value={vendor}
                  maxLength={FIELD_LIMITS.vendor}
                  onChangeText={setVendor}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => amountRef.current?.focus()}
                />
              ) : null}
              {/* Decimal keypad: the return key exists on Android only. */}
              <Field
                ref={amountRef}
                label="Amount (PHP)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (!busy) save();
                }}
              />
            </View>

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <Button title="Save changes" variant="primary" onPress={save} loading={busy} style={{ marginTop: space.md }} />
            {/*
              Offered only when there is something to clear — the badges above
              are what it answers, and with none of them showing the button
              would be a control for a state the record is not in.
            */}
            {needsResolving ? (
              <Button title="Looks right — mark reviewed" variant="ghost" onPress={resolve} disabled={busy} />
            ) : null}
            <Button title="Delete record" variant="ghost" onPress={confirmDelete} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Flagged review

/** A past CSV import, used only to name a group of duplicates. */
interface ImportBatchSummary {
  id: number;
  title: string;
  uploadDate: string;
  status: string;
}

interface DuplicateGroup {
  key: string;
  /** The batch these came in on, when they all did. */
  batch: ImportBatchSummary | null;
  records: RecordItem[];
}

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
  const { selected, categories } = useBusinessProfiles();
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    try {
      // Together rather than in sequence: the batch list only supplies names
      // for the groups below, so waiting for one before asking for the other
      // would delay the screen for no reason.
      const [flagged, importBatches] = await Promise.all([
        api.get<RecordItem[]>("/records/flagged", { businessProfileId: selected.id }),
        api
          .get<ImportBatchSummary[]>("/records/csv-imports/batches", { businessProfileId: selected.id })
          // A group that cannot name its import still works — it just says
          // "an import" instead of the file's title.
          .catch(() => [] as ImportBatchSummary[]),
      ]);
      setRecords(flagged);
      setBatches(importBatches);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selected?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function resolve(r: RecordItem) {
    const path = r.type === "expense" ? `/records/expenses/${r.id}` : `/records/sales/${r.id}`;
    await api.patch(path, { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" });
    await load();
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
    if (!selected) return;
    const count = group.records.length;

    const run = async () => {
      setBusyKey(group.key);
      try {
        const res = await api.post<{ resolved: number }>("/records/duplicates/resolve", {
          businessProfileId: selected.id,
          action,
          expenseIds: group.records.filter((r) => r.type === "expense").map((r) => r.id),
          salesIds: group.records.filter((r) => r.type === "sales").map((r) => r.id),
        });
        action === "discard" ? haptics.warned() : haptics.succeeded();
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
        haptics.failed();
        setError(errorMessage(err));
      } finally {
        setBusyKey(null);
      }
    };

    if (action === "keep") {
      await run();
      return;
    }

    RNAlert.alert(
      `Discard ${count} record${count === 1 ? "" : "s"}?`,
      `This deletes ${count === 1 ? "this copy" : `these ${count} copies`} for good. The original ` +
        `record${count === 1 ? "" : "s"} they duplicate ${count === 1 ? "is" : "are"} not flagged and ` +
        `${count === 1 ? "stays" : "stay"} exactly as ${count === 1 ? "it is" : "they are"}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: `Discard ${count}`, style: "destructive", onPress: () => void run() },
      ],
    );
  }

  if (!selected) return null;

  const duplicates = records.filter((r) => r.duplicateStatus === "Flagged");
  const others = records.filter((r) => r.duplicateStatus !== "Flagged");
  const { byImport, byMatch } = groupDuplicates(duplicates, batches);

  const renderGroup = (group: DuplicateGroup) => {
    const count = group.records.length;
    const first = group.records[0]!;
    return (
      <Card key={group.key} style={{ marginBottom: space.sm }}>
        {group.batch ? (
          <>
            <T style={{ fontFamily: font.sansMedium }}>{group.batch.title}</T>
            <T variant="caption">
              Imported {group.batch.uploadDate.slice(0, 10)} · {count} possible duplicate
              {count === 1 ? "" : "s"}
            </T>
          </>
        ) : (
          <>
            <T style={{ fontFamily: font.sansMedium }}>{first.description}</T>
            <T variant="caption">
              {first.date.slice(0, 10)} · {count} cop{count === 1 ? "y" : "ies"}
            </T>
          </>
        )}

        <View style={{ marginTop: space.sm }}>
          <Callout tone="warn">
            {group.batch
              ? "Every record here repeats one you already had — which usually means this file was imported twice. Discarding them leaves the records you already had untouched."
              : `${count === 1 ? "This record has" : `These ${count} records have`} the same date, amount and description as a record you already had. Discarding ${count === 1 ? "it leaves" : "them leaves"} the original untouched.`}
          </Callout>
        </View>

        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
          <View style={{ flex: 1 }}>
            <Button
              title={count === 1 ? "Keep it" : `Keep all ${count}`}
              variant="secondary"
              disabled={busyKey === group.key}
              onPress={() => void resolveGroup(group, "keep")}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={count === 1 ? "Discard it" : `Discard all ${count}`}
              variant="danger"
              disabled={busyKey === group.key}
              onPress={() => void resolveGroup(group, "discard")}
            />
          </View>
        </View>
      </Card>
    );
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <T variant="title" style={{ marginBottom: space.md }}>Records to review</T>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {loading ? (
          <ActivityIndicator color={brand[600]} />
        ) : records.length === 0 ? (
          <EmptyState
            title="Nothing needs your attention"
            icon="✓"
            body="FinSight flags possible duplicates and unusually large expenses here as you record them."
          />
        ) : (
          <>
            {byImport.length > 0 ? (
              <>
                <T variant="label" style={{ marginBottom: space.sm }}>Duplicates from an imported file</T>
                {byImport.map(renderGroup)}
              </>
            ) : null}

            {byMatch.length > 0 ? (
              <>
                <T variant="label" style={{ marginTop: space.md, marginBottom: space.sm }}>Possible duplicates</T>
                {byMatch.map(renderGroup)}
              </>
            ) : null}

            {others.length > 0 ? (
              <>
                <T variant="label" style={{ marginTop: space.md, marginBottom: space.sm }}>Other records to check</T>
                {others.map((r) => (
                  <Card key={`${r.type}-${r.id}`} style={{ marginBottom: space.sm }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
                      <View style={{ flex: 1 }}>
                        <T style={{ fontFamily: font.sansMedium }}>{r.description}</T>
                        <T variant="caption">{r.date.slice(0, 10)} · {categories.find((c) => c.id === r.categoryId)?.name ?? r.type}</T>
                      </View>
                      <Money value={r.amount} size={15} weight="semibold" />
                    </View>
                    {badges(r)}
                    <Button title="Looks right — mark reviewed" variant="secondary" onPress={() => resolve(r)} style={{ marginTop: space.md }} />
                  </Card>
                ))}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
