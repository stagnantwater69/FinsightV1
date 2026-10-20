// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProductShowcase } from "./ProductShowcase";

describe("ProductShowcase tabs", () => {
  it("keeps one tab in the Tab order and supports arrow, Home, and End activation", async () => {
    const user = userEvent.setup();
    render(<ProductShowcase />);

    const receipt = screen.getByRole("tab", { name: "Receipt scanning" });
    const assistant = screen.getByRole("tab", { name: "Ask FinSight" });
    const panel = screen.getByRole("tabpanel");
    expect(receipt).toHaveAttribute("tabindex", "0");
    expect(assistant).toHaveAttribute("tabindex", "-1");
    expect(receipt).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", receipt.id);

    receipt.focus();
    await user.keyboard("{ArrowRight}");
    expect(assistant).toHaveFocus();
    expect(assistant).toHaveAttribute("aria-selected", "true");
    expect(panel).toHaveAttribute("aria-labelledby", assistant.id);
    expect(screen.getByRole("heading", { name: "Ask a question. Find it in your records." })).toBeVisible();

    await user.keyboard("{Home}");
    expect(receipt).toHaveFocus();
    expect(receipt).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(assistant).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(receipt).toHaveFocus();
    expect(receipt).toHaveAttribute("aria-selected", "true");
    expect(assistant).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("heading", { name: "Turn paper receipts into checked records" })).toBeVisible();
  });

  it("switches the displayed example when a tab is clicked", async () => {
    const user = userEvent.setup();
    render(<ProductShowcase />);

    const receipt = screen.getByRole("tab", { name: "Receipt scanning" });
    const assistant = screen.getByRole("tab", { name: "Ask FinSight" });
    await user.click(assistant);
    expect(assistant).toHaveAttribute("aria-selected", "true");
    expect(receipt).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("heading", { name: "Ask a question. Find it in your records." })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Turn paper receipts into checked records" })).not.toBeInTheDocument();

    await user.click(receipt);
    expect(receipt).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Turn paper receipts into checked records" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Ask a question. Find it in your records." })).not.toBeInTheDocument();
  });
});
