// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FutureDatedRecordsProvider } from "../context/FutureDatedRecordsContext";
import type { FutureDatedRecords } from "../lib/types";
import { FutureDateGate, isGatedPath } from "./FutureDateGate";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: { get: mocks.get, delete: mocks.delete } }));
vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1, timezone: "Asia/Manila" } }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ logout: mocks.logout }) }));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("./Toast", () => ({ useToast: () => mocks.toast }));

const BLOCKED: FutureDatedRecords = {
  today: "2026-09-17",
  total: 2,
  truncated: false,
  records: [
    { id: 3, type: "sales", date: "2026-09-20", description: "Weekend sales", amount: 7000, vendor: null, categoryName: null },
    { id: 5, type: "expense", date: "2026-10-05", description: "Tablet", amount: 5000, vendor: "Gadget Shop", categoryName: "Equipment" },
  ],
};
const CLEAR: FutureDatedRecords = { today: "2026-09-17", total: 0, truncated: false, records: [] };

/** An edit page that "saves" and returns to the dashboard, as the real ones do. */
function EditStub() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/dashboard")}>
      Save changes
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FutureDatedRecordsProvider>
        <FutureDateGate>
          <Routes>
            <Route path="/dashboard" element={<p>Dashboard figures</p>} />
            <Route path="/insights/expense-behavior" element={<p>Expense insight figures</p>} />
            <Route path="/records/expenses/:id/edit" element={<EditStub />} />
            <Route path="/profile" element={<p>Profile page</p>} />
          </Routes>
        </FutureDateGate>
      </FutureDatedRecordsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.get.mockResolvedValue({ data: BLOCKED });
  mocks.delete.mockResolvedValue({ data: null });
  mocks.confirm.mockResolvedValue(true);
});

describe("FutureDateGate", () => {
  it("replaces a gated page with the correction screen and focuses its heading", async () => {
    renderAt("/insights/expense-behavior");
    const heading = await screen.findByRole("heading", { level: 1, name: "Fix future-dated records" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByText("Expense insight figures")).not.toBeInTheDocument();
    expect(screen.getByText(/2 records are dated after today/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Records to fix" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(mocks.get).toHaveBeenCalledWith("/records/future-dated", { params: { businessProfileId: 1 } });
  });

  it("cannot be dismissed with Escape and offers no close button", async () => {
    const user = userEvent.setup();
    renderAt("/dashboard");
    await screen.findByRole("heading", { name: "Fix future-dated records" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "Fix future-dated records" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close|dismiss/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard figures")).not.toBeInTheDocument();
  });

  it("shows nothing of a gated page before the first check answers", () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderAt("/dashboard");
    expect(screen.queryByText("Dashboard figures")).not.toBeInTheDocument();
  });

  it("keeps the edit forms and account pages open, so there is always a way out", async () => {
    renderAt("/profile");
    expect(await screen.findByText("Profile page")).toBeInTheDocument();
  });

  it("keeps support and log out on the screen", async () => {
    const user = userEvent.setup();
    renderAt("/dashboard");
    expect(await screen.findByRole("link", { name: "Contact support" })).toHaveAttribute("href", "/contact");
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(mocks.logout).toHaveBeenCalled();
  });

  it("edits a record, rechecks on return, and unlocks when nothing is left", async () => {
    const user = userEvent.setup();
    renderAt("/dashboard");
    await user.click(await screen.findByRole("link", { name: "Edit Tablet, dated Oct 5, 2026" }));
    // The edit form itself is not gated.
    const save = await screen.findByRole("button", { name: "Save changes" });

    mocks.get.mockResolvedValue({ data: CLEAR });
    await user.click(save);
    expect(await screen.findByText("Dashboard figures")).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith("All dates are fixed. Everything is unlocked.");
  });

  it("deletes after confirmation, rechecks, and stays locked while any record is left", async () => {
    const user = userEvent.setup();
    renderAt("/dashboard");
    mocks.get.mockResolvedValueOnce({ data: { ...BLOCKED, total: 1, records: [BLOCKED.records[1]!] } });
    await user.click(await screen.findByRole("button", { name: /Delete Weekend sales, dated/ }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Delete record", tone: "danger" }));
    expect(mocks.delete).toHaveBeenCalledWith("/records/sales/3", {
      serverStateScope: { businessProfileId: 1 },
    });
    expect(await screen.findByText(/1 record is dated after today/)).toBeInTheDocument();
    expect(screen.queryByText("Dashboard figures")).not.toBeInTheDocument();

    mocks.get.mockResolvedValueOnce({ data: CLEAR });
    await user.click(screen.getByRole("button", { name: /Delete Tablet, dated/ }));
    expect(mocks.delete).toHaveBeenCalledWith("/records/expenses/5", {
      serverStateScope: { businessProfileId: 1 },
    });
    expect(await screen.findByText("Dashboard figures")).toBeInTheDocument();
  });

  it("does nothing when the owner cancels the delete", async () => {
    const user = userEvent.setup();
    mocks.confirm.mockResolvedValue(false);
    renderAt("/dashboard");
    await user.click(await screen.findByRole("button", { name: /Delete Tablet, dated/ }));
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("fails open when the check itself fails, since the figures already leave these records out", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderAt("/dashboard");
    expect(await screen.findByText("Dashboard figures")).toBeInTheDocument();
  });

  it("lets a clear business straight through", async () => {
    mocks.get.mockResolvedValue({ data: CLEAR });
    renderAt("/dashboard");
    expect(await screen.findByText("Dashboard figures")).toBeInTheDocument();
  });
});

describe("isGatedPath", () => {
  it.each([
    ["/dashboard", true],
    ["/insights/recovery", true],
    ["/records", true],
    ["/records/expenses/new", true],
    ["/records/csv-imports/new", true],
    ["/records/expenses/12/edit", false],
    ["/records/sales/4/edit", false],
    ["/profile", false],
    ["/account-settings", false],
    ["/business-profiles/1/edit", false],
    ["/notifications", false],
  ])("%s gated: %s", (path, gated) => {
    expect(isGatedPath(path)).toBe(gated);
  });
});
