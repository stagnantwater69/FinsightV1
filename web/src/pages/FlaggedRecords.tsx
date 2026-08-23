import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type {
  AnomalyFindingPage,
  BusinessProfile,
  ImportBatchSummary,
  RecordItem,
} from "../lib/types";
import {
  CATEGORY_LABELS,
  REVIEW_CATEGORIES,
  buildReviewQueue,
  feedbackActions,
  filterQueue,
  type DuplicateGroup,
  type FeedbackAction,
  type ReviewFilter,
  type ReviewItem,
} from "../lib/findingPresentation";
import { SIGNAL_COPY } from "../lib/confidenceBands";
import { Card, PageHead, Pill } from "../components/ui";
import { Alert } from "../components/Alert";
import { useAskFinSight } from "../components/AskFinSightButton";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { FormError } from "../components/Field";
import { Money } from "../components/Money";
import { SkeletonRows } from "../components/Skeleton";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";

/** How many findings one page of the queue asks for. */
const FINDINGS_PAGE_SIZE = 25;

/**
 * Why a record was flagged, stated in the owner's own numbers.
 *
 * THIS IS THE QUALITY BAR for every reason in the queue, which is why it
 * survived the rebuild unchanged. It names the threshold, says where that
 * number came from (a percentage the owner chose themselves, of a figure they
 * entered themselves), and links to the screen that changes it — so it reads
 * as a setting rather than an accusation. UAT items 30 and 33 are both about
 * this: "Possible duplicate of record #412" told the owner nothing they could
 * act on.
 *
 * Both operands are on the BusinessProfile already in context, so this needs
 * no API call: amount >= expectedMonthlyExpenses × (threshold% / 100), the
 * same arithmetic largeExpenseThresholdFor() does on the server.
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

/** How sure FinSight is, as words. Never a raw score — see ADR-4. */
function SignalBadge({ signal }: { signal: ReviewItem["signal"] }) {
  const copy = SIGNAL_COPY[signal];
  const tone = copy.tone === "info" ? "info" : copy.tone === "warn" ? "warn" : "danger";
  return (
    <span title={copy.detail}>
      <Pill tone={tone}>{copy.label}</Pill>
    </span>
  );
}

/**
 * "Why FinSight flagged this" — the technical account, one click away.
 *
 * Everything in here is real and worth keeping (a support conversation about a
 * bad flag is unanswerable without the detector version), and none of it
 * belongs on the primary card: ADR-4's rule is that "Isolation Forest",
 * contamination and raw scores are never the owner-facing explanation. So the
 * card says what happened in the owner's numbers and this says what produced
 * it.
 */
function AuditSection({ item }: { item: ReviewItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const audit = item.audit;
  if (!audit) return null;

  const entries = Object.entries(audit.metadata ?? {}).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="mt-3 border-t border-paper-200 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="tap-inline text-xs font-medium text-brand-700 transition hover:text-brand-800"
      >
        {open ? "Hide why FinSight flagged this" : "Why FinSight flagged this"}
      </button>
      <div id={panelId} hidden={!open}>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
          <dt className="text-ink-500">Detector</dt>
          <dd className="text-ink-800">{audit.method ?? "—"}</dd>
          <dt className="text-ink-500">Detector version</dt>
          <dd className="figure text-ink-800">{audit.detectorVersion ?? "—"}</dd>
          <dt className="text-ink-500">Finding type</dt>
          <dd className="text-ink-800">{audit.type}</dd>
          <dt className="text-ink-500">Internal score</dt>
          <dd className="figure text-ink-800">{audit.score === null ? "not scored" : audit.score}</dd>
          <dt className="text-ink-500">Finding ID</dt>
          <dd className="figure text-ink-800">#{audit.findingId}</dd>
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-ink-500">{key}</dt>
              <dd className="figure break-words text-ink-800">{String(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          These are FinSight's own working figures, kept so a flag can be explained after the fact. A
          flag is never a claim that something is wrong — it is a comparison against this business's own
          history.
        </p>
      </div>
    </div>
  );
}

export function FlaggedRecords() {
  const { selected } = useBusinessProfiles();
  const confirm = useConfirm();
  const toast = useToast();
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [findings, setFindings] = useState<AnomalyFindingPage["items"]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>("all");
  /*
   * "Explain this flag" opens the Ask FinSight drawer with a question built
   * from the card they are looking at. This screen has no floating trigger of
   * its own — the entry point is the per-finding action, which is the only
   * place the question can be made specific.
   */
  const askFinSight = useAskFinSight("Records Review");
  const queueId = useId();

  async function load() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      /*
       * Together rather than in sequence, and each supplement degrades on its
       * own. The legacy column flags are the core read — losing them is worth
       * an error banner. The detector findings and the batch titles are not:
       * a queue that shows every duplicate but cannot name the import it came
       * from is still the screen the owner opened.
       */
      const [flagged, findingPage, importBatches] = await Promise.all([
        api.get<RecordItem[]>("/records/flagged", { params: { businessProfileId: selected.id } }),
        api
          .get<AnomalyFindingPage>("/insights/findings", {
            params: { businessProfileId: selected.id, status: "OPEN", take: FINDINGS_PAGE_SIZE },
          })
          .catch(() => ({ data: { items: [], nextCursor: null } as AnomalyFindingPage })),
        api
          .get<ImportBatchSummary[]>("/records/csv-imports/batches", {
            params: { businessProfileId: selected.id },
          })
          .catch(() => ({ data: [] as ImportBatchSummary[] })),
      ]);
      setRecords(flagged.data);
      setFindings(findingPage.data.items);
      setNextCursor(findingPage.data.nextCursor);
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

  /** The next page of findings, appended rather than replacing what's on screen. */
  async function loadMoreFindings() {
    if (!selected || nextCursor === null) return;
    setLoadingMore(true);
    try {
      const { data } = await api.get<AnomalyFindingPage>("/insights/findings", {
        params: {
          businessProfileId: selected.id,
          status: "OPEN",
          take: FINDINGS_PAGE_SIZE,
          cursorId: nextCursor,
        },
      });
      setFindings((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  function path(record: RecordItem) {
    return record.type === "expense" ? `/records/expenses/${record.id}` : `/records/sales/${record.id}`;
  }

  function editPath(record: RecordItem) {
    return record.type === "expense"
      ? `/records/expenses/${record.id}/edit`
      : `/records/sales/${record.id}/edit`;
  }

  /**
   * `intent` changes only the wording, not the request — the API has one way to
   * resolve a column flag. It is worth distinguishing anyway: "Keep" means "yes,
   * that happened", and "this is normal" means "your rule is wrong about my
   * business", and echoing back which one the owner said is what makes the
   * second feel heard rather than ignored.
   */
  async function handleKeep(item: ReviewItem, intent: "keep" | "normal" = "keep") {
    const record = item.record;
    if (!record) return;
    setBusyKey(item.key);
    try {
      await api.patch(path(record), { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" });
      await load();
      toast(
        intent === "normal"
          ? `Noted — "${record.description}" is normal for your business`
          : `Kept "${record.description}"`,
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDiscard(item: ReviewItem) {
    const record = item.record;
    if (!record) return;
    const ok = await confirm({
      title: `Discard "${record.description}"?`,
      body: <>This deletes the record entirely. It won't appear in your history or in any insight.</>,
      confirmLabel: "Discard record",
      tone: "danger",
    });
    if (!ok) return;

    setBusyKey(item.key);
    try {
      await api.delete(path(record));
      await load();
      toast(`Discarded "${record.description}"`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  /** One of the five feedback values, sent against a detector finding. */
  async function handleFeedback(item: ReviewItem, action: FeedbackAction) {
    if (!item.finding) return;
    setBusyKey(item.key);
    try {
      await api.patch(`/insights/findings/${item.finding.id}/review`, {
        status: action.status,
        feedback: action.feedback,
      });
      await load();
      toast(action.toast);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyKey(null);
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

    setBusyKey(group.key);
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
      setBusyKey(null);
    }
  }

  function explain(question: string) {
    askFinSight(question);
  }

  if (!selected) return null;

  const queue = buildReviewQueue({ findings, records, batches });
  const visible = filterQueue(queue, filter);
  const nothingAtAll = queue.counts.all === 0;

  return (
    <div>
      <PageHead
        eyebrow="Records management"
        title="Needs review"
        subtitle={`Everything FinSight wants a second look at, for ${selected.name} — duplicates, unusual spending and scan problems in one queue.`}
      />

      {error ? (
        <div className="mb-4">
          <FormError>{error}</FormError>
        </div>
      ) : null}

      {/*
        The chips are toggle buttons, not tabs: they filter one list in place
        rather than swapping panels, and `aria-pressed` says which one is on
        without claiming a tablist that doesn't exist. Each names its own count,
        so choosing a filter is an informed choice rather than a gamble about
        what it hides.
      */}
      {loading || nothingAtAll ? null : (
        <div role="group" aria-label="Filter the review queue" className="mb-4 flex flex-wrap gap-2">
          {(["all", ...REVIEW_CATEGORIES] as ReviewFilter[]).map((chip) => {
            const active = filter === chip;
            return (
              <button
                key={chip}
                type="button"
                aria-pressed={active}
                aria-controls={queueId}
                onClick={() => setFilter(chip)}
                className={`min-h-tap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-brand-600 text-white"
                    : "border border-ink-200 bg-paper text-ink-700 hover:bg-paper-100"
                }`}
              >
                {CATEGORY_LABELS[chip]}
                <span className={`figure ml-1.5 text-xs ${active ? "opacity-80" : "text-ink-400"}`}>
                  {queue.counts[chip]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : nothingAtAll ? (
        <EmptyState title="Nothing needs review right now" icon="✓">
          FinSight flags a record when it looks like a duplicate, when it's unusual against your own
          history, or when a scan came out hard to read. When one turns up, it will be waiting here.
        </EmptyState>
      ) : (
        <div id={queueId} className="space-y-3">
          {visible.groups.map((group) => (
            <GroupCard
              key={group.key}
              group={group}
              busy={busyKey === group.key}
              onKeep={() => handleGroup(group, "keep")}
              onDiscard={() => handleGroup(group, "discard")}
              editPath={editPath}
            />
          ))}

          {visible.items.map((item) => (
            <ReviewCard
              key={item.key}
              item={item}
              profile={selected}
              busy={busyKey === item.key}
              editPath={editPath}
              onFeedback={(action) => handleFeedback(item, action)}
              onKeep={(intent) => handleKeep(item, intent)}
              onDiscard={() => handleDiscard(item)}
              onExplain={() => explain(item.explainQuestion)}
            />
          ))}

          {visible.groups.length === 0 && visible.items.length === 0 ? (
            <EmptyState compact title={`Nothing under "${CATEGORY_LABELS[filter]}"`} icon="✓">
              Other filters still have items waiting. Choose "All" to see everything.
            </EmptyState>
          ) : null}

          {nextCursor !== null ? (
            <div className="pt-1">
              <Button type="button" variant="secondary" disabled={loadingMore} onClick={loadMoreFindings}>
                {loadingMore ? "Loading…" : "Show more findings"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One thing to review.
 *
 * The card's order IS the ADR-4 contract, top to bottom: plain-language title,
 * the record it is about, the confidence band as words, one to three reasons,
 * the comparison baseline, where and when it came from, then the actions, then
 * the audit expander. Nothing technical appears above the fold.
 */
function ReviewCard({
  item,
  profile,
  busy,
  editPath,
  onFeedback,
  onKeep,
  onDiscard,
  onExplain,
}: {
  item: ReviewItem;
  profile: BusinessProfile;
  busy: boolean;
  editPath: (r: RecordItem) => string;
  onFeedback: (action: FeedbackAction) => void;
  onKeep: (intent: "keep" | "normal") => void;
  onDiscard: () => void;
  onExplain: () => void;
}) {
  const record = item.record;
  const actions = feedbackActions(item.category);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium text-ink-900">{item.title}</h2>
          {record ? (
            <p className="text-xs text-ink-500">
              {record.date.slice(0, 10)} · <span className="capitalize">{record.type}</span> ·{" "}
              <Money value={record.amount} />
            </p>
          ) : null}
          <p className="mt-0.5 text-xs text-ink-400">
            {item.source}
            {item.detectedAt ? ` · noticed ${new Date(item.detectedAt).toLocaleDateString()}` : null}
          </p>
          {record ? (
            <Link
              to={editPath(record)}
              className="tap-inline mt-1 inline-block text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              Open this record
            </Link>
          ) : null}
        </div>
        <SignalBadge signal={item.signal} />
      </div>

      <div className="mt-3 space-y-2">
        <Alert kind={item.alertKind}>
          <span className="block space-y-1">
            {item.reasons.map((reason, i) =>
              reason.kind === "large-expense-threshold" && record ? (
                <span key={`threshold-${i}`} className="block">
                  <LargeExpenseReason record={record} profile={profile} />
                </span>
              ) : (
                <span key={`${reason.text}-${i}`} className="block">
                  {reason.text}
                </span>
              ),
            )}
            {item.baseline ? (
              <span className="mt-1 block text-ink-500">{item.baseline}</span>
            ) : null}
          </span>
        </Alert>

        {/*
          The legacy column flag as a SECONDARY line on the detector's card,
          never as a second card. Both surfaces were telling the owner about
          the same record, and answering one used to leave the other sitting
          there looking unanswered.
        */}
        {item.finding && item.legacy.largeExpense && record ? (
          <p className="text-xs leading-relaxed text-ink-500">
            <span className="font-medium text-ink-700">Also flagged as a large expense.</span>{" "}
            <LargeExpenseReason record={record} profile={profile} />
          </p>
        ) : null}
        {item.finding && item.legacy.duplicate ? (
          <p className="text-xs text-ink-500">
            <span className="font-medium text-ink-700">Also flagged as a possible duplicate</span> when it
            was saved.
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {item.finding ? (
          actions.map((action) => (
            <Button
              key={action.feedback}
              size="sm"
              variant={action.primary ? "secondary" : "ghost"}
              disabled={busy}
              onClick={() => onFeedback(action)}
            >
              {action.label}
            </Button>
          ))
        ) : (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onKeep("keep")}>
              Keep
            </Button>
            {item.legacy.largeExpense ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onKeep("normal")}>
                This is normal for my business
              </Button>
            ) : null}
            <Button size="sm" variant="danger" disabled={busy} onClick={onDiscard}>
              Discard
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onExplain}>
          Explain this flag
        </Button>
      </div>

      <AuditSection item={item} />
    </Card>
  );
}

/**
 * One group of duplicates and the single decision that settles it.
 *
 * HOW THIS PAGE GROUPS DUPLICATES, AND WHY IT GROUPS THEM AT ALL. A flat list
 * asks the owner one question per flagged record. That is fine for three and
 * unusable for three hundred — and three hundred is not a strange case, it is
 * what re-importing one spreadsheet produces. The answer the owner gives to
 * the first row is almost always the answer they would give to every row, so
 * the screen asks once. See findingPresentation.ts for the grouping rule and
 * for why every flagged record belongs to exactly one group.
 *
 * The member list is collapsed behind a count. Expanded by default would put
 * the page back where it started — a wall of individual records.
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
  const listId = useId();
  const count = group.records.length;
  const first = group.records[0]!;
  const total = group.records.reduce((sum, r) => sum + r.amount, 0);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {group.batch ? (
            <>
              <h2 className="font-medium text-ink-900">{group.batch.title}</h2>
              <p className="text-xs text-ink-500">
                Imported {new Date(group.batch.uploadDate).toLocaleDateString()} · {count} possible
                duplicate{count === 1 ? "" : "s"} · <Money value={total} />
              </p>
            </>
          ) : (
            <>
              <h2 className="font-medium text-ink-900">{first.description}</h2>
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

      {/*
        Detector findings about records already in this group, folded in as a
        line rather than escaping as their own cards. Two surfaces for one
        record would let it be discarded from one and kept from the other, and
        whichever was clicked second would act on a record that no longer
        exists.
      */}
      {group.findings.length > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          <span className="font-medium text-ink-700">
            FinSight's duplicate check flagged {group.findings.length} of these separately.
          </span>{" "}
          Settling the group answers all of them.
        </p>
      ) : null}

      <div className="mt-3 border-t border-paper-200 pt-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={listId}
          className="tap-inline text-xs font-medium text-brand-700 transition hover:text-brand-800"
        >
          {open ? "Hide these records" : `Show ${count === 1 ? "this record" : `these ${count} records`}`}
        </button>
        <ul id={listId} hidden={!open} className="scroll-slim mt-2 max-h-64 space-y-1 overflow-y-auto">
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
      </div>
    </Card>
  );
}
