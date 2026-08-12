import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Transient confirmations — the mockup's `toast()`.
 *
 * Why this exists: several actions (save, switch business, mark reviewed)
 * previously confirmed by navigating away, which left the owner to infer that
 * it worked. A toast states it.
 *
 * Accessibility: the viewport is a polite live region, so a screen reader
 * announces the message without stealing focus.
 *
 * The role depends on whether the toast carries an action, and this is not a
 * detail. It used to be unconditionally `role="status"` on the reasoning that
 * "none of these are actionable" — true until undo existed. A toast with an
 * Undo button IS actionable, and a status region is the wrong container for a
 * control: it has to be reachable by Tab, which also means the viewport cannot
 * be `pointer-events-none` while one is on screen. So an actionable toast
 * renders as a `group` and a plain one stays a `status`.
 *
 * Still deliberately NOT used for errors. A message that vanishes after a few
 * seconds is the wrong place for something the owner may need to act on —
 * that belongs in an <Alert> or a <FormError> next to the thing that failed.
 */

interface ToastAction {
  /** Restate the verb — "Undo", not "OK". */
  actionLabel: string;
  onAction: () => void;
}

interface ToastItem extends Partial<ToastAction> {
  id: number;
  message: string;
}

type ToastFn = (message: string, action?: ToastAction) => void;

const ToastContext = createContext<ToastFn | null>(null);

// A plain confirmation is read at a glance. One with an action has to be read,
// understood and decided on before it disappears — 3.2s is not enough time for
// that, and an undo the owner could not reach in time is worse than no undo.
const PLAIN_MS = 3200;
const ACTIONABLE_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (message, action) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, ...action }]);
      window.setTimeout(() => dismiss(id), action ? ACTIONABLE_MS : PLAIN_MS);
    },
    [dismiss],
  );

  // Stable identity so consumers don't re-render on every toast change.
  const value = useMemo(() => toast, [toast]);

  const hasAction = toasts.some((t) => t.actionLabel);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role={hasAction ? "group" : "status"}
        aria-live="polite"
        aria-label={hasAction ? "Notifications" : undefined}
        // The viewport spans the full width, so it stays click-through and each
        // toast re-enables pointer events on itself. Making the container
        // clickable to support the Undo button would block a horizontal strip
        // of the page underneath it.
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[200] flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex max-w-full animate-toast-in items-center gap-2.5 rounded-full bg-ink-900 py-2.5 pl-4 pr-2.5 text-sm font-medium text-white shadow-lg"
          >
            <span aria-hidden className="text-brand-300">
              ✓
            </span>
            <span className="min-w-0 truncate">{t.message}</span>
            {t.actionLabel ? (
              <button
                type="button"
                onClick={() => {
                  t.onAction?.();
                  dismiss(t.id);
                }}
                className="shrink-0 rounded-full px-2.5 py-1 font-semibold text-accent-200 underline-offset-2 hover:bg-white/10 hover:underline"
              >
                {t.actionLabel}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Returns `toast(message, action?)`. Safe to call outside a provider (it
 * becomes a no-op) so a component is never coupled to being mounted inside
 * one — the confirmation is a nicety, never load-bearing.
 */
export function useToast() {
  return useContext(ToastContext) ?? (() => undefined);
}
