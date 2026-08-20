// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskFinSightButton, AskFinSightDrawer } from "./AskFinSightDrawer";

/**
 * Fin's two appearances in the drawer are at two different sizes, from two
 * different crops of the same source art, and the whole point of the split is
 * that swapping them would be wrong in both places — the full scene is
 * unreadable at 24px, and the bare head wastes the opening moment. A render
 * test is the only thing that catches them being crossed over.
 */

// jsdom implements no scrolling, and the drawer pins itself to the newest
// message on every render. Not a stub of anything under test.
Element.prototype.scrollTo = () => {};

vi.mock("../lib/api", () => ({
  api: {
    // One prior turn, so the small avatar is genuinely on screen: asserting
    // the intro has no avatar is vacuous against an empty history.
    get: async () => ({
      data: [{ id: 1, question: "Which category grew the most?", answer: "Supplies, by 32%." }],
    }),
    post: async () => ({ data: {} }),
  },
}));

/**
 * The drawer renders through createPortal, so it lands in document.body and
 * NOT in render()'s container — queries against the container pass vacuously.
 */
function open() {
  render(<AskFinSightDrawer businessProfileId={1} module="Dashboard" open onClose={() => {}} />);
  return document.body;
}

describe("AskFinSightDrawer mascot", () => {
  it("opens with the full scene, at a size it can be read at", () => {
    const body = open();
    const intro = body.querySelector('img[src="/mascot/ask-fin.webp"]');
    expect(intro).not.toBeNull();
    // Width and height both pinned, and in the art's own 1.26 ratio: forcing
    // this wide composition into a square box is the failure being guarded.
    expect(intro).toHaveAttribute("width", "104");
    expect(intro).toHaveAttribute("height", "83");
  });

  it("keeps the opening mascot decorative rather than announcing it", () => {
    // The greeting text beside it already says what the drawer is for.
    const body = open();
    expect(body.querySelector('img[src="/mascot/ask-fin.webp"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("gives each AI reply the small avatar, and the opening line none", async () => {
    // The opening moment is deliberately not a <Bubble>: with one, Fin would
    // appear twice in the same block, saying the same thing. So with a single
    // prior reply on screen there is exactly one avatar, not two.
    const body = open();
    await screen.findByText("Supplies, by 32%.");
    expect(body.querySelectorAll('img[src="/mascot/ask-fin-avatar.webp"]')).toHaveLength(1);
    expect(body.querySelectorAll('img[src="/mascot/ask-fin.webp"]')).toHaveLength(1);
  });

  it("still renders the module's greeting copy next to the mascot", () => {
    open();
    expect(screen.getByText(/I can explain what's on your dashboard/i)).toBeInTheDocument();
  });
});

describe("AskFinSightButton (the floating trigger)", () => {
  it("is a real button carrying the label, since the art is decorative", async () => {
    // The owl is aria-hidden, so without a label on the button itself the
    // trigger would be an unnamed control to a screen reader.
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<AskFinSightButton onClick={onClick} />);

    const trigger = screen.getByRole("button", { name: "Ask FinSight" });
    expect(trigger.querySelector("img")).toHaveAttribute("aria-hidden", "true");

    await user.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("sits under the drawer's own overlay rather than over it", () => {
    // The drawer overlay is z-40; a trigger above that would float on top of
    // the panel it just opened.
    render(<AskFinSightButton onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Ask FinSight" }).className).toContain("z-30");
  });

  it("reserves its own space so it cannot cover the end of a page", () => {
    // Mobile exports FAB_CLEARANCE for this; here the spacer ships with the
    // trigger so a page cannot render one without the other.
    const { container } = render(<AskFinSightButton onClick={() => {}} />);
    expect(container.querySelector('div[aria-hidden="true"]')).not.toBeNull();
  });

  it("escapes its parent so `fixed` means the viewport", () => {
    /*
     * THIS SHIPPED BROKEN ONCE. AppShell's <main> animates `transform` with
     * fill-mode `both`, which leaves a computed identity MATRIX rather than
     * `none` — enough to make <main> the containing block, so the owl pinned
     * to the end of the page and only appeared after scrolling all the way
     * down. Rendering it anywhere inside the page subtree brings that back,
     * and nothing about the component's own markup would look wrong.
     *
     * The spacer stays in flow; only the button leaves.
     */
    const { container } = render(<AskFinSightButton onClick={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Ask FinSight" });

    expect(container.contains(trigger)).toBe(false);
    expect(trigger.parentElement).toBe(document.body);
  });
});
