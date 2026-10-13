// @vitest-environment jsdom
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    profile: { firstName: "Ken", lastName: "Dela Paz", email: "ken@example.com" },
    logout: (...args: unknown[]) => mocks.logout(...args),
  }),
}));

vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({ unreadCount: 0 }),
}));

vi.mock("../context/TourContext", () => ({
  useTourOptional: () => null,
}));

vi.mock("../context/ThemeContext", () => ({
  THEMES: ["classic", "light", "dark"],
  THEME_LABELS: {
    classic: { label: "Classic" },
    light: { label: "Light" },
    dark: { label: "Dark" },
  },
  useTheme: () => ({ theme: "classic", setTheme: vi.fn() }),
}));

function CurrentPath() {
  return <span data-testid="current-path">{useLocation().pathname}</span>;
}

function renderMenu() {
  return render(
    <MemoryRouter>
      <AccountMenu />
      <CurrentPath />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.logout.mockReset();
});

describe("AccountMenu logout", () => {
  it("reports a failed logout, prevents duplicates, and allows a retry", async () => {
    let rejectLogout!: (error: Error) => void;
    mocks.logout.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectLogout = reject;
    }));
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    const logout = screen.getByRole("button", { name: "Log out" });
    fireEvent.click(logout);
    fireEvent.click(logout);

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Logging out…" })).toBeDisabled();
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");

    await act(async () => rejectLogout(new Error("Network unavailable")));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "FinSight couldn't log out this browser. You're still signed in here.",
    );
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");

    mocks.logout.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(screen.getByTestId("current-path")).toHaveTextContent("/login"));
    expect(mocks.logout).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
