// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { BusinessProfiles } from "./BusinessProfiles";
import { BEFORE_BUSINESS_PROFILE_SWITCH } from "../lib/navigationGuards";
import type {
  BusinessProfile,
  BusinessProfileInput,
  FinancialPosition,
} from "../lib/types";
import { invalidateServerState } from "../lib/serverStateCache";

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
const getFinancialPosition = vi.fn<
  (id: number, signal?: AbortSignal) => Promise<FinancialPosition>
>();
const setExpenseRecordsCompleteThroughMonth = vi.fn<
  (id: number, month: string | null) => Promise<FinancialPosition>
>();
const toast = vi.fn<(message: string) => void>();

const financialPosition: FinancialPosition = {
  asOfDate: "2026-10-01",
  availableFunds: {
    calculatedAmount: 72_500,
    baselineAmount: 60_000,
    baselineAt: "2026-09-01T01:00:00.000Z",
    baselineDate: "2026-09-01",
    confirmedSalesAdded: 20_000,
    confirmedExpensesDeducted: 7_500,
    confirmedSalesRecordCount: 3,
    confirmedExpenseRecordCount: 2,
    asOfDate: "2026-10-01",
  },
  monthlyExpenseBasis: {
    amount: 200_000,
    source: "owner_estimate",
    sourceMonth: null,
    ownerEstimate: 200_000,
    eligibleRecordCount: 0,
    recordsCompleteThroughMonth: null,
    recordsCompleteThroughConfirmedAt: null,
  },
};

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
    getFinancialPosition,
    setExpenseRecordsCompleteThroughMonth,
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
  getFinancialPosition.mockReset();
  getFinancialPosition.mockResolvedValue(financialPosition);
  setExpenseRecordsCompleteThroughMonth.mockReset();
  setExpenseRecordsCompleteThroughMonth.mockResolvedValue(financialPosition);
  toast.mockReset();
  vi.restoreAllMocks();
});

describe("BusinessProfiles settings", () => {
  it("shows the selected business values and scopes management links to it", () => {
    renderPage();

    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Harbor Cafe");
    expect(screen.getByLabelText(/^Business type/)).toHaveValue("Food business");
    expect(screen.getByLabelText(/^Starting available funds/)).toHaveValue(60_000);
    expect(screen.getByLabelText(/^Starting monthly expense estimate/)).toHaveValue(200_000);
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
    fireEvent.change(screen.getByLabelText(/^Starting available funds/), {
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

  it("shows the calculated funds and the active monthly-expense source", async () => {
    renderPage();

    expect(await screen.findByText("Recorded available funds")).toBeVisible();
    expect(screen.getByText("PHP 72,500")).toBeVisible();
    expect(
      screen.getByText(/Using your starting estimate because the previous month is not confirmed complete/),
    ).toBeVisible();
    expect(getFinancialPosition).toHaveBeenCalledWith(41, expect.any(AbortSignal));
  });

  it("refreshes the financial panel only for its business", async () => {
    const refreshedPosition: FinancialPosition = {
      ...financialPosition,
      availableFunds: {
        ...financialPosition.availableFunds,
        calculatedAmount: 81_000,
        confirmedSalesAdded: 28_500,
      },
    };
    getFinancialPosition
      .mockResolvedValueOnce(financialPosition)
      .mockResolvedValueOnce(refreshedPosition);
    renderPage();

    expect(await screen.findByText("PHP 72,500")).toBeVisible();
    expect(getFinancialPosition).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateServerState({
        businessProfileId: 99,
        tags: ["financial"],
      });
    });
    expect(getFinancialPosition).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateServerState({
        businessProfileId: selectedProfile.id,
        tags: ["financial"],
      });
    });

    expect(await screen.findByText("PHP 81,000")).toBeVisible();
    expect(getFinancialPosition).toHaveBeenCalledTimes(2);
  });

  it("uses a completeness write response without an invalidation-driven duplicate read", async () => {
    const user = userEvent.setup();
    const septemberPosition: FinancialPosition = {
      ...financialPosition,
      monthlyExpenseBasis: {
        ...financialPosition.monthlyExpenseBasis,
        amount: 154_000,
        source: "previous_complete_month",
        sourceMonth: "2026-09",
        eligibleRecordCount: 18,
        recordsCompleteThroughMonth: "2026-09",
        recordsCompleteThroughConfirmedAt: "2026-10-01T03:00:00.000Z",
      },
    };
    setExpenseRecordsCompleteThroughMonth.mockImplementation(async () => {
      invalidateServerState({
        businessProfileId: selectedProfile.id,
        tags: ["financial"],
      });
      return septemberPosition;
    });
    renderPage();

    fireEvent.change(
      await screen.findByLabelText("Expense records complete through"),
      { target: { value: "2026-09" } },
    );
    await user.click(screen.getByRole("button", { name: "Save complete month" }));

    expect(
      await screen.findByText(
        /From 18 confirmed expense records in September 2026/,
      ),
    ).toBeVisible();
    expect(getFinancialPosition).toHaveBeenCalledTimes(1);
  });

  it("sets and clears the latest month with complete expense records", async () => {
    const user = userEvent.setup();
    const septemberPosition: FinancialPosition = {
      ...financialPosition,
      monthlyExpenseBasis: {
        ...financialPosition.monthlyExpenseBasis,
        amount: 154_000,
        source: "previous_complete_month",
        sourceMonth: "2026-09",
        eligibleRecordCount: 18,
        recordsCompleteThroughMonth: "2026-09",
        recordsCompleteThroughConfirmedAt: "2026-10-01T03:00:00.000Z",
      },
    };
    setExpenseRecordsCompleteThroughMonth.mockResolvedValue(septemberPosition);
    renderPage();

    const month = await screen.findByLabelText("Expense records complete through");
    fireEvent.change(month, { target: { value: "2026-09" } });
    await user.click(screen.getByRole("button", { name: "Save complete month" }));

    await waitFor(() =>
      expect(setExpenseRecordsCompleteThroughMonth).toHaveBeenCalledWith(41, "2026-09"),
    );
    expect(screen.getByText(/From 18 confirmed expense records in September 2026/)).toBeVisible();

    setExpenseRecordsCompleteThroughMonth.mockResolvedValue(financialPosition);
    await user.click(screen.getByRole("button", { name: "Clear confirmation" }));
    await waitFor(() =>
      expect(setExpenseRecordsCompleteThroughMonth).toHaveBeenLastCalledWith(41, null),
    );
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
