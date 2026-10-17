export function FeedNotice({ label, onRetry, retained = false }: {
  label: string;
  onRetry: () => void;
  retained?: boolean;
}) {
  return (
    <div role="status" className={retained ? "mb-3 flex flex-wrap items-center gap-x-3 text-xs text-ink-600" : "py-8 text-center text-sm text-ink-600"}>
      <p>{retained ? `${label} couldn’t refresh. Showing previously loaded figures.` : `${label} couldn’t load.`}</p>
      <button type="button" onClick={onRetry} className="tap-inline text-sm link">
        Reload {label.toLowerCase()}
      </button>
    </div>
  );
}
