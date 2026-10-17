import { Button } from "../../components/Button";
import { recoveryRowActionId, recoveryRowId, recoveryRowNames, recoveryRowTitle, type RecoveryHistoryState } from "./recoveryHistory";
import type { ReceiptHistoryItem } from "./types";

export function ReceiptRecoveryHistory({ history, loading, loadingOlder, error, scanning, deletingScanId, onRefresh, onLoadOlder, onOpen, onDelete }: {
  history: RecoveryHistoryState;
  loading: boolean;
  loadingOlder: boolean;
  error: { message: string; failed: "refresh" | "older" } | null;
  scanning: boolean;
  deletingScanId: number | null;
  onRefresh: () => void;
  onLoadOlder: () => void;
  onOpen: (scan: ReceiptHistoryItem) => void;
  onDelete: (scan: ReceiptHistoryItem) => void;
}) {
  const rowNames = recoveryRowNames(history.scans);
  return <>
    {loading ? <p className="mb-4 text-sm text-ink-500" role="status">Checking unfinished scans…</p> : null}
    {error?.failed === "refresh" ? <div className="mb-4 flex flex-wrap items-center gap-2">
      <p className="text-sm text-tone-danger" role="alert">{error.message}</p>
      <Button type="button" variant="secondary" size="sm" disabled={loading} onClick={onRefresh}>Reload unfinished scans</Button>
    </div> : null}
    {history.scans.length > 0 ? <section aria-labelledby="unfinished-receipts-title" className="mb-4 rounded-xl border border-paper-200 bg-paper-50 p-3">
      <h2 id="unfinished-receipts-title" className="text-sm font-semibold text-ink-800">Continue an unfinished scan</h2>
      <ul aria-label="Unfinished scans" className="mt-2 space-y-2">
        {history.scans.map((pending) => {
          const rowName = rowNames.get(pending.id) ?? recoveryRowTitle(pending);
          const actionLabel = pending.allowedActions.retryProcessing ? "Retry processing" : pending.allowedActions.reviewResult ? "Review result" : "Continue waiting";
          const deleteLabel = deletingScanId === pending.id ? "Deleting…" : "Delete scan";
          return <li key={pending.id} id={recoveryRowId(pending.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-paper px-3 py-2 ring-1 ring-paper-200">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-800">{recoveryRowTitle(pending)}</p>
              <p className="text-xs text-ink-500">{pending.processingStatus === "Processing" ? "Still reading" : pending.processingStatus === "Failed" ? "Needs another processing attempt" : "Ready to review"}{pending.receiptOrdinal ? ` · Receipt ${pending.receiptOrdinal}` : ""}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" id={recoveryRowActionId(pending.id)} variant={pending.allowedActions.reviewResult ? "primary" : "secondary"} disabled={scanning || deletingScanId !== null} onClick={() => onOpen(pending)} aria-label={`${actionLabel}, ${rowName}`}>{actionLabel}</Button>
              <Button type="button" variant="danger" disabled={scanning || deletingScanId !== null} onClick={() => onDelete(pending)} aria-label={`${deleteLabel}, ${rowName}`}>{deleteLabel}</Button>
            </div>
          </li>;
        })}
      </ul>
      {error?.failed === "older" ? <p className="mt-2 text-sm text-tone-danger" role="alert">{error.message}</p> : null}
      {loadingOlder ? <p className="mt-2 text-sm text-ink-500" role="status">Loading older scans…</p> : null}
      {history.nextCursor !== null ? <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={loading || loadingOlder} onClick={onLoadOlder}>Show older scans</Button> : history.pagesLoaded > 1 ? <p className="mt-2 text-xs text-ink-500">No more unfinished scans.</p> : null}
    </section> : null}
  </>;
}
