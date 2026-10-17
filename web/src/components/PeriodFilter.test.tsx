// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodFilter } from "./PeriodFilter";

const { setSelection } = vi.hoisted(() => ({ setSelection: vi.fn() }));
let months: string[];
vi.mock("../context/ReportingPeriodContext", () => ({
  useReportingPeriod: () => ({
    selection: { kind: "month", month: "2026-01" },
    setSelection,
    months,
    monthsState: "ready",
    refreshMonths: vi.fn(),
  }),
}));

beforeEach(() => {
  setSelection.mockReset();
  months = Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, "0")}`);
});

describe("month picker keyboard navigation", () => {
  it("moves vertically by one four-column row and selects the focused month", async () => {
    const user = userEvent.setup();
    render(<PeriodFilter />);
    const trigger = screen.getByRole("combobox", { name: "Month" });
    await user.click(trigger);
    expect(screen.getByRole("option", { name: "January 2026" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "May 2026" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(screen.getByRole("option", { name: "October 2026" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "June 2026" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(setSelection).toHaveBeenCalledWith({ kind: "month", month: "2026-06" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("skips unavailable months and supports endpoints and Escape without changing the selection", async () => {
    const user = userEvent.setup();
    months = ["2026-01", "2026-06", "2026-09", "2025-12"];
    render(<PeriodFilter />);
    const trigger = screen.getByRole("combobox", { name: "Month" });
    trigger.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: "June 2026" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "December 2025" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("option", { name: "January 2026" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(setSelection).not.toHaveBeenCalled();
  });
});
