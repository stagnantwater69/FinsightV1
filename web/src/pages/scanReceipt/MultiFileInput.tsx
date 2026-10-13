import { useState } from "react";
import {
  ACCEPTED_TYPES,
  receiptUploadFileIssue,
  receiptUploadSelectionError,
  type ReceiptUploadFileIssue,
} from "./constants";
import { PickedFileThumb } from "./PickedFileThumb";
import { IconAlertTriangle, IconUpload } from "../../components/icons";

/** Picks several receipt pages and keeps earlier choices when more are added. */
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

  // A new FileList forgets earlier picks, so merge it to keep every receipt page.
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
        className={`flex cursor-pointer items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors ${
          files.length > 0
            ? "min-h-tap flex-col gap-2 px-3 py-3 sm:flex-row sm:gap-3"
            : "min-h-[11rem] flex-col gap-2 px-5 py-4 sm:min-h-[12rem] sm:py-5"
        } ${disabled ? "opacity-60" : ""} ${
          dragging
            ? "border-edge-brand bg-tint-brand text-tone-brand"
            : "border-ink-200 bg-paper-100 text-ink-600 hover:border-edge-brand hover:bg-tint-brand"
        }`}
      >
        <span
          aria-hidden
          className={`flex shrink-0 items-center justify-center bg-tint-brand text-tone-brand ring-1 ring-edge-brand ${
            files.length > 0
              ? "h-10 w-10 rounded-xl sm:h-12 sm:w-12"
              : "h-12 w-12 rounded-xl"
          }`}
        >
          <IconUpload className={files.length > 0 ? "h-5 w-5 sm:h-6 sm:w-6" : "h-6 w-6"} />
        </span>
        <span className="font-display text-base font-semibold text-ink-900">
          {files.length > 0 ? "Add more photos" : "Drag and drop your receipt here"}
        </span>
        <span className={`text-sm text-ink-500 ${files.length > 0 ? "hidden" : ""}`}>or</span>
        <span className={`inline-flex min-h-tap items-center rounded-lg bg-accent-400 px-4 py-2.5 text-sm font-semibold text-accent-950 shadow-sm ${
          files.length > 0 ? "sm:ml-auto" : ""
        }`}>
          {files.length > 0 ? "Choose more photos" : "Choose photos"}
        </span>
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

      {hintText ? <p className="mt-2 text-center text-xs leading-relaxed text-ink-500">{hintText}</p> : null}

      {selectionError ? (
        <p id={`${id}-selection-error`} role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-tone-danger">
          <IconAlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span className="min-w-0">{selectionError}</span>
        </p>
      ) : null}

      {files.length > 0 ? (
        <div className="mt-4 border-t border-paper-200 pt-4">
          <p className="text-sm font-semibold text-ink-800" aria-live="polite">
            {files.length} photo{files.length === 1 ? "" : "s"} selected
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            Remove a photo or change the order before scanning.
          </p>
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
        </div>
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
