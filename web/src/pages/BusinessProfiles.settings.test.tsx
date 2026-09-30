// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { BusinessProfiles } from "./BusinessProfiles";
import { BEFORE_BUSINESS_PROFILE_SWITCH } from "../lib/navigationGuards";
import type { BusinessProfile, BusinessProfileInput } from "../lib/types";

const selectedProfile: BusinessProfile = {
  id: 41,
  name: "Harbor Cafe",
  type: "Food business",
  availableFunds: 60_000,
  expectedMonthlyExpenses: 200_000,
  operatingDays: 26,
  largeExpenseThresholdPercent: 20,
  logoUrl: null,
  createdAt: "2026-04-10T00:00:00.000Z",
  archivedAt: null,
  isArchived: false,
  recordCount: 12,
};

const updateProfile = vi.fn<
  (id: number, input: Partial<BusinessProfileInput>) => Promise<BusinessProfile>
>();
const uploadLogo = vi.fn<(id: number, file: File) => Promise<BusinessProfile>>();
const refresh = vi.fn<() => Promise<void>>();
const toast = vi.fn<(message: string) => void>();

let businessContext: {
  profiles: BusinessProfile[];
  selected: BusinessProfile | null;
  loading: boolean;
  error: string | null;
};

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({
    ...businessContext,
    updateProfile,
    uploadLogo,
    refresh,
  }),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => toast,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/business-profiles"]}>
      <Routes>
        <Route path="/business-profiles" element={<BusinessProfiles />} />
        <Route path="/onboarding" element={<p>Setup wizard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  businessContext = {
    profiles: [selectedProfile],
    selected: selectedProfile,
    loading: false,
    error: null,
  };
  updateProfile.mockReset();
  updateProfile.mockResolvedValue(selectedProfile);
  uploadLogo.mockReset();
  uploadLogo.mockResolvedValue(selectedProfile);
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  toast.mockReset();
  vi.restoreAllMocks();
});

describe("BusinessProfiles settings", () => {
  it("shows the selected business values and scopes management links to it", () => {
    renderPage();

    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Harbor Cafe");
    expect(screen.getByLabelText(/^Business type/)).toHaveValue("Food business");
    expect(screen.getByLabelText(/^Available business funds/)).toHaveValue(60_000);
    expect(screen.getByLabelText(/^Expected monthly expenses/)).toHaveValue(200_000);
    expect(screen.getByLabelText(/^Operating days per month/)).toHaveValue(26);
    expect(screen.getByLabelText(/^Flag single expenses over/)).toHaveValue(40_000);
    expect(screen.getByRole("link", { name: /manage schedule/i })).toHaveAttribute(
      "href",
      "/business-profiles/41/operating-schedule",
    );
    expect(
      screen.getByRole("link", { name: /manage notifications/i }),
    ).toHaveAttribute("href", "/business-profiles/41/recovery-notifications");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText("Everything is up to date")).toBeVisible();
  });

  it("saves the edited values against the selected profile id", async () => {
    const user = userEvent.setup();
    renderPage();

    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "Harbor Cafe and Bakery" },
    });
    fireEvent.change(screen.getByLabelText(/^Available business funds/), {
      target: { value: "72500" },
    });

    expect(screen.getByText("You have unsaved changes")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith(41, {
      name: "Harbor Cafe and Bakery",
      type: "Food business",
      availableFunds: 72_500,
      expectedMonthlyExpenses: 200_000,
      operatingDays: 26,
      largeExpenseThresholdPercent: 20,
    });
    expect(toast).toHaveBeenCalledWith("Business profile updated");
    expect(screen.getByText("Changes saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("marks edits as dirty and Cancel restores the saved values", async () => {
    const user = userEvent.setup();
    renderPage();

    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "Temporary name" },
    });
    await user.selectOptions(screen.getByLabelText(/^Business type/), "Retail store");

    expect(screen.getByText("You have unsaved changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Harbor Cafe");
    expect(screen.getByLabelText(/^Business type/)).toHaveValue("Food business");
    expect(screen.getByText("Everything is up to date")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("blocks saving invalid values before the update call", async () => {
    const user = userEvent.setup();
    renderPage();

    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "" },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Give your business a name.",
    );
    expect(screen.getByLabelText(/^Business name/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("blocks a business switch while edited values are unresolved", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();

    await user.clear(screen.getByLabelText(/^Business name/));
    await user.type(screen.getByLabelText(/^Business name/), "Unsaved cafe");
    expect(screen.getByText("You have unsaved changes")).toBeVisible();

    const switchEvent = new Event(BEFORE_BUSINESS_PROFILE_SWITCH, {
      cancelable: true,
    });
    expect(window.dispatchEvent(switchEvent)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "Leave this business profile? Your unsaved changes will be lost.",
    );
  });

  it("shows a retry state after a load failure, not the setup invitation", () => {
    businessContext = {
      profiles: [],
      selected: null,
      loading: false,
      error: "Network Error.",
    };

    renderPage();

    expect(
      screen.getByRole("heading", { name: "We couldn't load your businesses" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Continue setup" })).not.toBeInTheDocument();
  });

  it("shows the setup path only after a successful empty load", () => {
    businessContext = {
      profiles: [],
      selected: null,
      loading: false,
      error: null,
    };

    renderPage();

    expect(screen.getByText("Finish setting up your business")).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue setup" })).toHaveAttribute(
      "href",
      "/onboarding",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
