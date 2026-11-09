import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Shared setup for every test file, DOM-based or not.
 *
 * `cleanup` unmounts anything a component test rendered. Without it, React
 * Testing Library's queries search the whole document, so a component left
 * mounted by one test is still found by the next — producing either a
 * confusing "found multiple elements" failure or, worse, a test that passes
 * by matching the PREVIOUS test's markup. It is a no-op in the node-
 * environment files, so this runs safely for all of them.
 *
 * `jest-dom/vitest` adds the assertions that describe intent rather than
 * implementation — `toBeVisible()` and `toHaveAccessibleName()` say what a
 * user experiences, where the equivalent hand-rolled checks on class names
 * and DOM structure would pass while the thing was invisible or unreachable.
 *
 * Session storage is cleared too: the period filter remembers the owner's
 * choice for the visit, and one test choosing "All time" must not decide
 * which period the next test opens on.
 */
afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") window.sessionStorage.clear();
});

// jsdom has no <dialog> showModal()/close(); Modal only relies on the `open`
// attribute, so this is enough for any test that opens a popup.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}
