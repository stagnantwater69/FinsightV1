// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PageTip } from "./PageTip";
import { readDismissedTips } from "../lib/pageTips";

let createdAt = new Date().toISOString();

vi.mock("../context/AuthContext", () => ({
  useAuthOptional: () => ({ profile: { id: 7, createdAt } }),
}));

function mount() {
  return render(
    <PageTip id="recovery-target" title="What the recovery target is">
      Explanation.
    </PageTip>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  createdAt = new Date().toISOString();
});

describe("PageTip", () => {
  it("shows to a new account and stays gone once dismissed", () => {
    const first = mount();
    expect(screen.getByRole("heading", { name: "What the recovery target is" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("heading", { name: "What the recovery target is" })).not.toBeInTheDocument();
    expect(readDismissedTips(7)).toEqual(["recovery-target"]);

    first.unmount();
    mount();
    expect(screen.queryByRole("heading", { name: "What the recovery target is" })).not.toBeInTheDocument();
  });

  it("stays out of the way of an established account", () => {
    createdAt = "2025-01-01T00:00:00.000Z";
    mount();
    expect(screen.queryByRole("heading", { name: "What the recovery target is" })).not.toBeInTheDocument();
  });
});
