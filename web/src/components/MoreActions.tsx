import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useDismiss } from "../lib/hooks";

export type MoreAction =
  | { label: string; onSelect: () => void; danger?: boolean; to?: never }
  | { label: string; to: string; onSelect?: never; danger?: never };

/**
 * A button that opens a short list of actions. A disclosure (button +
 * aria-expanded) rather than an ARIA menu: Tab and Enter work as everywhere
 * else, and useDismiss handles Escape and outside clicks.
 */
export function MoreActions({
  trigger,
  label,
  actions,
  triggerClassName,
  align = "right",
}: {
  trigger: ReactNode;
  /** Accessible name when the trigger has no visible text. */
  label?: string;
  actions: MoreAction[];
  triggerClassName: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { ref, triggerRef } = useDismiss(open, close);
  const item = "tap flex w-full items-center rounded-lg px-3 text-left text-sm font-medium transition";

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open ? (
        <ul
          className={`absolute z-30 mt-1 min-w-[11rem] rounded-xl bg-paper p-1 shadow-lg ring-1 ring-paper-200 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {actions.map((action) => (
            <li key={action.label}>
              {action.to !== undefined ? (
                <Link to={action.to} onClick={close} className={`${item} text-ink-800 hover:bg-paper-100`}>
                  {action.label}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    action.onSelect();
                  }}
                  className={`${item} ${
                    action.danger ? "text-tone-danger hover:bg-tint-danger" : "text-ink-800 hover:bg-paper-100"
                  }`}
                >
                  {action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
