// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BusinessNumbersFields } from "./BusinessFields";
import { EMPTY_DRAFT } from "../lib/businessProfileDraft";

/** With a schedule, the owner no longer types the open days; the page shows the month's count instead. */

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/business-profiles/41/operating-schedule") {
        return { data: Array.from({ length: 7 }, (_, weekday) => ({ weekday, isOpen: weekday !== 0 })) };
      }
      if (url === "/insights/recovery") return { data: { monthStart: "2026-11-01", operatingDaysThisMonth: 25 } };
      throw new Error(`unmocked GET ${url}`);
    },
  },
}));

describe("operating days with a schedule", () => {
  it("shows this month's open days instead of a field to type in", async () => {
    render(
      <MemoryRouter>
        <BusinessNumbersFields draft={EMPTY_DRAFT} errors={{}} update={vi.fn()} settings scheduleProfileId={41} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/days open in November 2026/)).toHaveTextContent("25 days open in November 2026");
    expect(screen.queryByLabelText(/^Operating days per month/)).toBeNull();
    expect(screen.getByRole("link", { name: "Edit schedule" })).toHaveAttribute("href", "/business-profiles/41/operating-schedule");
  });
});
