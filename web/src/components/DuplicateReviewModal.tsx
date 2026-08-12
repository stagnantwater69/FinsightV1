import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordItem } from "../lib/types";
import { Modal } from "./Modal";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { FormError } from "./Field";
import { Money } from "./Money";
import { SkeletonLine } from "./Skeleton";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";

/**
 * Deciding a possible duplicate without leaving the list it was spotted in.
 *
 * WHY A MODAL: the duplicate icon on Records used to link to /records/flagged
 * — the whole queue, not the record that was clicked, and not scrolled to it
 * either. So "review this duplicate" navigated away from the row, lost the
 * owner's filters and scroll position, and then asked them to find the record
 * again in a list of everything else that happened to be flagged. The decision
 * is small and local ("is this the same purchase as that one?"), and it should
 * happen where the question was asked.
 *
 * The queue page still exists and is still the right screen for working
 * through a backlog. This is for the single record in front of you.
 */
export function DuplicateReviewModal({
  recordId,
  recordType,
  open,
  onClose,
  onResolved,
}: {
  recordId: number | null;
  recordType: "expense" | "sales";
  open: boolean;
  onClose: () => void;
  /** Called after a Keep or Discard, so the list behind can refresh. */
  onResolved: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [record, setRecord] = useState<RecordItem | null>(null);
  const [other, setOther] = useState<RecordItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pathFor(type: "expense" | "sales", id: number) {
    return type === "expense" ? `/records/expenses/${id}` : `/records/sales/${id}`;
  }

  /*
   * Re-fetched each time it opens rather than taking the row the list already
   * has. The list's copy can be minutes old — long enough for the same record
   * to have been resolved in another tab — and a decision screen showing a
   * stale duplicateStatus would let the owner "resolve" something twice.
   */
  useEffect(() => {
    if (!open || recordId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRecord(null);
    setOther(null);

    api
      .get<RecordItem>(pathFor(recordType, recordId))
      .then(async ({ data }) => {
        if (cancelled) return;
        setRecord(data);
        if (data.duplicateOfRecordId) {
          try {
            const { data: match } = await api.get<RecordItem>(
              pathFor(data.type, data.duplicateOfRecordId),
            );
            if (!cancelled) setOther(match);
          } catch {
            // The original may have been deleted since the flag was raised.
            // The comparison degrades to "we found a match, it's gone now",
            // which is still enough to decide on the record in hand.
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, recordId, recordType]);

  async function handleKeep() {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(pathFor(record.type, record.id), {
        duplicateStatus: "Not a Duplicate",
        reviewStatus: "Reviewed",
      });
      toast(`Kept "${record.description}"`);
      onResolved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (!record) return;
    const ok = await confirm({
      title: `Discard "${record.description}"?`,
      body: <>This deletes the record entirely. It won't appear in your history or in any insight.</>,
      confirmLabel: "Discard record",
      tone: "danger",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      await api.delete(pathFor(record.type, record.id));
      toast(`Discarded "${record.description}"`);
      onResolved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Possible duplicate">
      {loading ? (
        <div className="space-y-2">
          <SkeletonLine className="w-3/4" />
          <SkeletonLine className="w-1/2" />
        </div>
      ) : error && !record ? (
        <FormError>{error}</FormError>
      ) : record ? (
        <div className="space-y-4">
          <Alert kind="duplicate">
            {other ? (
              <>It has the same date, amount and description as a record you already had.</>
            ) : (
              <>
                Another record in this business has the same date, the same amount and the same
                description.
              </>
            )}
          </Alert>

          {/*
            Stacked rather than side by side. At this width two columns would
            be ~14rem each, which truncates exactly the descriptions the owner
            is trying to tell apart — and the fields line up for comparison
            vertically just as well.
          */}
          <RecordCard label="This record" record={record} tone="subject" />
          {other ? <RecordCard label="The one it matches" record={other} tone="match" /> : null}

          {error ? <FormError>{error}</FormError> : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={handleKeep}>
              Keep both
            </Button>
            <Button variant="danger" disabled={busy} onClick={handleDiscard}>
              Discard this one
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-ink-500">
            {/*
              "Keep" resolves the flag without changing the figures, which is
              not obvious from the word alone — an owner who genuinely bought
              the same thing twice needs to know that keeping it is a real
              answer and not a way of postponing the question.
            */}
            Keeping both is the right answer when you really did buy the same thing twice — it clears
            the flag and leaves your figures untouched.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

function RecordCard({
  label,
  record,
  tone,
}: {
  label: string;
  record: RecordItem;
  tone: "subject" | "match";
}) {
  return (
    <div
      className={`rounded-xl p-3 ring-1 ${
        tone === "subject" ? "bg-paper-50 ring-paper-200" : "bg-paper-100 ring-paper-200"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">{label}</p>
      <p className="mt-1 font-medium text-ink-900">{record.description}</p>
      <p className="text-xs text-ink-500">
        {record.date.slice(0, 10)} · <span className="capitalize">{record.type}</span> ·{" "}
        <Money value={record.amount} />
      </p>
      {record.vendor ? <p className="mt-0.5 text-xs text-ink-500">{record.vendor}</p> : null}
    </div>
  );
}
