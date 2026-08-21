import type { ReactNode } from "react";

/**
 * One choice in the "what is this difference" question.
 *
 * A real radio rather than a styled button, so arrow keys move between the
 * options and a screen reader announces "2 of 3" — this is a single decision
 * with mutually exclusive answers, which is exactly what radios are.
 */
export function GapOption({
  name,
  checked,
  onChange,
  label,
  detail,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label
      className={`block cursor-pointer rounded-lg border p-2 transition ${
        checked ? "border-brand-500 bg-paper-50" : "border-paper-200 hover:border-paper-300"
      }`}
    >
      <span className="flex items-start gap-2">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onChange}
          className="mt-0.5 shrink-0 accent-brand-700"
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-ink-800">{label}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{detail}</span>
        </span>
      </span>
      {children}
    </label>
  );
}
