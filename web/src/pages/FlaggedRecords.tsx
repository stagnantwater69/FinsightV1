import { useEffect, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { ImportBatchSummary, RecordItem } from "../lib/types";
import { Link } from "react-router-dom";
import type { BusinessProfile } from "../lib/types";
import { Card, PageHead } from "../components/ui";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { FormError } from "../components/Field";
import { Money } from "../components/Money";
import { SkeletonRows } from "../components/Skeleton";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";

/**
 * Why a record was flagged, stated in the owner's own numbers.
 *
 * Both rules live on the backend but are entirely reconstructible here, which
 * is why this needs no API change:
 *
 *   large expense — amount >= expectedMonthlyExpenses × (threshold% / 100)
 *                   (expenseRecord.service.ts). Both operands are on the
 *                   BusinessProfile already in context, and the percentage is
 *                   a field the owner sets themselves — so this is a rule they
 *                   chose, and saying so is what makes it feel like a setting
 *                   rather than an accusation.
 *
 *   duplicate     — same business, same date, same amount, and a
 *                   case-insensitively identical description (findDuplicate).
 *                   Exact on all four, which is worth stating plainly: it
 *                   explains why two genuinely similar purchases on the same
 *                   day DO get flagged.
 *
 * UAT items 30 and 33 are both about this. "Possible duplicate of record #412"
 * told the owner nothing they could act on.
 */
function LargeExpenseReason({ record, profile }: { record: RecordItem; profile: BusinessProfile }) {
  const threshold =
    Number(profile.expectedMonthlyExpenses) * (Number(profile.largeExpenseThresholdPercent) / 100);

  if (!Number.isFinite(threshold) || threshold <= 0) {
    return (
      <>
        This is large relative to your usual spending. Set your expected monthly expenses in your business
        profile and FinSight can be specific about the threshold.
      </>
    );
  }

  return (
    <>
      <Money value={record.amount} /> is at or above your large-expense threshold of{" "}
      <Money value={threshold} /> — that's {profile.largeExpenseThresholdPercent}% of your{" "}
      <Money value={profile.expectedMonthlyExpenses} /> expected monthly expenses.{" "}
      <Link to="/business-profiles" className="tap-inline font-medium text-brand-700 underline-offset-2 hover:underline">
        Change the threshold
      </Link>{" "}
      if this is normal for your business.
    </>
  );
}

/**
 * HOW THIS PAGE GROUPS DUPLICATES, AND WHY IT GROUPS THEM AT ALL
 * ==============================================================
 * A flat list asks the owner one question per flagged record. That is fine for
 * three and unusable for three hundred — and three hundred is not a strange
 * case, it is what re-importing one spreadsheet produces. The answer the owner
 * gives to the first row is almost always the answer they would give to every
 * row, so the screen should ask once.
 *
 * Every flagged record appears in EXACTLY ONE group, which is the property that
 * makes bulk actions safe. Two overlapping groupings would let the same record
 * be discarded from one card and kept from another, and whichever was clicked
 * second would act on a record that no longer exists.
 *
 * So duplicates are split by where they came from:
 *
 *   - came from a CSV import  -> grouped by that import. The real story is
 *     "this file was imported twice", and one decision settles the whole file.
 *   - everything else         -> grouped by duplicateOfRecordId, which is the
 *     record they all duplicate. findDuplicate points every copy of the same
 *     purchase at the same original, so this is a ready-made grouping key
 *     rather than something reconstructed here.
 *
 * Records flagged for being large rather than duplicated are not grouped at
 * all: each is its own judgement about one purchase, and there is nothing to
 * batch.
 */
interface DuplicateGroup {
  key: string;
  /** The batch these came in on, when they all did. */
  batch: ImportBatchSummary | null;
  records: RecordItem[];
}

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

export function FlaggedRecords() {
  const { selected } = useBusinessProfiles();
  const confirm = useConfirm();
  const toast = useToast();
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      // Together rather than in sequence: the batch list only supplies names
      // for the groups below, so waiting for one before asking for the other
      // would delay the page for no reason.
      const [flagged, importBatches] = await Promise.all([
        api.get<RecordItem[]>("/records/flagged", { params: { businessProfileId: selected.id } }),
        api
          .get<ImportBatchSummary[]>("/records/csv-imports/batches", {
            params: { businessProfileId: selected.id },
          })
          // A group that cannot name its import still works — it just says
          // "an import" instead of the file's title.
          .catch(() => ({ data: [] as ImportBatchSummary[] })),
      ]);
      setRecords(flagged.data);
      setBatches(importBatches.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  function path(record: RecordItem) {
    return record.type === "expense" ? `/records/expenses/${record.id}` : `/records/sales/${record.id}`;
  }

  /** The edit screen. `path` already computed this URL, but only for the API. */
  function editPath(record: RecordItem) {
    return record.type === "expense"
      ? `/records/expenses/${record.id}/edit`
      : `/records/sales/${record.id}/edit`;
  }

  /**
   * `intent` changes only the wording, not the request — the API has one way to
   * resolve a flag. It is worth distinguishing anyway: "Keep" means "yes, that
   * happened", and "this is normal" means "your rule is wrong about my
   * business", and echoing back which one the owner said is what makes the
   * second feel heard rather than ignored.
   */
  async function handleKeep(record: RecordItem, intent: "keep" | "normal" = "keep") {
    setBusyId(`${record.type}-${record.id}`);
    try {
      await api.patch(path(record), { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" });
      await load();
      // Naming the record matters here: the row vanishes from the queue on
      // success, so without it the owner has no confirmation of WHICH one they
      // just resolved.
      toast(
        intent === "normal"
          ? `Noted — "${record.description}" is normal for your business`
          : `Kept "${record.description}"`,
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDiscard(record: RecordItem) {
    const ok = await confirm({
      title: `Discard "${record.description}"?`,
      body: <>This deletes the record entirely. It won't appear in your history or in any insight.</>,
      confirmLabel: "Discard record",
      tone: "danger",
    });
    if (!ok) return;

    setBusyId(`${record.type}-${record.id}`);
    try {
      await api.delete(path(record));
      await load();
      toast(`Discarded "${record.description}"`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
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
  async function handleGroup(group: DuplicateGroup, action: "keep" | "discard") {
    if (!selected) return;
    const count = group.records.length;

    if (action === "discard") {
      const ok = await confirm({
        title: `Discard ${count} record${count === 1 ? "" : "s"}?`,
        body: (
          <>
            This deletes {count === 1 ? "this copy" : `these ${count} copies`} for good. The original
            record{count === 1 ? "" : "s"} they duplicate {count === 1 ? "is" : "are"} not flagged and{" "}
            {count === 1 ? "stays" : "stay"} exactly as {count === 1 ? "it is" : "they are"}.
          </>
        ),
        confirmLabel: `Discard ${count} record${count === 1 ? "" : "s"}`,
        tone: "danger",
      });
      if (!ok) return;
    }

    setBusyId(group.key);
    try {
      const { data } = await api.post<{ resolved: number }>("/records/duplicates/resolve", {
        businessProfileId: selected.id,
        action,
        expenseIds: group.records.filter((r) => r.type === "expense").map((r) => r.id),
        salesIds: group.records.filter((r) => r.type === "sales").map((r) => r.id),
      });
      await load();
      // The server's count, not the group's — it excludes anything already
      // resolved in another tab, and saying "40" when 38 were left would be a
      // small lie about the owner's own books.
      toast(
        action === "keep"
          ? `Kept ${data.resolved} record${data.resolved === 1 ? "" : "s"}`
          : `Discarded ${data.resolved} record${data.resolved === 1 ? "" : "s"}`,
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!selected) return null;

  const duplicates = records.filter((r) => r.duplicateStatus === "Flagged");
  const others = records.filter((r) => r.duplicateStatus !== "Flagged");
  const { byImport, byMatch } = groupDuplicates(duplicates, batches);

  return (
    <div>
      <PageHead
        eyebrow="Records management"
        title="Review flagged records"
        subtitle={`Records FinSight wants a second look at, for ${selected.name}.`}
      />

      {error ? (
        <div className="mb-4">
          <FormError>{error}</FormError>
        </div>
      ) : null}

      {loading ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : records.length === 0 ? (
        <EmptyState title="Nothing needs review right now" icon="✓">
          FinSight flags a record when it looks like a duplicate or is unusually large for your business.
          When one turns up, it will be waiting here.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {byImport.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">
                Duplicates from an imported file
              </h2>
              {byImport.map((group) => (
                <GroupCard
                  key={group.key}
                  group={group}
                  busy={busyId === group.key}
                  onKeep={() => handleGroup(group, "keep")}
                  onDiscard={() => handleGroup(group, "discard")}
                  editPath={editPath}
                />
              ))}
            </section>
          ) : null}

          {byMatch.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">
                Possible duplicates
              </h2>
              {byMatch.map((group) => (
                <GroupCard
                  key={group.key}
                  group={group}
                  busy={busyId === group.key}
                  onKeep={() => handleGroup(group, "keep")}
                  onDiscard={() => handleGroup(group, "discard")}
                  editPath={editPath}
                />
              ))}
            </section>
          ) : null}

          {others.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">
                Other records to check
              </h2>
              {others.map((r) => {
                const key = `${r.type}-${r.id}`;
                return (
                  <Card key={key} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink-900">{r.description}</p>
                        <p className="text-xs text-ink-500">
                          {r.date.slice(0, 10)} · <span className="capitalize">{r.type}</span> ·{" "}
                          <Money value={r.amount} />
                        </p>
                        <Link
                          to={editPath(r)}
                          className="tap-inline mt-1 inline-block text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          Open this record
                        </Link>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyId === key}
                          onClick={() => handleKeep(r)}
                        >
                          Keep
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyId === key}
                          onClick={() => handleDiscard(r)}
                        >
                          Discard
                        </Button>
                      </div>
                    </div>

                    {/*
                      The reason, not just the label. Each flag uses the Alert
                      family's severity grammar, so a flag here and the same flag in
                      the notification list are recognisably one thing — and each
                      states the rule that fired, in this owner's own figures.
                    */}
                    <div className="mt-3 space-y-2">
                      {r.largeExpenseFlag ? (
                        <Alert kind="large-expense">
                          <LargeExpenseReason record={r} profile={selected} />
                        </Alert>
                      ) : (
                        <Alert kind="needs-review">
                          This record is waiting on your confirmation before FinSight counts it as settled.
                        </Alert>
                      )}
                    </div>

                    {/*
                      Item 33 exists because unusual-expense detection is known to
                      over-flag categories with only a handful of records. Keeping a
                      record and saying "this is normal" are the same API call, but
                      they are different statements — offering the second by name
                      makes dismissing a false alarm one click, and gives the study
                      something to count.
                    */}
                    {r.largeExpenseFlag ? (
                      <div className="mt-3 border-t border-paper-200 pt-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === key}
                          onClick={() => handleKeep(r, "normal")}
                        >
                          This is normal for my business
                        </Button>
                      </div>
                    ) : null}
                  </Card>
                );
              })}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One group of duplicates and the single decision that settles it.
 *
 * The member list is collapsed behind a count. Expanded by default would put
 * the page back where it started — a wall of individual records — and the whole
 * argument for grouping is that the owner does not need to read all forty to
 * answer the question. It is there for the owner who wants to check before
 * discarding, which is a reasonable thing to want and a bad thing to force.
 */
function GroupCard({
  group,
  busy,
  onKeep,
  onDiscard,
  editPath,
}: {
  group: DuplicateGroup;
  busy: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  editPath: (r: RecordItem) => string;
}) {
  const [open, setOpen] = useState(false);
  const count = group.records.length;
  const first = group.records[0]!;
  const total = group.records.reduce((sum, r) => sum + r.amount, 0);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {group.batch ? (
            <>
              <p className="font-medium text-ink-900">{group.batch.title}</p>
              <p className="text-xs text-ink-500">
                Imported {new Date(group.batch.uploadDate).toLocaleDateString()} · {count} possible
                duplicate{count === 1 ? "" : "s"} · <Money value={total} />
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-ink-900">{first.description}</p>
              <p className="text-xs text-ink-500">
                {first.date.slice(0, 10)} · <Money value={first.amount} /> · {count} cop
                {count === 1 ? "y" : "ies"}
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onKeep}>
            Keep {count === 1 ? "it" : `all ${count}`}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={onDiscard}>
            Discard {count === 1 ? "it" : `all ${count}`}
          </Button>
        </div>
      </div>

      <div className="mt-3">
        <Alert kind="duplicate">
          {group.batch ? (
            <>
              Every record here repeats one you already had — which usually means this file was imported
              twice. Discarding them leaves the records you already had untouched.
            </>
          ) : (
            <>
              {count === 1 ? "This record has" : `These ${count} records have`} the same date, amount and
              description as a record you already had. Discarding{" "}
              {count === 1 ? "it leaves" : "them leaves"} the original untouched.
            </>
          )}
        </Alert>
      </div>

      <div className="mt-3 border-t border-paper-200 pt-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="tap-inline text-xs font-medium text-brand-700 transition hover:text-brand-800"
        >
          {open ? "Hide these records" : `Show ${count === 1 ? "this record" : `these ${count} records`}`}
        </button>
        {open ? (
          <ul className="scroll-slim mt-2 max-h-64 space-y-1 overflow-y-auto">
            {group.records.map((r) => (
              <li key={`${r.type}-${r.id}`} className="flex items-baseline justify-between gap-3 text-sm">
                <Link
                  to={editPath(r)}
                  className="min-w-0 truncate text-brand-700 underline-offset-2 hover:underline"
                >
                  {r.description}
                  <span className="ml-1.5 text-xs text-ink-400">{r.date.slice(0, 10)}</span>
                </Link>
                <span className="shrink-0 text-ink-800">
                  <Money value={r.amount} decimals />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
