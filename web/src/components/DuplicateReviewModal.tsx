import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../lib/types";
import { formatCalendarDate } from "../lib/dates";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { FormError } from "./Field";
import { formatMoney } from "./Money";
import { SkeletonLine } from "./Skeleton";
import { useResolveDuplicate } from "./useResolveDuplicate";
import { sharedFields } from "../lib/duplicateMatch";

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
  const resolver = useResolveDuplicate(() => {
    onResolved();
    onClose();
  });
  const setResolveError = resolver.setError;
  const [record, setRecord] = useState<RecordItem | null>(null);
  const [other, setOther] = useState<RecordItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setResolveError(null);
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
  }, [open, recordId, recordType, setResolveError]);

  return (
    <Modal open={open} onClose={onClose} title="Same record twice?">
      {loading ? (
        <div className="space-y-2">
          <SkeletonLine className="w-3/4" />
          <SkeletonLine className="w-1/2" />
        </div>
      ) : error && !record ? (
        <FormError>{error}</FormError>
      ) : record ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-700">
            {other
              ? `These two have the same ${sharedFields(record, other)}.`
              : "This matched another record that has since been removed."}{" "}
            Keep both if it really happened twice. Keeping clears the flag and changes no figures.
          </p>

          <Comparison record={record} other={other} />

          {error || resolver.error ? <FormError>{resolver.error ?? error}</FormError> : null}

          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" disabled={resolver.busy} onClick={() => void resolver.keep(record)}>
              Keep both
            </Button>
            <Button variant="danger" disabled={resolver.busy} onClick={() => void resolver.discard(record, other !== null)}>
              Delete this copy
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function signedAmount(r: RecordItem) {
  return formatMoney(r.type === "expense" ? -r.amount : r.amount, { decimals: true, signed: true });
}

function addedAt(r: RecordItem) {
  return new Date(r.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** How far apart two records were entered, in words, or null when it says nothing useful. */
function enteredApart(a: RecordItem, b: RecordItem): string | null {
  const minutes = Math.round(Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "Added less than a minute apart.";
  if (minutes < 60) return `Added ${minutes} minute${minutes === 1 ? "" : "s"} apart.`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Added ${hours} hour${hours === 1 ? "" : "s"} apart.`;
  return null;
}

/**
 * The two records field by field. Matching values are muted so the one that
 * differs (usually when or how it was added) is what the eye finds.
 */
function Comparison({ record, other }: { record: RecordItem; other: RecordItem | null }) {
  const source = (r: RecordItem) => RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source;
  const rows: { label: string; value: (r: RecordItem) => string }[] = [
    { label: "Description", value: (r) => r.description },
    { label: "Date", value: (r) => formatCalendarDate(r.date) },
    { label: "Amount", value: signedAmount },
    ...(record.vendor || other?.vendor ? [{ label: "Vendor", value: (r: RecordItem) => r.vendor || "None" }] : []),
    { label: "Source", value: source },
    { label: "Added", value: addedAt },
  ];
  const apart = other ? enteredApart(record, other) : null;

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-paper-200">
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">This record compared with the record it matches</caption>
        <thead className="bg-paper-100 text-xs text-ink-600">
          <tr>
            <th scope="col" className="w-24 px-3 py-2 text-left font-medium">
              <span className="sr-only">Field</span>
            </th>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-ink-900">This one</th>
            {other ? (
              <th scope="col" className="px-3 py-2 text-left font-semibold">Earlier record</th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-paper-200">
          {rows.map((row) => {
            const mine = row.value(record);
            const theirs = other ? row.value(other) : null;
            const differs = theirs !== null && theirs !== mine;
            const cell = `break-words px-3 py-2 align-top ${
              row.label === "Amount" ? "figure " : ""
            }${differs ? "font-semibold text-ink-900" : "text-ink-600"}`;
            return (
              <tr key={row.label}>
                <th scope="row" className="px-3 py-2 text-left align-top text-xs font-medium text-ink-500">
                  {row.label}
                </th>
                <td className={cell}>{mine}</td>
                {other ? <td className={cell}>{theirs}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {apart ? <p className="border-t border-paper-200 bg-paper-50 px-3 py-2 text-xs text-ink-600">{apart}</p> : null}
    </div>
  );
}
