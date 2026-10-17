// @vitest-environment jsdom
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CategoryFilter, SEARCHABLE_CATEGORY_THRESHOLD } from "./CategoryFilter";

function categories(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: index === 41 ? "Packaging" : `Category ${String(index + 1).padStart(2, "0")}`,
  }));
}

function Harness({ count, initial = "", disabled = false }: { count: number; initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="rec-cat">Category</label>
      <CategoryFilter id="rec-cat" value={value} onChange={setValue} categories={categories(count)} disabled={disabled} />
      <span data-testid="value">{value}</span>
    </>
  );
}

describe("records category filter", () => {
  it("keeps the native select for a short category list", async () => {
    const user = userEvent.setup();
    render(<Harness count={SEARCHABLE_CATEGORY_THRESHOLD} />);
    const select = screen.getByLabelText("Category");
    expect(select.tagName).toBe("SELECT");
    expect(within(select).getAllByRole("option")).toHaveLength(SEARCHABLE_CATEGORY_THRESHOLD + 1);
    expect(within(select).getAllByRole("option")[0]).toHaveTextContent("All");
    await user.selectOptions(select, "3");
    expect(screen.getByTestId("value")).toHaveTextContent("3");
  });

  it("becomes a labelled, collapsed combobox for a long list", () => {
    render(<Harness count={60} initial="42" />);
    const combobox = screen.getByRole("combobox", { name: "Category" });
    expect(combobox.tagName).toBe("INPUT");
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(combobox).toHaveAttribute("aria-autocomplete", "list");
    expect(combobox).toHaveValue("Packaging");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("filters by typed text and selects the highlighted match with Enter", async () => {
    const user = userEvent.setup();
    render(<Harness count={60} />);
    const combobox = screen.getByRole("combobox", { name: "Category" });
    await user.type(combobox, "pack");

    const listbox = screen.getByRole("listbox", { name: "Categories" });
    expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual(["Packaging"]);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    expect(combobox).toHaveAttribute("aria-activedescendant", within(listbox).getByRole("option").id);
    expect(screen.getByRole("status")).toHaveTextContent("1 of 60 categories match");

    await user.keyboard("{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("42");
    expect(combobox).toHaveValue("Packaging");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("moves through options with the arrow keys and wraps", async () => {
    const user = userEvent.setup();
    render(<Harness count={60} />);
    const combobox = screen.getByRole("combobox", { name: "Category" });
    combobox.focus();
    await user.keyboard("{ArrowDown}");
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(61);
    expect(combobox).toHaveAttribute("aria-activedescendant", options[0]!.id);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(combobox).toHaveAttribute("aria-activedescendant", options[2]!.id);
    await user.keyboard("{Home}{ArrowUp}");
    expect(combobox).toHaveAttribute("aria-activedescendant", options[60]!.id);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("60");
  });

  it("opens on the current choice and can go back to every category", async () => {
    const user = userEvent.setup();
    render(<Harness count={60} initial="42" />);
    const combobox = screen.getByRole("combobox", { name: "Category" });
    await user.click(combobox);
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options[42]).toHaveAttribute("aria-selected", "true");
    expect(combobox).toHaveAttribute("aria-activedescendant", options[42]!.id);

    await user.click(options[0]!);
    expect(screen.getByTestId("value")).toBeEmptyDOMElement();
    expect(combobox).toHaveValue("");
    expect(combobox).toHaveAttribute("placeholder", "All categories");
  });

  it("closes on Escape without changing the filter", async () => {
    const user = userEvent.setup();
    render(<Harness count={60} initial="5" />);
    const combobox = screen.getByRole("combobox", { name: "Category" });
    await user.type(combobox, "pack");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(combobox).toHaveValue("Category 05");
    expect(screen.getByTestId("value")).toHaveTextContent("5");
  });

  it("says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness count={60} />);
    await user.type(screen.getByRole("combobox", { name: "Category" }), "zzz");
    expect(screen.getByText("No categories match “zzz”.")).toBeVisible();
    expect(within(screen.getByRole("listbox")).queryAllByRole("option")).toHaveLength(0);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("value")).toBeEmptyDOMElement();
  });

  it("is disabled with the sales filter like the select it replaces", () => {
    render(<Harness count={60} disabled />);
    expect(screen.getByRole("combobox", { name: "Category" })).toBeDisabled();
  });
});
