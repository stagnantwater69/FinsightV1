export function BatchProgressList({
  queueTotal,
  queuePosition,
  queueHistory,
}: {
  queueTotal: number;
  queuePosition: number;
  queueHistory: { position: number; recordIds: number[] }[];
}) {
  return (
    <>
      {/*
        The batch progress row — a plain-text "Receipt 2 of 4" in the subtitle
        was easy to miss, and gave no way to actually SEE receipt 1 again once
        it scrolled past. Each earlier receipt is now a real link.

        Opens in a NEW TAB rather than navigating in place: this app is a
        single-page client, and an in-app navigation to a saved record would
        unmount this screen — losing fileQueue, queuePosition and everything
        else this in-progress batch is holding. A new tab leaves the batch
        exactly where it was.
      */}
      {queueTotal > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="list" aria-label="Receipts in this batch">
          {Array.from({ length: queueTotal }, (_, i) => i + 1).map((n) => {
            const history = queueHistory.find((h) => h.position === n);
            if (n === queuePosition) {
              return (
                <span
                  key={n}
                  role="listitem"
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Receipt {n} · Reviewing now
                </span>
              );
            }
            if (history && history.recordIds[0] !== undefined) {
              return (
                <a
                  key={n}
                  role="listitem"
                  href={`/records/expenses/${history.recordIds[0]}/edit`}
                  target="_blank"
                  rel="noreferrer"
                  className="tap-inline inline-flex items-center gap-1.5 rounded-full bg-tint-brand px-3 py-1.5 text-xs font-medium text-tone-brand ring-1 ring-edge-brand transition hover:bg-tint-brand/70"
                >
                  <span aria-hidden>✓</span>
                  Receipt {n} · Saved. View it
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              );
            }
            if (history) {
              return (
                <span
                  key={n}
                  role="listitem"
                  className="inline-flex items-center gap-1.5 rounded-full bg-tint-brand px-3 py-1.5 text-xs font-medium text-tone-brand ring-1 ring-edge-brand"
                >
                  <span aria-hidden>✓</span>
                  Receipt {n} · Saved
                </span>
              );
            }
            return (
              <span
                key={n}
                role="listitem"
                className="inline-flex items-center gap-1.5 rounded-full bg-paper-100 px-3 py-1.5 text-xs text-ink-600"
              >
                Receipt {n} · Not yet
              </span>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
