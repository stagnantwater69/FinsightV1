import { useCallback, useState } from "react";
import { ActivityIndicator, Alert as RNAlert, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, EmptyState, ErrorNote, Money, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import { setFlash } from "../../lib/flash";
import * as haptics from "../../lib/haptics";
import { font, space } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import type { RecordItem } from "../../lib/types";
import { badges, type ImportBatchSummary } from "./shared";

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
  const { brand } = t;
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
  }, [selected]);

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
