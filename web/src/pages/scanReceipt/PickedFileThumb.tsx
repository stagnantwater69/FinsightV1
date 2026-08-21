import { useEffect, useState } from "react";

/**
 * One picked photo, shown as a thumbnail with its own object URL.
 *
 * The URL is scoped to this component's lifetime rather than built once for
 * the whole list — a file removed from the middle of the array would
 * otherwise leave its revoke tied to a different file after React re-keys
 * the list, which is exactly the kind of leak useEffect's cleanup exists to
 * catch.
 */
export function PickedFileThumb({
  file,
  index,
  total,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  file: File;
  index: number;
  total: number;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <li className="relative w-24 shrink-0">
      <div className="aspect-[3/4] overflow-hidden rounded-lg border border-paper-200 bg-paper-100">
        {url ? (
          <img src={url} alt={`Page ${index + 1}`} className="h-full w-full object-cover" />
        ) : null}
      </div>
      <span className="absolute left-1 top-1 rounded-full bg-paper/90 px-1.5 py-0.5 text-[10px] font-semibold text-ink-700">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove page ${index + 1}`}
        className="tap absolute right-1 top-1 flex h-6 w-6 min-h-0 min-w-0 items-center justify-center rounded-full bg-paper/90 text-xs font-bold text-ink-600 hover:bg-tint-danger hover:text-tone-danger"
      >
        ×
      </button>
      {/*
        Reorder by button rather than drag-and-drop. Drag reordering on a
        touch screen needs a library this app does not otherwise depend on,
        and up/down buttons are fully keyboard- and screen-reader-operable
        for free — a real constraint, not a corner cut silently.
      */}
      <div className="mt-1 flex justify-center gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          aria-label={`Move page ${index + 1} earlier`}
          className="tap-inline flex h-6 w-6 min-h-0 min-w-0 items-center justify-center rounded text-xs text-ink-500 hover:bg-paper-100 disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === total - 1}
          aria-label={`Move page ${index + 1} later`}
          className="tap-inline flex h-6 w-6 min-h-0 min-w-0 items-center justify-center rounded text-xs text-ink-500 hover:bg-paper-100 disabled:opacity-30"
        >
          ↓
        </button>
      </div>
    </li>
  );
}
