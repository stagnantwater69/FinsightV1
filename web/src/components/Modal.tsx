import { useEffect, useRef, type ReactNode } from "react";

/**
 * A general-purpose popup, for content too involved for ConfirmDialog's
 * title/body/two-buttons shape — the Records page's "Add expense" and
 * "Add sales" forms are the first callers.
 *
 * Built on native <dialog> for the same reason ConfirmDialog is: showModal()
 * supplies the focus trap, the Escape handling, and `inert` on everything
 * behind it for free. This is the one place in the app where less custom
 * code is more accessible code.
 *
 * Unlike ConfirmDialog, this is uncontrolled-by-the-provider — each caller
 * owns its own `open` boolean and renders its own <Modal>, because unlike a
 * confirmation (one shape, any caller can share a single queue) a form modal
 * carries its own state (the fields being typed into) that has to live with
 * the caller anyway.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="modal-title"
      // `cancel` fires for Escape. Routing it through onClose rather than
      // letting the browser close the dialog on its own keeps the caller's
      // `open` state in sync with what's actually on screen.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click that lands on the <dialog> element itself (not on the content
      // div inside it) is a click on the ::backdrop — the pseudo-element
      // isn't a separate DOM node, so this is the standard way to detect it.
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="modal-dialog w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-paper-200 bg-paper p-0 text-ink-900 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3 border-b border-paper-200 px-5 py-4">
        <h2 id="modal-title" className="font-display text-base font-semibold text-ink-900">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="tap -m-2 flex h-9 w-9 min-h-0 min-w-0 items-center justify-center rounded-lg text-lg leading-none text-ink-400 transition hover:bg-paper-100 hover:text-ink-800"
        >
          ×
        </button>
      </div>
      <div className="scroll-slim max-h-[75vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}
