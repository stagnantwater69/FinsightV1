import { useState } from "react";
import {
  ACCEPTED_TYPES,
  receiptUploadFileIssue,
  receiptUploadSelectionError,
  type ReceiptUploadFileIssue,
} from "./constants";
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
  disabled = false,
}: {
  id: string;
  files: File[];
  onChange: (files: File[]) => void;
  hintText?: string;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const selectionError = receiptUploadSelectionError([], files);

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
    if (disabled) return;
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    onChange([...files, ...incoming]);
  }

  function removeAt(index: number) {
    if (disabled) return;
    onChange(files.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    if (disabled) return;
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next);
  }

  return (
    <fieldset
      disabled={disabled}
      aria-invalid={selectionError ? true : undefined}
      aria-describedby={selectionError ? `${id}-selection-error` : undefined}
      className="min-w-0 rounded-xl has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600"
    >
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          if (disabled) return;
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
        className={`flex min-h-tap cursor-pointer flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center text-sm transition-colors ${disabled ? "opacity-60" : ""} ${
          dragging
            ? "border-edge-brand bg-tint-brand text-tone-brand"
            : "border-ink-200 bg-paper-100 text-ink-600 hover:border-edge-brand hover:bg-tint-brand"
        }`}
      >
        <span aria-hidden className="text-base">
          ⇪
        </span>
        <span className="font-medium">{files.length > 0 ? "Add more photos" : "Choose photos"}</span>
        <span className="text-ink-600">or drag them here</span>
      </label>

      <input
        id={id}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />

      {hintText ? <p className="mt-1.5 text-xs text-ink-500">{hintText}</p> : null}

      {selectionError ? (
        <p id={`${id}-selection-error`} role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-tone-danger">
          <span aria-hidden className="mt-px shrink-0">
            ⚠
          </span>
          <span className="min-w-0">{selectionError}</span>
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
              invalidReason={invalidFileReason(receiptUploadFileIssue(f))}
            />
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

function invalidFileReason(issue: ReceiptUploadFileIssue | null): string | null {
  if (issue === "EMPTY") return "Empty file";
  if (issue === "UNSUPPORTED_TYPE") return "Unsupported file type";
  if (issue === "TOO_LARGE") return "Larger than 10 MiB";
  return null;
}
