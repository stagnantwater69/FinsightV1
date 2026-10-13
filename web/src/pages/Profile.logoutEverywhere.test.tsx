// @vitest-environment jsdom
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../components/ConfirmDialog";
import { Profile } from "./Profile";

const mocks = vi.hoisted(() => ({
  logoutEverywhere: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    profile: {
      id: 1,
      firstName: "Ken",
      middleName: null,
      lastName: "Dela Paz",
      email: "ken@example.com",
      phoneNumber: null,
      status: "ACTIVE",
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    updateProfile: vi.fn(),
    uploadAvatar: vi.fn(),
    logout: vi.fn(),
    logoutEverywhere: (...args: unknown[]) => mocks.logoutEverywhere(...args),
  }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ profiles: [{ id: 1, name: "Sari-sari" }] }),
}));

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ConfirmProvider>
        <Profile />
      </ConfirmProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.logoutEverywhere.mockReset();
});

describe("Profile global logout", () => {
  it("reports an unconfirmed revocation, keeps the action available, and sends only one request", async () => {
    let reject!: (error: Error) => void;
    mocks.logoutEverywhere.mockImplementation(() => new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Log out on all devices" }));
    await user.click(screen.getByRole("button", { name: "Log out everywhere" }));

    const pending = screen.getByRole("button", { name: "Signing out…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(mocks.logoutEverywhere).toHaveBeenCalledTimes(1);

    await act(async () => reject(new Error("Network unavailable")));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "FinSight couldn't confirm that your other devices' refresh sessions were revoked. You're still signed in here.",
    );
    expect(screen.getByRole("button", { name: "Log out on all devices" })).toBeEnabled();
  });
});
