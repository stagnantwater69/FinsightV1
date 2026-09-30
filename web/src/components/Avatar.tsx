import { useRef, useState, type ReactNode } from "react";
import { useToast } from "./Toast";
import { getErrorMessage } from "../lib/errors";

const SIZES = {
  md: "h-12 w-12 text-base",
  lg: "h-16 w-16 text-xl",
  xl: "h-20 w-20 text-2xl",
} as const;

const SHAPES = {
  soft: "rounded-2xl",
  circle: "rounded-full",
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
  shape = "soft",
}: {
  photoUrl: string | null | undefined;
  /** Used to derive the 1-2 letter monogram shown when there's no photo. */
  label: string;
  size?: keyof typeof SIZES;
  shape?: keyof typeof SHAPES;
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
        className={`shrink-0 object-cover ${SIZES[size]} ${SHAPES[shape]}`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-tint-brand font-display font-semibold text-tone-brand ring-1 ring-edge-brand ${SIZES[size]} ${SHAPES[shape]}`}
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
  details,
  helpText,
  buttonIcon,
  size = "lg",
  shape = "soft",
  layout = "row",
  successMessage = "Photo updated",
}: {
  photoUrl: string | null | undefined;
  label: string;
  onUpload: (file: File) => Promise<void>;
  changeLabel?: ReactNode;
  /** Optional identity copy shown beside the avatar and above the upload action. */
  details?: ReactNode;
  helpText?: ReactNode;
  buttonIcon?: ReactNode;
  size?: keyof typeof SIZES;
  shape?: keyof typeof SHAPES;
  layout?: "row" | "stacked";
  successMessage?: string;
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
      toast(successMessage);
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  // Wraps so "Change photo" and the identity details drop under the avatar at
  // a 160px viewport (a 320px phone at 200% zoom) instead of overflowing.
  return (
    <div
      className={
        layout === "stacked"
          ? "flex min-w-0 flex-col items-center text-center"
          : "flex min-w-0 flex-wrap items-center gap-4"
      }
    >
      <Avatar photoUrl={photoUrl} label={label} size={size} shape={shape} />
      <div className={`min-w-0 ${layout === "stacked" ? "mt-4" : ""}`}>
        {details ? <div className="mb-2 min-w-0">{details}</div> : null}
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
          className="tap inline-flex items-center justify-center gap-2 rounded-lg border border-ink-200 bg-paper px-3 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? null : buttonIcon}
          {uploading ? "Uploading…" : changeLabel}
        </button>
        {helpText ? (
          <p className="mt-2 max-w-xs text-xs leading-relaxed text-ink-500">
            {helpText}
          </p>
        ) : null}
      </div>
    </div>
  );
}
