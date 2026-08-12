// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field, PasswordInput } from "./Field";

/**
 * The reveal control on a password box.
 *
 * Rendered rather than reasoned about, because every rule here is about what
 * is on screen at a given moment — whether the button exists, and what the
 * input's `type` is — and none of that survives being extracted into a pure
 * function. This is the second render test in the repo; see
 * RecordOriginPanel.test.tsx for why they are rare.
 */

/** A controlled host, matching how every real call site uses it. */
function Harness() {
  const [value, setValue] = useState("");
  return (
    <Field label="Password" required>
      <PasswordInput
        autoComplete="current-password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </Field>
  );
}

const toggle = () => screen.queryByRole("button", { name: /password/i });
/*
 * Anchored, because the reveal button's own accessible name ("Show password")
 * also contains the word — an unanchored match finds two elements and fails
 * on the very tests that prove the button exists.
 */
const box = () => screen.getByLabelText(/^password/i) as HTMLInputElement;

describe("PasswordInput", () => {
  /**
   * An empty box has nothing to reveal, so a control sitting in it is a
   * button that does nothing — and on the login screen it is the first thing
   * the eye lands on.
   */
  it("shows no reveal control until something is typed", () => {
    render(<Harness />);
    expect(toggle()).toBeNull();
  });

  it("offers the control once there is a password to reveal", async () => {
    render(<Harness />);
    await userEvent.type(box(), "hunter2");
    expect(toggle()).not.toBeNull();
  });

  it("masks by default and reveals only when asked", async () => {
    render(<Harness />);
    await userEvent.type(box(), "hunter2");

    // Nothing is ever shown that the owner did not just ask to see.
    expect(box().type).toBe("password");

    await userEvent.click(toggle()!);
    expect(box().type).toBe("text");

    await userEvent.click(toggle()!);
    expect(box().type).toBe("password");
  });

  /**
   * The label states the ACTION and aria-pressed carries the state. A label
   * describing the state instead would leave a screen-reader user unable to
   * tell what pressing it would do — and the icon alone says nothing.
   */
  it("names the action and announces the state separately", async () => {
    render(<Harness />);
    await userEvent.type(box(), "hunter2");

    expect(toggle()!.getAttribute("aria-label")).toBe("Show password");
    expect(toggle()!.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(toggle()!);
    expect(toggle()!.getAttribute("aria-label")).toBe("Hide password");
    expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * THE ONE THAT WOULD LEAK. Reveal, clear, retype — and without resetting,
   * the reveal state outlives the value it described, putting a password the
   * owner never asked to see on screen.
   */
  it("re-hides when the field is cleared, so a retyped password is not exposed", async () => {
    render(<Harness />);
    await userEvent.type(box(), "hunter2");
    await userEvent.click(toggle()!);
    expect(box().type).toBe("text");

    await userEvent.clear(box());
    expect(toggle()).toBeNull();

    await userEvent.type(box(), "a-different-password");
    expect(box().type).toBe("password");
  });

  /** The control must never be swept up by a form submit. */
  it("is a plain button, not a submit", async () => {
    render(<Harness />);
    await userEvent.type(box(), "hunter2");
    expect((toggle() as HTMLButtonElement).type).toBe("button");
  });

  /**
   * Switching `type` rather than masking by hand is what keeps password
   * managers working, and `autoComplete` is what they key off.
   */
  it("keeps the autocomplete hint the caller set", async () => {
    render(<Harness />);
    expect(box().getAttribute("autocomplete")).toBe("current-password");
    await userEvent.type(box(), "hunter2");
    await userEvent.click(toggle()!);
    expect(box().getAttribute("autocomplete")).toBe("current-password");
  });
});
