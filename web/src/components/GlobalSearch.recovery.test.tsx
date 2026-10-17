// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "./GlobalSearch";

const mocks = vi.hoisted(() => ({ get: vi.fn(), openChat: vi.fn(), selectProfile: vi.fn(), selected: { id: 1 } }));
vi.mock("../lib/api", () => ({ api: { get: mocks.get } }));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected, profiles: [{ id: 1, name: "Rice store", type: "Retail" }], selectProfile: mocks.selectProfile }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({ categories: [{ id: 1, name: "Rice inventory" }] }) }));
vi.mock("../context/AiChatContext", () => ({ useAiChat: () => ({ openChat: mocks.openChat }) }));
function record(id: number, description: string) { return { id, type: "expense", description, date: "2026-10-13", amount: 12.34 }; }
function page() { return render(<MemoryRouter><GlobalSearch /></MemoryRouter>); }
function query(value: string) { fireEvent.change(screen.getByRole("combobox", { name: "Search FinSight" }), { target: { value } }); }
beforeEach(() => {
  mocks.get.mockReset(); mocks.openChat.mockReset(); mocks.selectProfile.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  mocks.get.mockResolvedValue({ data: { items: [], nextCursor: null } });
});

describe("global search query ownership and retry", () => {
  it("immediately hides an old query's remote records and keeps matching local rows after failure", async () => {
    mocks.get.mockResolvedValueOnce({ data: { items: [record(11, "Previous coffee result")], nextCursor: null } });
    page(); query("coffee");
    await screen.findByRole("option", { name: /Previous coffee result/ });
    mocks.get.mockRejectedValueOnce(new Error("Search unavailable"));
    query("Rice");
    expect(screen.queryByRole("option", { name: /Previous coffee result/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Rice inventory/ })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Search unavailable");
    expect(screen.getByRole("option", { name: /Rice store/ })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
    mocks.get.mockResolvedValueOnce({ data: { items: [record(12, "Rice supplier")], nextCursor: null } });
    fireEvent.click(screen.getByRole("button", { name: "Retry record search" }));
    await screen.findByRole("option", { name: /Rice supplier/ });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.get.mock.calls.map(([, config]) => config.params.keyword)).toEqual(["coffee", "Rice", "Rice"]);
  });

  it("aborts a held old query and discards its response even when the transport resolves it", async () => {
    let release!: (value: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    page(); query("old");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.get.mock.calls[0]![1].signal as AbortSignal;
    query("Rice");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { release({ data: { items: [record(11, "Late old result")], nextCursor: null } }); });
    expect(screen.queryByRole("option", { name: /Late old result/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Rice inventory/ })).toBeInTheDocument();
  });

  it("announces failed empty searches without claiming there are no matching records", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Offline"));
    page(); query("zzzz");
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByText("Record search could not finish.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  it("keeps local assistant selection usable by keyboard when record search fails", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Offline"));
    page(); query("ask");
    await screen.findByRole("alert");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(mocks.openChat).toHaveBeenCalledWith("Dashboard");
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });
});
