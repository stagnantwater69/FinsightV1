import { useState } from "react";
import { ACCEPTED_TYPES, MAX_FILE_BYTES, MAX_RECEIPT_FILES } from "./constants";
import { PickedFileThumb } from "./PickedFileThumb";

/**
 * Picks one or several receipt photos.
 *
 * A generalisation of Field.tsx's FileInput to more than one file, kept as
 * its own component rather than added to that one: FileInput's contract
 * (`file: File | null`) is depended on by ImportCsv's single-file picker too,
 * and multi-select is a genuinely different shape, not an option on the same
 * one.
 *
 * Selecting again REPLACES the set, matching the native `<input multiple>`
 * behaviour a second file-dialog invocation already has — there is no
 * incremental "add more" interaction beyond what the OS picker itself offers
 * when the owner selects several files in one dialog.
 */
export function MultiFileInput({
  id,
  files,
  onChange,
  hintText,
}: {
  id: string;
  files: File[];
  onChange: (files: File[]) => void;
  hintText?: string;
}) {
  const [rejected, setRejected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function accepts(f: File): boolean {
    return ACCEPTED_TYPES.split(",").includes(f.type.toLowerCase());
  }

  /**
   * ADDS the newly picked photos to what is already selected, rather than
   * replacing it.
   *
   * A native `<input multiple>` hands back a fresh FileList on every
   * invocation with no memory of a previous one — that is what made this
   * button silently discard page 1 the moment it was used to add page 2. The
   * remove (×) on each thumbnail is the deliberate way to drop a photo;
   * picking again should only ever add to the set it already has.
   */
  function take(list: FileList | File[] | null) {
    setRejected(null);
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const combined = [...files, ...incoming];

    if (combined.length > MAX_RECEIPT_FILES) {
      setRejected(
        `A receipt can have at most ${MAX_RECEIPT_FILES} photos — you already have ${files.length} and picked ` +
          `${incoming.length} more.`,
      );
      return;
    }
    const badType = incoming.find((f) => !accepts(f));
    if (badType) {
      setRejected(`${badType.name} isn't a photo this accepts. Expected JPEG, PNG or WEBP.`);
      return;
    }
    const tooBig = incoming.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      const limit = Math.round(MAX_FILE_BYTES / (1024 * 1024));
      setRejected(`${tooBig.name} is over ${limit}MB — try a smaller photo.`);
      return;
    }
    onChange(combined);
  }

  function removeAt(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next);
  }

  return (
    <div>
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
        className={`flex min-h-tap cursor-pointer flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center text-sm transition-colors ${
          dragging
            ? "border-edge-brand bg-tint-brand text-tone-brand"
            : "border-ink-200 bg-paper-100 text-ink-600 hover:border-edge-brand hover:bg-tint-brand"
        }`}
      >
        <span aria-hidden className="text-base">
          ⇪
        </span>
        <span className="font-medium">{files.length > 0 ? "Add more photos" : "Choose photos"}</span>
        <span className="text-ink-400">or drag them here</span>
      </label>

      <input
        id={id}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="sr-only"
        onChange={(e) => take(e.target.files)}
      />

      {hintText ? <p className="mt-1.5 text-xs text-ink-500">{hintText}</p> : null}

      {rejected ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-tone-danger">
          <span aria-hidden className="mt-px shrink-0">
            ⚠
          </span>
          <span className="min-w-0">{rejected}</span>
        </p>
      ) : null}

      {files.length > 0 ? (
        <ul className="scroll-slim mt-3 flex gap-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <PickedFileThumb
              key={`${f.name}-${f.lastModified}-${i}`}
              file={f}
              index={i}
              total={files.length}
              onRemove={() => removeAt(i)}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
