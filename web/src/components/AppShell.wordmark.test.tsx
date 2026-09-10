// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

/**
 * The rail is the ONE surface whose background flips per theme: Classic and
 * Dark keep the deep teal gradient, but `[data-theme="light"]` sets
 * --sidebar-from to 255 255 255, so the rail goes near-white. A fixed colour
 * on the wordmark therefore cannot be right in all three — accent-300
 * (#f8bd55) lands at ~1.7:1 on the Light rail and the mark disappears.
 *
 * The `sidebar-*` tokens exist for exactly this: they resolve per theme
 * (17.9:1 / 4.9:1 Light, 11.2:1 / 6.7:1 Classic, 18.5:1 / 11.0:1 Dark). This
 * test asserts the mark reaches for those tokens and not a fixed scale step —
 * a class-name assertion, because a jsdom render resolves no CSS variables
 * and the failure this guards against is precisely a hardcoded colour.
 */

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { firstName: "Ana", lastName: "Cruz", email: "ana@example.com" } }),
}));
vi.mock("../context/BusinessProfileContext", () => ({
  // `profiles`/`loading`/`error` are here for the shell's SetupPrompt, which
  // reads the list rather than the selection — it is not what is under test,
  // but it renders inside <main> on every route and needs a real shape.
  useBusinessProfiles: () => ({ selected: null, profiles: [], loading: false, error: null }),
}));
vi.mock("../context/TourContext", () => ({ useTourOptional: () => null }));
vi.mock("./BusinessSwitcher", () => ({ BusinessSwitcher: () => null }));
vi.mock("./ThemeSwitcher", () => ({ ThemeSwitcher: () => null }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null, initials: () => "AC" }));

function railWordmark() {
  const rail = within(document.querySelector("aside")!);
  // Two text nodes ("Fin" + a coloured "Sight"), so this is queried through
  // the home link rather than by its text.
  const mark = rail.getByRole("link", { name: "FinSight home" }).querySelector("span")!;
  expect(mark.textContent).toBe("FinSight");
  return mark;
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

describe("the sidebar wordmark", () => {
  it("takes its colour from the themed rail tokens", () => {
    renderShell();
    const mark = railWordmark();

    expect(mark).toHaveClass("text-sidebar-ink");
    expect(mark.querySelector(".text-sidebar-accent")?.textContent).toBe("Sight");
  });

  it("uses no fixed colour step, which would be unreadable on the Light rail", () => {
    renderShell();
    const mark = railWordmark();

    const classes = [mark, ...mark.querySelectorAll("*")].flatMap((el) =>
      Array.from(el.classList),
    );
    expect(classes.filter((c) => /^text-(accent|brand|white|ink|slate|gray)-?/.test(c))).toEqual([]);
  });
});
