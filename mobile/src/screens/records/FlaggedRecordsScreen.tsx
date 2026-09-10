import { useCallback, useState } from "react";
import { ActivityIndicator, Alert as RNAlert, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, EmptyState, ErrorNote, Money, Screen, T } from "../../components/ui";
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
import * as haptics from "../../lib/haptics";
import { font, space } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import type { FlaggedRecordCount, FlaggedRecordsPage, RecordItem } from "../../lib/types";
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
  const [records, setRecords] = useState<RecordItem[]>([]);
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
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** A failed resolve — reassures about the record, not about the list's age. */
  const [error, setError] = useState<string | null>(null);
  /** A failed "Load more" — sits with the button, not over the whole screen. */
  const [moreError, setMoreError] = useState<string | null>(null);
  /** A failed fetch of the review queue. See lib/connectionState.ts. */
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setClock(Date.now());
    try {
      // Together rather than in sequence: the batch list only supplies names
      // for the groups below, so waiting for one before asking for the other
      // would delay the screen for no reason.
      const [page, importBatches, count] = await Promise.all([
        api.get<FlaggedRecordsPage>("/records/flagged", {
          businessProfileId: selected.id,
          limit: PAGE_SIZE,
        }),
        api
          .get<ImportBatchSummary[]>("/records/csv-imports/batches", { businessProfileId: selected.id })
          // A group that cannot name its import still works — it just says
          // "an import" instead of the file's title.
          .catch(() => [] as ImportBatchSummary[]),
        // Swallowed like the batches: the queue itself is usable without the
        // headline number, and an error banner over a list that loaded fine
        // would be the bigger problem.
        api
          .get<FlaggedRecordCount>("/records/flagged/count", { businessProfileId: selected.id })
          .catch(() => null),
      ]);
      setRecords(page.items);
      setNextCursor(page.nextCursor);
      setFlaggedTotal(count ? count.total : null);
      setBatches(importBatches);
      setLoadedAt(Date.now());
      setLoadFailure(null);
    } catch (err) {
      setLoadFailure(toLoadFailure(err));
    } finally {
      setLoading(false);
    }
  }, [selected]);

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
    if (!selected || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get<FlaggedRecordsPage>("/records/flagged", {
        businessProfileId: selected.id,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setRecords((current) => {
        const seen = new Set(current.map(recordKey));
        return [...current, ...page.items.filter((r) => !seen.has(recordKey(r)))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setMoreError(describeActionFailure(toLoadFailure(err), "The records already listed are still here."));
    } finally {
      setLoadingMore(false);
    }
  }, [selected, nextCursor, loadingMore]);

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
        haptics.failed();
        setError(describeActionFailure(toLoadFailure(err), "These records are still waiting for review."));
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
        <T variant="title" style={{ marginBottom: flaggedTotal === null ? space.md : space.xs }}>Records to review</T>
        {/*
          The headline count comes from /records/flagged/count, not from
          records.length — one page is not the whole queue, and saying "3"
          while 400 wait behind a cursor would be a wrong number about the
          owner's own books.
        */}
        {flaggedTotal !== null && flaggedTotal > 0 ? (
          <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.md, color: ink[500] }}>
            {flaggedTotal} record{flaggedTotal === 1 ? "" : "s"} flagged
            {records.length < flaggedTotal ? ` · showing ${records.length}` : ""}
          </T>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <ConnectionNotice
          notice={describeLoadFailure(loadFailure, {
            hasData: records.length > 0,
            lastUpdatedAt: loadedAt,
            now: clock,
            subject: "the records to review",
          })}
          onRetry={load}
          busy={loading}
          style={{ marginBottom: space.md }}
        />

        {records.length > 0 ? (
          <LastUpdated at={loadedAt} now={clock} style={{ marginBottom: space.sm }} />
        ) : null}

        {loading ? (
          <ActivityIndicator color={brand[600]} />
        ) : records.length === 0 && loadFailure ? (
          /*
            Same reason as Notifications: "Nothing needs your attention" over a
            failed fetch is an all-clear this screen has no grounds to give.
          */
          null
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

            {nextCursor ? (
              <Card style={{ marginTop: space.xs }}>
                {moreError ? <ErrorNote>{moreError}</ErrorNote> : null}
                <T
                  variant="caption"
                  accessibilityLiveRegion="polite"
                  style={{ textAlign: "center", color: ink[500], marginBottom: space.sm }}
                >
                  Showing {records.length}
                  {flaggedTotal !== null ? ` of ${flaggedTotal}` : ""}
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
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
