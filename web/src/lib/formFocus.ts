/**
 * Moves keyboard and screen-reader context to the first rejected field.
 * Call after React has rendered validation messages; the microtask lets the
 * new `aria-invalid` attributes reach the DOM before focus is resolved.
 */
export function focusFirstInvalidField(form: HTMLFormElement | null) {
  queueMicrotask(() => {
    const first = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
