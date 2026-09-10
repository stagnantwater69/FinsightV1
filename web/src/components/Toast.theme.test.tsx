// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider, useToast } from "./Toast";

/**
 * THE TOAST HAS TO BE READABLE IN ALL THREE THEMES.
 *
 * The pill was `bg-ink-900` with `text-white`. The ink scale INVERTS with the
 * theme — in Dark, `--ink-900` resolves to 241 246 246, the near-white
 * headings step — so every confirmation the app gave was white text on a
 * near-white pill at roughly 1.09:1, along with the brand-teal tick and the
 * amber Undo. In practice, an owner on the Dark theme was never told that
 * anything they did had worked, and never saw the Undo at all.
 *
 * The pill is deliberately inverted chrome, so the fix is a surface that does
 * NOT flip with the theme: a fixed brand-scale dark (see the note on
 * `brand`/`accent` in tailwind.config.js). This asserts the class list rather
 * than a computed colour because jsdom does not resolve Tailwind or the CSS
 * custom properties — what can be proved here is that the surface is a fixed
 * token and not a theme-inverting one, which is exactly the mistake that was
 * made.
 */

function Trigger() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast("Expense saved", { actionLabel: "Undo", onAction: () => {} })}>
      fire
    </button>
  );
}

async function showToast() {
  render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "fire" }));
  const pill = screen.getByText("Expense saved").parentElement;
  if (!pill) throw new Error("toast pill not found");
  return pill;
}

describe("Toast contrast", () => {
  it("sits on a fixed dark surface rather than the theme-inverting ink scale", async () => {
    const pill = await showToast();

    expect(pill.className).toContain("bg-brand-950");
    // `ink-*` and `paper-*` flip per theme; a white-on-surface pill cannot use
    // one for its background.
    expect(pill.className).not.toMatch(/\bbg-ink-\d+\b/);
    expect(pill.className).toContain("text-white");
  });

  it("keeps the tick and the Undo action on that same fixed surface", async () => {
    const pill = await showToast();

    expect(pill.querySelector(".text-brand-300")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Undo" }).className).toContain("text-accent-200");
  });
});
