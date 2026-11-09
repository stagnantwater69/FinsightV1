// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

// A collapsed rail has no room for the Insights sub-pages, so they sit in a
// flyout beside the icon. They must stay real links in the DOM: CSS shows the
// flyout on hover/focus, and keyboard users reach it by tabbing into it.

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { firstName: "Ana", lastName: "Cruz", email: "ana@example.com" } }),
}));
vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1, name: "Shop" }, profiles: [{ id: 1, name: "Shop" }], loading: false, error: null }),
}));
vi.mock("../context/TourContext", () => ({ useTourOptional: () => null }));
vi.mock("./BusinessSwitcher", () => ({ BusinessSwitcher: () => null }));
vi.mock("./ThemeSwitcher", () => ({ ThemeSwitcher: () => null }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null, initials: () => "AC" }));
vi.mock("./GlobalSearch", () => ({ GlobalSearch: () => null }));
vi.mock("./NotificationBell", () => ({ NotificationBell: () => null }));

beforeEach(() => {
  localStorage.clear();
});

function renderShell(path = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <p>Page</p>
      </AppShell>
    </MemoryRouter>,
  );
}

describe("the collapsed Insights flyout", () => {
  it("lists all three Insights pages beside the collapsed icon", () => {
    localStorage.setItem("finsight.sidebarCollapsed", "true");
    renderShell("/insights/recovery");

    const nav = within(document.querySelector("aside")!).getByRole("navigation", { name: "Main" });
    const flyout = within(nav).getByRole("list", { name: "Insights" });
    const links = within(flyout).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Expense insight", "/insights/expense-behavior"],
      ["Spending impact", "/insights/spending-impact"],
      ["Recovery target", "/insights/recovery"],
    ]);
    expect(within(flyout).getByRole("link", { name: "Recovery target" })).toHaveAttribute("aria-current", "page");
  });

  it("is not rendered when the sidebar is expanded", () => {
    renderShell();
    const nav = within(document.querySelector("aside")!).getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("list", { name: "Insights" })).toBeNull();
  });
});
