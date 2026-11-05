// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BusinessProfileForm } from "./BusinessProfileForm";

vi.mock("../lib/api", () => ({
  api: { get: async () => ({ data: [] }) },
}));

describe("settings cards", () => {
  it("show saved values until Edit, one card at a time, and Escape cancels", () => {
    render(
      <MemoryRouter>
        <BusinessProfileForm
          initialValues={{ name: "Shop", type: "Retail", availableFunds: 1000, expectedMonthlyExpenses: 500, operatingDays: 26, largeExpenseThresholdPercent: 20 }}
          submitLabel="Save changes"
          onSubmit={vi.fn()}
          settingsAside={<div />}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("PHP 1,000")).toBeVisible();
    expect(screen.queryByLabelText(/^Opening balance/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit starting figures" }));
    const balance = screen.getByLabelText(/^Opening balance/);
    expect(balance).toHaveValue(1000);
    expect(screen.queryByRole("button", { name: "Edit starting figures" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit business identity" })).toBeDisabled();

    fireEvent.change(balance, { target: { value: "2500" } });
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    fireEvent.keyDown(balance, { key: "Escape" });
    expect(screen.queryByLabelText(/^Opening balance/)).toBeNull();
    expect(screen.getByText("PHP 1,000")).toBeVisible();
  });
});
