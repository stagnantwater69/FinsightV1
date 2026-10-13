// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProductShowcase } from "./ProductShowcase";

describe("ProductShowcase tabs", () => {
  it("keeps one tab in the Tab order and supports arrow, Home, and End activation", async () => {
    const user = userEvent.setup();
    render(<ProductShowcase />);

    const receipt = screen.getByRole("tab", { name: "Instant Receipt OCR" });
    const assistant = screen.getByRole("tab", { name: "Natural Language AI" });
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
    expect(screen.getByRole("heading", { name: "Natural Language AI Assistant" })).toBeVisible();

    await user.keyboard("{Home}");
    expect(receipt).toHaveFocus();
    expect(receipt).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(assistant).toHaveFocus();
  });
});
