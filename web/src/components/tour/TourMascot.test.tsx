// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TourMascot } from "./TourMascot";
import { POSE_FALLBACK } from "./steps";

describe("TourMascot", () => {
  it("renders the pose as decorative art", () => {
    const { container } = render(<TourMascot mascot={{ pose: "/mascot/greeting.webp" }} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "/mascot/greeting.webp");
    expect(img).toHaveAttribute("alt", "");
  });

  it("falls back to the greeting pose when the asset fails, then hides", () => {
    const { container } = render(
      <TourMascot mascot={{ pose: "/mascot/does-not-exist.webp" }} />,
    );
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(container.querySelector("img")).toHaveAttribute("src", POSE_FALLBACK);

    // Even the fallback failing must not leave a broken-image glyph.
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
  });
});
