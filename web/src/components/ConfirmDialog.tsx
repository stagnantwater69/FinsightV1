import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";

/**
 * The confirmation dialog, replacing three native `window.confirm()` calls.
 *
 * Why the native one had to go: it is unstyleable and unthemed, so it arrived
 * as an OS grey box in the middle of a themed app; it ignores
 * prefers-reduced-motion; and it is synchronous and blocking, which meant the
 * Archive button had no pending state until after the user had already
 * answered. The archive case was also trying to render a three-line
 * explanation inside an alert box that gives a title and a body no structural
 * distinction at all.
 *
 * Why <dialog> rather than a hand-rolled overlay: `showModal()` supplies the
 * focus trap, the Escape handling, the backdrop, and `inert` on everything
 * behind it — all four of which are easy to write badly. This is the one place
 * in the app where less custom code is more accessible code, so the component
 * leans on the platform and styles the backdrop through `::backdrop`.
 *
 * The confirm button always restates the action's verb ("Delete record", never
 * "OK"), following the rule Confirmation.tsx already sets for the other
 * direction ("Save changes" -> "Changes saved"). A dialog whose buttons are
 * "OK" and "Cancel" makes the user re-read the question to work out which one
 * does the thing.
 *
 * Destructive confirms use Button's outlined `danger` variant rather than a
 * red fill, so the dangerous path never looks like the primary one — see the
 * variant table in Button.tsx.
 */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** Restate the verb. "Delete record", not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "brand";
}

type Resolver = (confirmed: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setRequest(options);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  // showModal() has to run after the <dialog> is in the DOM, which is why this
  // is an effect on `request` rather than part of the confirm() call.
  useEffect(() => {
    if (!request) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // Cancel takes focus on a destructive dialog: the safe choice should be
    // the one a hurried Enter keypress lands on.
    if (request.tone !== "brand") cancelRef.current?.focus();
  }, [request]);

  const settle = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    dialogRef.current?.close();
    setRequest(null);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {request ? (
        <dialog
          ref={dialogRef}
          aria-labelledby="confirm-title"
          // `cancel` fires for Escape and for the backdrop close. Routing it
          // through settle() means a dismissed dialog resolves false rather
          // than leaving the caller's promise pending forever.
          onCancel={(e) => {
            e.preventDefault();
            settle(false);
          }}
          className="confirm-dialog w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-paper-200 bg-paper p-0 text-ink-900 shadow-lg"
        >
          <div className="p-5">
            <h2 id="confirm-title" className="text-base font-semibold text-ink-900">
              {request.title}
            </h2>
            {request.body ? (
              <div className="mt-2 text-sm leading-relaxed text-ink-600">{request.body}</div>
            ) : null}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button ref={cancelRef} type="button" variant="secondary" onClick={() => settle(false)}>
                {request.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                type="button"
                variant={request.tone === "brand" ? "primary" : "danger"}
                onClick={() => settle(true)}
              >
                {request.confirmLabel}
              </Button>
            </div>
          </div>
        </dialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

/**
 * Returns `confirm(options) => Promise<boolean>`.
 *
 * Outside a provider it resolves false rather than throwing — refusing to do
 * the destructive thing is the safe failure for a missing confirmation, and it
 * keeps a component from being coupled to where it is mounted.
 */
export function useConfirm() {
  return useContext(ConfirmContext) ?? (async () => false);
}
