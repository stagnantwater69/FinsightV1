// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

/**
 * The collapsed rail used to carry TWO controls stacked on top of each other:
 * a full-width "Expand sidebar" bar, and the logo underneath it linking to
 * /dashboard. At 72px the bar was the widest thing in the rail, read as an
 * unlabelled stripe over the brand mark, and was not the thing owners clicked
 * — they clicked the logo, which navigated instead of expanding.
 *
 * So the badge is now the control. What has to hold:
 *
 *   - it is a BUTTON with the accessible name "Open sidebar", not a link
 *     announced as navigation, and it reports aria-expanded={false};
 *   - the old separate row is gone;
 *   - both cross-fade layers are in the DOM at once, because the whole reason
 *     the swap is done on opacity is that the box must not resize under the
 *     pointer mid-hover;
 *   - expanded, the logo is the /dashboard link it always was.
 */

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { firstName: "Ana", lastName: "Cruz", email: "ana@example.com" } }),
}));

// `selected: null` keeps the nav, the search field and the bell out of the
// render — none of them are what this file is about.
vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: null }),
}));
vi.mock("../context/TourContext", () => ({ useTourOptional: () => null }));
vi.mock("./BusinessSwitcher", () => ({ BusinessSwitcher: () => null }));
vi.mock("./ThemeSwitcher", () => ({ ThemeSwitcher: () => null }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null, initials: () => "AC" }));

/** The sidebar only. The topbar carries its own mobile FinSight mark, which
 *  is a different element with the same name and not what is under test. */
function rail() {
  return within(document.querySelector("aside")!);
}

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell>
        <p>Page</p>
      </AppShell>
    </MemoryRouter>,
  );
}

function collapse() {
  localStorage.setItem("finsight.sidebarCollapsed", "true");
}

beforeEach(() => {
  localStorage.clear();
});

describe("the collapsed sidebar logo", () => {
  it("is the expand control, announced as a control rather than as navigation", () => {
    collapse();
    renderShell();

    const toggle = screen.getByRole("button", { name: "Open sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // If this were still a link, a screen-reader user would be told they were
    // about to go somewhere when the rail was only going to open.
    expect(rail().queryByRole("link", { name: "FinSight home" })).not.toBeInTheDocument();
  });

  it("no longer renders the separate full-width expand row", () => {
    collapse();
    renderShell();
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
    // And exactly one control expands the rail, not two.
    expect(screen.getAllByRole("button", { name: "Open sidebar" })).toHaveLength(1);
  });

  it("stacks the badge and the icon so the cross-fade cannot shift the layout", () => {
    collapse();
    renderShell();

    const toggle = screen.getByRole("button", { name: "Open sidebar" });
    // Both layers present at once — the hover state changes opacity only.
    expect(toggle.querySelector("img")).not.toBeNull();
    expect(toggle.querySelector("svg")).not.toBeNull();
  });

  it("expands the rail when pressed, handing the collapse control back", async () => {
    collapse();
    renderShell();

    await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
  });

  it("leaves the expanded rail exactly as it was — logo links, button collapses", () => {
    renderShell();

    const home = rail().getByRole("link", { name: "FinSight home" });
    expect(home).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
  });
});
