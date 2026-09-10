// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Login } from "./Login";

/**
 * Web login's state and accessibility contract.
 *
 * Mobile asserts the same rejected-submit behaviour in
 * `mobile/tests/render/auth.test.tsx`. Keeping a rendered web counterpart is
 * what prevents the two entry experiences from drifting while their layouts
 * remain appropriately platform-specific.
 */

const login = vi.fn();

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ login }),
}));

function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderLogin(options?: { sessionExpired?: boolean }) {
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/login",
          state: options?.sessionExpired ? { sessionExpired: true } : null,
        },
      ]}
    >
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/business-profiles" element={<p>Businesses</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

const emailBox = () => screen.getByRole("textbox", { name: /email/i }) as HTMLInputElement;
const passwordBox = () => screen.getByLabelText(/^password/i) as HTMLInputElement;

beforeAll(() => {
  // jsdom has focus but no layout/scrolling implementation. The production
  // path is still exercised; only the missing browser primitive is supplied.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  login.mockReset();
  window.localStorage.clear();
});

describe("Login", () => {
  it("marks invalid fields, announces their reasons, and avoids a request", async () => {
    renderLogin();

    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(emailBox()).toHaveAttribute("aria-invalid", "true");
    expect(passwordBox()).toHaveAttribute("aria-invalid", "true");
    expect(emailBox()).toHaveAccessibleDescription("Enter your email address.");
    expect(passwordBox()).toHaveAccessibleDescription("Enter your password.");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(login).not.toHaveBeenCalled();
  });

  it("clears a field's error as it is corrected and retains the other input", async () => {
    renderLogin();
    await userEvent.type(passwordBox(), "owner-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(emailBox()).toHaveAttribute("aria-invalid", "true");
    expect(passwordBox()).toHaveValue("owner-password");

    await userEvent.type(emailBox(), "owner@example.com");

    expect(emailBox()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter your email address.")).not.toBeInTheDocument();
    expect(passwordBox()).toHaveValue("owner-password");
  });

  it("preserves both fields and exposes a form-level server or network error", async () => {
    login.mockRejectedValueOnce(new Error("The network is unavailable."));
    renderLogin();

    await userEvent.type(emailBox(), "owner@example.com");
    await userEvent.type(passwordBox(), "owner-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The network is unavailable.");
    expect(emailBox()).toHaveValue("owner@example.com");
    expect(passwordBox()).toHaveValue("owner-password");
  });

  it("announces an expired session before the form", () => {
    renderLogin({ sessionExpired: true });

    expect(screen.getByRole("status")).toHaveTextContent("Your session expired — please log in again.");
  });

  it("disables duplicate submission, then saves the verified address and navigates", async () => {
    let resolveLogin: (() => void) | undefined;
    login.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    renderLogin();

    await userEvent.type(emailBox(), " owner@example.com ");
    await userEvent.type(passwordBox(), "owner-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    const busyButton = screen.getByRole("button", { name: "Logging in…" });
    expect(busyButton).toBeDisabled();
    expect(login).toHaveBeenCalledTimes(1);

    resolveLogin?.();
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/business-profiles"));
    expect(window.localStorage.getItem("finsight.saved-email")).toBe("owner@example.com");
  });
});
