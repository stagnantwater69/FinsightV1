// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Broken(): never {
  throw new Error("expense 412 'Team lunch' failed at /srv/app/records.ts");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React and the boundary both log the caught error; keep the run quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the error message and stack off screen in a production build", () => {
    vi.stubEnv("DEV", false);
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "Something broke on this page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload the page" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Team lunch");
    expect(document.querySelector("pre")).toBeNull();
  });

  it("shows the message for whoever is debugging in development", () => {
    vi.stubEnv("DEV", true);
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(document.querySelector("pre")?.textContent).toContain("Team lunch");
  });
});
