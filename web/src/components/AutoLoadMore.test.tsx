// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoLoadMore } from "./AutoLoadMore";

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: Array<{ callback: Callback; disconnected: boolean }> = [];

function installObserver() {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private record: { callback: Callback; disconnected: boolean };
      constructor(callback: Callback) {
        this.record = { callback, disconnected: false };
        observers.push(this.record);
      }
      observe() {}
      disconnect() {
        this.record.disconnected = true;
      }
    },
  );
}

const live = () => observers.filter((o) => !o.disconnected);

afterEach(() => vi.unstubAllGlobals());

describe("AutoLoadMore", () => {
  it("loads once when the end of the list scrolls into view, with no button", () => {
    installObserver();
    const onLoadMore = vi.fn();
    render(<AutoLoadMore onLoadMore={onLoadMore} loading={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => live()[0]!.callback([{ isIntersecting: false }]));
    expect(onLoadMore).not.toHaveBeenCalled();
    act(() => live()[0]!.callback([{ isIntersecting: true }]));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(live()).toHaveLength(0);
  });

  it("does not watch while a page is loading, and says so", () => {
    installObserver();
    render(<AutoLoadMore onLoadMore={vi.fn()} loading />);
    expect(live()).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("Loading more…");
  });

  it("stops after a failure and offers a retry instead", async () => {
    installObserver();
    const onLoadMore = vi.fn();
    render(<AutoLoadMore onLoadMore={onLoadMore} loading={false} paused />);
    expect(live()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("falls back to a button without IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onLoadMore = vi.fn();
    render(<AutoLoadMore onLoadMore={onLoadMore} loading={false} label="Load more records" />);
    await userEvent.click(screen.getByRole("button", { name: "Load more records" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
