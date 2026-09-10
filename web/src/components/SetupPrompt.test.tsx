// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SetupPrompt } from "./SetupPrompt";

/**
 * The one invitation left standing once the gate card retreated to the write
 * pages (see NoBusinessProfile.test.tsx).
 *
 * Three things have to hold, and the last two are the ones that would do real
 * damage if they broke:
 *
 *   - it appears for an owner with no business, since it is now the only place
 *     finishing setup is offered on a read-only page;
 *   - it NEVER appears for an owner who has one. It renders in the shell, on
 *     every authenticated route, so a false positive here would put "your
 *     dashboard is empty" above a dashboard full of figures;
 *   - it NEVER appears on a failed profile load. An empty list means "no
 *     business yet" only when the load succeeded — the same rule
 *     RequireBusinessProfile and NoBusinessProfile both follow, because
 *     telling an owner with three businesses to go and set one up is the bug
 *     that rule exists to prevent.
 */

const ctx = {
  profiles: [] as { id: number }[],
  loading: false,
  error: null as string | null,
};

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ctx,
}));

function mount() {
  return render(
    <MemoryRouter>
      <SetupPrompt />
    </MemoryRouter>,
  );
}

describe("SetupPrompt", () => {
  it("invites an owner with no business to finish setup", () => {
    ctx.profiles = [];
    ctx.loading = false;
    ctx.error = null;

    mount();

    expect(screen.getByText(/your dashboard is empty until you add a business/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Finish setup" })).toHaveAttribute(
      "href",
      "/onboarding",
    );
  });

  it("renders nothing for an owner who already has a business", () => {
    ctx.profiles = [{ id: 1 }];
    ctx.loading = false;
    ctx.error = null;

    const { container } = mount();

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the profile list failed to load", () => {
    ctx.profiles = [];
    ctx.loading = false;
    ctx.error = "Network Error";

    const { container } = mount();

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the profile list is still loading", () => {
    ctx.profiles = [];
    ctx.loading = true;
    ctx.error = null;

    const { container } = mount();

    expect(container).toBeEmptyDOMElement();
  });
});
