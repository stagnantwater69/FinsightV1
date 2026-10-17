// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListDisclosureControl, useListDisclosure } from "./ListDisclosure";

function Preview({ total = 9, resetKey = "business-1:month-1" }: { total?: number; resetKey?: string }) {
  const disclosure = useListDisclosure({ total, limit: 3, resetKey });
  return <>
    <ul id={disclosure.contentId} aria-label="Records">
      {Array.from({ length: disclosure.visibleCount }, (_, index) => <li key={index}>Record {index + 1}</li>)}
    </ul>
    <ListDisclosureControl disclosure={disclosure} total={total} itemLabel="records" />
  </>;
}

describe("ListDisclosure", () => {
  it("keeps the full count visible and exposes every record with the keyboard", async () => {
    const user = userEvent.setup();
    render(<Preview />);
    const list = screen.getByRole("list", { name: "Records" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Showing 3 of 9 records")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Show all 9 records" });
    expect(button).toHaveAttribute("aria-controls", list.id);
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(within(list).getAllByRole("listitem")).toHaveLength(9);
    expect(screen.getByText("All 9 records available")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAccessibleName("Show less");
    await user.keyboard(" ");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(button).toHaveFocus();
  });

  it("does not add a disclosure for empty or short lists", () => {
    const { rerender } = render(<Preview total={0} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<Preview total={3} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("resets when the business or reporting period changes, including a return to the old scope", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Preview />);
    await user.click(screen.getByRole("button", { name: "Show all 9 records" }));
    rerender(<Preview resetKey="business-2:month-1" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    rerender(<Preview />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Show all 9 records" }));
    rerender(<Preview resetKey="business-1:month-2" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("preserves the owner's expansion when data refreshes in the same scope", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Preview />);
    await user.click(screen.getByRole("button", { name: "Show all 9 records" }));
    rerender(<Preview total={11} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(11);
    expect(screen.getByText("All 11 records available")).toBeInTheDocument();
  });
});
