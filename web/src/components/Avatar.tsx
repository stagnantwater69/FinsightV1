import { useRef, useState, type ReactNode } from "react";
import { useToast } from "./Toast";
import { getErrorMessage } from "../lib/errors";

const SIZES = {
  md: "h-12 w-12 rounded-xl text-base",
  lg: "h-16 w-16 rounded-2xl text-xl",
} as const;

/**
 * A photo if one's been uploaded, an initials monogram if not — the same
 * fallback the rest of the app already uses for "no data yet" (see
 * EmptyState), applied to a person or a business instead of a page.
 */
export function Avatar({
  photoUrl,
  label,
  size = "md",
}: {
  photoUrl: string | null | undefined;
  /** Used to derive the 1-2 letter monogram shown when there's no photo. */
  label: string;
  size?: keyof typeof SIZES;
}) {
  const initials = label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        className={`shrink-0 object-cover ${SIZES[size]}`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-brand-700 font-display font-extrabold text-white ${SIZES[size]}`}
    >
      {initials || "?"}
    </span>
  );
}

/**
 * Avatar plus the "Change photo" affordance — a hidden file input triggered
 * by a visible button, so the control is keyboard- and screen-reader-
 * reachable rather than relying on a styled-up native input.
 */
export function AvatarUpload({
  photoUrl,
  label,
  onUpload,
  changeLabel = "Change photo",
}: {
  photoUrl: string | null | undefined;
  label: string;
  onUpload: (file: File) => Promise<void>;
  changeLabel?: ReactNode;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await onUpload(file);
      toast("Photo updated");
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar photoUrl={photoUrl} label={label} size="lg" />
      <div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={handleChange}
          aria-label={typeof changeLabel === "string" ? changeLabel : "Change photo"}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="tap rounded-lg border border-ink-200 bg-paper px-3 text-sm font-medium text-ink-700 transition hover:bg-paper-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? "Uploading…" : changeLabel}
        </button>
      </div>
    </div>
  );
}
