import type { ReactNode } from "react";

/**
 * One preference: what it is, what it does, and the switch that changes it.
 *
 * Extracted so the two settings on Account settings are the same control
 * rather than two hand-built ones that drift apart — the same rule this
 * codebase applies everywhere else (see the ui.tsx kit).
 *
 * A real checkbox with `role="switch"`, not a styled div: it arrives in the
 * tab order, answers the space bar, and reports its own state to a screen
 * reader without any of that having to be re-implemented. The track and knob
 * are drawn from the peer's checked state.
 *
 * Tailwind's `peer-checked:` only matches a *sibling* of the checked peer (it
 * compiles to `.peer:checked ~ .peer-checked\:…`), so the input, the track and
 * the knob all have to sit at the same level — nesting the knob inside the
 * track breaks the selector and the `translate-x-5` never applies, which is
 * why the switch used to jump with no slide at all instead of animating.
 */
export function SettingSwitch({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex min-h-tap items-start justify-between gap-4 rounded-xl border border-paper-200 p-3.5 ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-900">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-500">{description}</span> : null}
      </span>
      <span className="relative mt-0.5 h-6 w-11 shrink-0">
        <input
          type="checkbox"
          role="switch"
          disabled={disabled}
          className="peer absolute inset-0 z-10 h-full w-full appearance-none opacity-0 disabled:cursor-not-allowed"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-ink-200 transition-colors duration-200 ease-in-out peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-paper shadow-sm transition-transform duration-200 ease-in-out peer-checked:translate-x-5"
        />
      </span>
    </label>
  );
}
