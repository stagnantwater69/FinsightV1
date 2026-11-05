// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  previousMonth: {
    month: "2026-09",
    recordedAmount: 154_000,
    recordCount: 18,
    awaitingReviewCount: 0,
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

function editCard(name: "Edit business identity" | "Edit starting figures") {
  fireEvent.click(screen.getByRole("button", { name }));
}

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

    // Saved values read as text until a card's Edit is pressed.
    expect(screen.getByText("Harbor Cafe")).toBeVisible();
    expect(screen.getByText("Food business")).toBeVisible();
    expect(screen.queryByLabelText(/^Business name/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    editCard("Edit starting figures");
    expect(screen.getByLabelText(/^Opening balance/)).toHaveValue(60_000);
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
    expect(screen.getByRole("button", { name: "Edit business identity" })).toBeDisabled();
  });

  it("saves the edited values against the selected profile id", async () => {
    const user = userEvent.setup();
    renderPage();

    editCard("Edit starting figures");
    fireEvent.change(screen.getByLabelText(/^Opening balance/), {
      target: { value: "72500" },
    });

    expect(screen.getByText("Unsaved changes")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith(41, {
      name: "Harbor Cafe",
      type: "Food business",
      availableFunds: 72_500,
      expectedMonthlyExpenses: 200_000,
      operatingDays: 26,
      largeExpenseThresholdPercent: 20,
    });
    expect(toast).toHaveBeenCalledWith("Business profile updated");
    expect(within(screen.getByRole("region", { name: "Starting figures" })).getByText("PHP 72,500")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("shows the calculated funds and the active monthly-expense source", async () => {
    renderPage();

    expect(await screen.findByText("Recorded available funds")).toBeVisible();
    expect(screen.getByText("PHP 72,500")).toBeVisible();
    expect(screen.getByText("Your starting estimate.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Is September 2026 complete?" })).toBeVisible();
    expect(screen.getByText("PHP 200,000 → PHP 154,000")).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: "Mark September 2026 complete" }));

    expect(
      await screen.findByText(
        /Actual costs for September 2026, from 18 reviewed expenses/,
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

    await user.click(await screen.findByRole("button", { name: "Mark September 2026 complete" }));

    await waitFor(() =>
      expect(setExpenseRecordsCompleteThroughMonth).toHaveBeenCalledWith(41, "2026-09"),
    );
    expect(screen.getByText(/Actual costs for September 2026, from 18 reviewed expenses/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "September 2026 is marked complete" })).toBeVisible();

    setExpenseRecordsCompleteThroughMonth.mockResolvedValue(financialPosition);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(setExpenseRecordsCompleteThroughMonth).toHaveBeenLastCalledWith(41, null),
    );
  });

  it("marks edits as dirty and Cancel restores the saved values", async () => {
    const user = userEvent.setup();
    renderPage();

    editCard("Edit business identity");
    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "Temporary name" },
    });
    await user.selectOptions(screen.getByLabelText(/^Business type/), "Retail store");

    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Harbor Cafe")).toBeVisible();
    expect(screen.getByText("Food business")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit business identity" })).toHaveFocus());
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("marks last month complete without submitting unsaved profile edits", async () => {
    const user = userEvent.setup();
    renderPage();

    editCard("Edit business identity");
    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "Unsaved cafe name" },
    });
    await user.click(await screen.findByRole("button", { name: "Mark September 2026 complete" }));

    await waitFor(() =>
      expect(setExpenseRecordsCompleteThroughMonth).toHaveBeenCalledWith(41, "2026-09"),
    );
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Unsaved cafe name");
    expect(screen.getByText("Unsaved changes")).toBeVisible();
  });

  it("will not mark last month complete while its expenses await review", async () => {
    getFinancialPosition.mockResolvedValue({
      ...financialPosition,
      previousMonth: { ...financialPosition.previousMonth, awaitingReviewCount: 2 },
    });
    renderPage();

    expect(await screen.findByText(/2 September 2026 expenses still need review/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Review now" })).toHaveAttribute("href", "/records/flagged");
    expect(screen.getByRole("button", { name: "Mark September 2026 complete" })).toBeDisabled();
    expect(setExpenseRecordsCompleteThroughMonth).not.toHaveBeenCalled();
  });

  it("treats a mark on an older month as not covering last month", async () => {
    getFinancialPosition.mockResolvedValue({
      ...financialPosition,
      monthlyExpenseBasis: {
        ...financialPosition.monthlyExpenseBasis,
        recordsCompleteThroughMonth: "2026-07",
        recordsCompleteThroughConfirmedAt: "2026-08-01T03:00:00.000Z",
      },
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Is September 2026 complete?" })).toBeVisible();
    expect(screen.getByText("Last marked complete: July 2026.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark September 2026 complete" })).toBeEnabled();
  });

  it("retries a failed financial-position load without losing profile edits", async () => {
    const user = userEvent.setup();
    getFinancialPosition
      .mockRejectedValueOnce(new Error("Financial position unavailable"))
      .mockResolvedValueOnce(financialPosition);
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Financial position unavailable");
    editCard("Edit business identity");
    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "Unsaved cafe name" },
    });
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("PHP 72,500")).toBeVisible();
    expect(getFinancialPosition).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Unsaved cafe name");
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("uploads the logo immediately without committing or clearing unsaved profile edits", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    editCard("Edit business identity");
    fireEvent.change(screen.getByLabelText(/^Business name/), {
      target: { value: "Unsaved cafe name" },
    });
    const file = new File(["logo"], "cafe.png", { type: "image/png" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input!, file);

    await waitFor(() => expect(uploadLogo).toHaveBeenCalledWith(41, file));
    expect(toast).toHaveBeenCalledWith("Logo updated");
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Unsaved cafe name");
    expect(screen.getByText("Unsaved changes")).toBeVisible();
  });

  it("aborts the previous business financial load and ignores its late response after a switch", async () => {
    let resolvePrevious!: (position: FinancialPosition) => void;
    getFinancialPosition.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePrevious = resolve;
    }));
    const view = renderPage();
    const previousSignal = getFinancialPosition.mock.calls[0]![1]!;
    const otherProfile = { ...selectedProfile, id: 99, name: "Other business" };
    const otherPosition: FinancialPosition = {
      ...financialPosition,
      availableFunds: { ...financialPosition.availableFunds, calculatedAmount: 12_345 },
    };
    businessContext = {
      ...businessContext,
      profiles: [selectedProfile, otherProfile],
      selected: otherProfile,
    };
    getFinancialPosition.mockResolvedValueOnce(otherPosition);
    view.rerender(
      <MemoryRouter initialEntries={["/business-profiles"]}>
        <Routes>
          <Route path="/business-profiles" element={<BusinessProfiles />} />
          <Route path="/onboarding" element={<p>Setup wizard</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(previousSignal.aborted).toBe(true);
    expect(await screen.findByText("PHP 12,345")).toBeVisible();
    await act(async () => resolvePrevious(financialPosition));
    expect(screen.queryByText("PHP 72,500")).not.toBeInTheDocument();
    expect(screen.getByText("Other business")).toBeVisible();
    expect(getFinancialPosition).toHaveBeenLastCalledWith(99, expect.any(AbortSignal));
  });

  it("blocks saving invalid values before the update call", async () => {
    const user = userEvent.setup();
    renderPage();

    editCard("Edit business identity");
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

    editCard("Edit business identity");
    await user.clear(screen.getByLabelText(/^Business name/));
    await user.type(screen.getByLabelText(/^Business name/), "Unsaved cafe");
    expect(screen.getByText("Unsaved changes")).toBeVisible();

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
