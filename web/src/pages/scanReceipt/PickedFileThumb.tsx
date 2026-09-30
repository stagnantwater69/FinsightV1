import { useEffect, useState } from "react";
import { IconArrowLeft, IconArrowRight, IconTrash } from "../../components/icons";

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
  invalidReason = null,
}: {
  file: File;
  index: number;
  total: number;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  invalidReason?: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (invalidReason) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, invalidReason]);

  return (
    <li className="relative w-24 shrink-0">
      <div className="aspect-[3/4] overflow-hidden rounded-lg border border-paper-200 bg-paper-100">
        {url ? (
          <img src={url} alt={`Page ${index + 1}`} className="h-full w-full object-cover" />
        ) : invalidReason ? (
          <div className="flex h-full min-w-0 flex-col justify-center gap-1 p-2 text-center">
            <span className="break-all text-[11px] font-medium leading-tight text-ink-700">{file.name}</span>
            <span className="text-[10px] leading-tight text-tone-danger">{invalidReason}</span>
            <span className="text-[10px] leading-tight text-ink-600">
              {new Intl.NumberFormat("en-PH").format(file.size)} bytes
            </span>
          </div>
        ) : null}
      </div>
      <span className="absolute left-1 top-1 rounded-full bg-paper/90 px-1.5 py-0.5 text-[10px] font-semibold text-ink-700">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove page ${index + 1}`}
        className="tap group absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-full text-sm font-bold text-ink-600 hover:text-tone-danger"
      >
        <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-full bg-paper/95 shadow-sm group-hover:bg-tint-danger">
          <IconTrash className="h-3.5 w-3.5" />
        </span>
      </button>
      {total > 1 ? (
        <div className="mt-1 flex justify-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            aria-label={`Move page ${index + 1} earlier`}
            className="tap-inline flex h-11 w-11 items-center justify-center rounded-lg text-ink-500 hover:bg-paper-100 disabled:opacity-30"
          >
            <IconArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            aria-label={`Move page ${index + 1} later`}
            className="tap-inline flex h-11 w-11 items-center justify-center rounded-lg text-ink-500 hover:bg-paper-100 disabled:opacity-30"
          >
            <IconArrowRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </li>
  );
}
