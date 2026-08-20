// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState mascot seam", () => {
  it("falls back to the icon glyph when no pose is given", () => {
    const { container } = render(<EmptyState title="Nothing here" icon="◎" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("◎")).toBeInTheDocument();
  });

  it("shows the pose instead of the glyph once one is given", () => {
    const { container } = render(
      <EmptyState title="Nothing here" icon="◎" image="/mascot/01-onboarding/emptydashboard.webp" />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/mascot/01-onboarding/emptydashboard.webp",
    );
    expect(screen.queryByText("◎")).not.toBeInTheDocument();
  });

  it("hides the pose from screen readers while it is decorative", () => {
    // The title and body already say what the state is; announcing the art too
    // would repeat the same fact. Passing imageAlt opts back in.
    const { container } = render(
      <EmptyState title="Nothing here" image="/mascot/01-onboarding/emptydashboard.webp" />,
    );
    expect(container.querySelector("img")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the compact variant text-only", () => {
    const { container } = render(
      <EmptyState compact title="Nothing here" image="/mascot/01-onboarding/emptydashboard.webp" />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
