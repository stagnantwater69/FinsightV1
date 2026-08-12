import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link } from "react-router-dom";

/**
 * Buttons, with the accent rule and the 44px tap floor built in.
 *
 * Variants:
 *   primary  — amber fill + DARK ink. The accent colour, so it is rare by
 *              construction: landing CTAs and Save/Confirm actions only.
 *              Dark ink rather than white because white on amber measures
 *              2.04:1 and fails — see ACCENT in lib/chartPalette.ts.
 *   brand    — teal fill + white ink. The everyday affirmative action.
 *   secondary— outlined. Neutral alternatives.
 *   ghost    — text only. Tertiary / dismissive.
 *   danger   — outlined red. Destructive-ish (archive), never a plain fill,
 *              so it can't be mistaken for the primary path.
 */
type Variant = "primary" | "brand" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-400 text-ink-900 font-semibold hover:bg-accent-500 active:bg-accent-500 shadow-sm",
  brand: "bg-brand-600 text-white font-medium hover:bg-brand-700 active:bg-brand-800",
  secondary: "border border-ink-200 bg-paper text-ink-700 font-medium hover:bg-paper-100 active:bg-paper-200",
  ghost: "text-ink-500 font-medium hover:text-ink-800 hover:bg-paper-100",
  danger: "border border-edge-danger bg-paper text-tone-danger font-medium hover:bg-tint-danger",
};

// Every size clears 44px of height. `sm` uses padding to get there rather than
// a smaller box, so a visually compact button is still comfortably tappable.
const SIZES: Record<Size, string> = {
  sm: "min-h-tap px-3 py-2 text-sm",
  md: "min-h-tap px-4 py-2.5 text-sm",
  lg: "min-h-tap px-5 py-3 text-base",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60";

function classesFor(variant: Variant, size: Size, fullWidth: boolean, className: string) {
  return [BASE, VARIANTS[variant], SIZES[size], fullWidth ? "w-full" : "", className].filter(Boolean).join(" ");
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  children: ReactNode;
  /**
   * Forwarded to the underlying <button>, for the callers that have to move
   * focus onto it — the confirmation dialog focuses Cancel on open. React 19
   * takes `ref` as an ordinary prop, so this needs no forwardRef wrapper.
   */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "brand",
  size = "md",
  fullWidth = false,
  className = "",
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button ref={ref} className={classesFor(variant, size, fullWidth, className)} {...rest}>
      {children}
    </button>
  );
}

/** Same visual language for router links, so a link CTA matches a button CTA. */
export function ButtonLink({
  to,
  state,
  variant = "brand",
  size = "md",
  fullWidth = false,
  className = "",
  children,
}: {
  to: string;
  /** Router state to carry across, e.g. the setup wizard's `fromOnboarding`. */
  state?: unknown;
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} state={state} className={classesFor(variant, size, fullWidth, className)}>
      {children}
    </Link>
  );
}
