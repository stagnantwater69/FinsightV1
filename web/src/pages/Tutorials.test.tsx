// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Tutorials } from "./Tutorials";
import { WEB_TUTORIAL_VIDEOS } from "../lib/tutorialVideos";

vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ profile: null }) }));

const renderAt = (path = "/tutorials") => render(<MemoryRouter initialEntries={[path]}><Tutorials /></MemoryRouter>);

describe("Tutorials", () => {
  it("lists every web chapter and loads YouTube only after Play is pressed", () => {
    renderAt();
    const all = WEB_TUTORIAL_VIDEOS.flatMap((g) => g.videos);
    expect(all).toHaveLength(32);
    expect(new Set(all.map((v) => v.code)).size).toBe(32);
    expect(document.querySelector("iframe")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play video: W01 · Register and confirm email" }));
    const frame = screen.getByTitle("W01 · Register and confirm email");
    expect(frame.getAttribute("src")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/xjJDLnzW4DU\?/);
  });

  it("marks a chapter without an uploaded video as coming soon instead of offering a dead player", () => {
    renderAt();
    expect(screen.queryByRole("button", { name: /Play video: W32 / })).toBeNull();
    expect(screen.getAllByText("Video coming soon").length).toBeGreaterThan(0);
  });

  it("keeps the Android walkthroughs on their own tab", () => {
    renderAt();
    fireEvent.click(screen.getByRole("tab", { name: "Android app" }));
    expect(screen.getByRole("tab", { name: "Android app" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Setting up your business" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Play video/ })).toBeNull();
  });
});
