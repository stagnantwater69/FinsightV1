// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../components/ConfirmDialog";
import { Profile } from "./Profile";

const mocks = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  logout: vi.fn(),
  logoutEverywhere: vi.fn(),
  businesses: {
    profiles: [{ id: 1, name: "Sari-sari" }] as Array<{
      id: number;
      name: string;
    }>,
    loading: false,
    error: null as string | null,
  },
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
    updateProfile: (...args: unknown[]) => mocks.updateProfile(...args),
    uploadAvatar: (...args: unknown[]) => mocks.uploadAvatar(...args),
    logout: (...args: unknown[]) => mocks.logout(...args),
    logoutEverywhere: (...args: unknown[]) => mocks.logoutEverywhere(...args),
  }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => mocks.businesses,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ConfirmProvider>
        <Profile />
      </ConfirmProvider>
    </MemoryRouter>,
  );
}

function firstNameInput() {
  return screen.getByRole("textbox", { name: /^First name/ });
}

function lastNameInput() {
  return screen.getByRole("textbox", { name: /^Last name/ });
}

beforeEach(() => {
  mocks.updateProfile.mockReset().mockResolvedValue(undefined);
  mocks.uploadAvatar.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.logoutEverywhere.mockReset().mockResolvedValue(undefined);
  mocks.businesses.profiles = [{ id: 1, name: "Sari-sari" }];
  mocks.businesses.loading = false;
  mocks.businesses.error = null;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Profile details", () => {
  it("opens the editor and discards a cancelled draft", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(firstNameInput()).toHaveValue("Ken");
    expect(lastNameInput()).toHaveValue("Dela Paz");

    await user.clear(firstNameInput());
    await user.type(firstNameInput(), "Maria");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox", { name: /^First name/ })).not.toBeInTheDocument();
    expect(screen.getByText("Ken")).toBeInTheDocument();
    expect(mocks.updateProfile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(firstNameInput()).toHaveValue("Ken");
  });

  it("trims profile values, saves once, and returns to read mode", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    await user.clear(firstNameInput());
    await user.type(firstNameInput(), "  Maria  ");
    await user.clear(lastNameInput());
    await user.type(lastNameInput(), "  Santos  ");
    await user.type(screen.getByRole("textbox", { name: /^Middle name/ }), "   ");
    await user.type(
      screen.getByRole("textbox", { name: /^Phone number/ }),
      " 09171234567 ",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mocks.updateProfile).toHaveBeenCalledWith({
        firstName: "Maria",
        middleName: null,
        lastName: "Santos",
        phoneNumber: "09171234567",
      });
    });
    expect(mocks.updateProfile).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getAllByText("Profile updated.").length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("textbox", { name: /^First name/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit profile" })).toBeInTheDocument();
  });

  it("rejects whitespace-only required values at their fields", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    await user.clear(firstNameInput());
    await user.type(firstNameInput(), "   ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(firstNameInput()).toHaveAttribute("aria-invalid", "true");
    expect(firstNameInput()).toHaveAccessibleDescription("Enter your first name.");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your first name.");
    expect(lastNameInput()).not.toHaveAttribute("aria-invalid");
    expect(mocks.updateProfile).not.toHaveBeenCalled();

    await user.type(firstNameInput(), "Maria");
    expect(firstNameInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter your first name.")).not.toBeInTheDocument();
  });

  it("binds server field errors to the matching control and clears them on edit", async () => {
    mocks.updateProfile.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        data: {
          error: "Validation failed",
          details: {
            fieldErrors: {
              phoneNumber: ["Enter a valid phone number."],
            },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const phoneInput = screen.getByRole("textbox", { name: /^Phone number/ });
    await waitFor(() => {
      expect(phoneInput).toHaveAttribute("aria-invalid", "true");
    });
    expect(phoneInput).toHaveAccessibleDescription("Enter a valid phone number.");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid phone number.");
    expect(screen.queryByText("Validation failed")).not.toBeInTheDocument();

    await user.type(phoneInput, "09171234567");
    expect(phoneInput).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter a valid phone number.")).not.toBeInTheDocument();
  });
});

describe("Profile business count", () => {
  it("uses the loaded active-business list and correct plural form", () => {
    mocks.businesses.profiles = [
      { id: 1, name: "Sari-sari" },
      { id: 2, name: "Bakery" },
      { id: 3, name: "Laundry" },
    ];

    renderPage();

    expect(screen.getByText("3 active business profiles")).toBeInTheDocument();
  });

  it("does not present a stale count while businesses are loading", () => {
    mocks.businesses.loading = true;
    mocks.businesses.profiles = [];

    renderPage();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/active business profile/)).not.toBeInTheDocument();
  });

  it("does not misreport a failed business load as an empty account", () => {
    mocks.businesses.error = "Could not load businesses.";
    mocks.businesses.profiles = [];

    renderPage();

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/0 active business profiles/)).not.toBeInTheDocument();
  });
});

describe("Password editor focus", () => {
  it("moves focus into the editor and restores it when cancelled", async () => {
    const user = userEvent.setup();
    renderPage();

    const trigger = screen.getByRole("button", { name: "Change password" });
    await user.click(trigger);

    expect(screen.getByLabelText(/^Current password/)).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Change password" })).toHaveFocus();
  });
});
