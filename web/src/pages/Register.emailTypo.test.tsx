// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Register } from "./Register";

/**
 * `proximate69@gmail.co` is a VALID address — .co is Colombia — so no
 * validator rejects it, and registration succeeds. The confirmation email then
 * goes to an inbox nobody reads, and because registration must answer
 * identically whether or not an address is registerable, nothing on screen
 * ever explains the silence. A suggestion is the only place to catch it.
 */
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ register: vi.fn() }),
}));
vi.mock("../lib/api", () => ({ api: { post: vi.fn() } }));

function renderPage() {
  return render(
    <MemoryRouter>
      <Register />
    </MemoryRouter>,
  );
}

describe("Register email typo suggestion", () => {
  it("offers a correction for a mistyped domain, on blur", async () => {
    const user = userEvent.setup();
    renderPage();

    const email = screen.getByLabelText(/Email/);
    await user.type(email, "proximate69@gmail.co");
    // Nothing yet — second-guessing mid-typing is a form arguing with someone
    // who is doing nothing wrong.
    expect(screen.queryByText(/Did you mean/)).not.toBeInTheDocument();

    await user.tab();
    expect(await screen.findByText(/Did you mean/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "proximate69@gmail.com" })).toBeInTheDocument();
  });

  it("applies the correction when accepted", async () => {
    const user = userEvent.setup();
    renderPage();

    const email = screen.getByLabelText(/Email/) as HTMLInputElement;
    await user.type(email, "proximate69@gmail.co");
    await user.tab();
    await user.click(await screen.findByRole("button", { name: "proximate69@gmail.com" }));

    expect(email.value).toBe("proximate69@gmail.com");
    expect(screen.queryByText(/Did you mean/)).not.toBeInTheDocument();
  });

  it("never blocks submission — the address is legitimate", async () => {
    const user = userEvent.setup();
    renderPage();

    const email = screen.getByLabelText(/Email/);
    await user.type(email, "owner@gmail.co");
    await user.tab();

    // The suggestion is advice, not an error: no alert, and the submit button
    // stays usable. .co is Colombia and refusing it would be wrong.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create account/i })).toBeEnabled();
  });

  it("stays quiet for an address that is already correct", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Email/), "owner@gmail.com");
    await user.tab();
    expect(screen.queryByText(/Did you mean/)).not.toBeInTheDocument();
  });

  it("clears a stale suggestion once the address is edited again", async () => {
    const user = userEvent.setup();
    renderPage();

    const email = screen.getByLabelText(/Email/);
    await user.type(email, "owner@gmail.co");
    await user.tab();
    expect(await screen.findByText(/Did you mean/)).toBeInTheDocument();

    await user.type(email, "m");
    expect(screen.queryByText(/Did you mean/)).not.toBeInTheDocument();
  });
});
