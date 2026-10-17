// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { OperatingSchedule } from "./OperatingSchedule";
import type { BusinessProfile, OperatingDayOverride, OperatingScheduleEntry } from "../lib/types";

/**
 * Weekly schedule + date overrides — plan §7.2-§7.4/§10.2/§11 Phase 2.
 *
 * Covers the three invariants the plan calls out explicitly: an unconfigured
 * schedule pre-checks all-open rather than submitting a default on its own
 * (§11), saving PUTs exactly seven entries, and an override can be added and
 * removed without ever touching the weekly schedule endpoint.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

let getHandlers: Record<string, (params: Record<string, unknown>) => unknown>;
let getCalls: { url: string; params: Record<string, unknown> }[];
let putCalls: { url: string; body: unknown }[];
let postCalls: { url: string; body: unknown }[];
let deleteCalls: string[];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      getCalls.push({ url, params: config?.params ?? {} });
      const key = url.startsWith("/business-profiles/1/operating-schedule")
        ? "schedule"
        : url.startsWith("/business-profiles/1/operating-overrides")
          ? "overrides"
          : null;
      if (key && getHandlers[key]) return { data: await getHandlers[key]!(config?.params ?? {}) };
      throw new Error(`unmocked GET ${url}`);
    },
    put: async (url: string, body: unknown) => {
      putCalls.push({ url, body });
      return { data: null };
    },
    post: async (url: string, body: unknown) => {
      postCalls.push({ url, body });
      const override: OperatingDayOverride = {
        id: 99,
        businessProfileId: 1,
        date: (body as { date: string }).date,
        type: (body as { type: "OPEN" | "CLOSED" }).type,
        reason: (body as { reason?: string }).reason ?? null,
      };
      return { data: override };
    },
    delete: async (url: string) => {
      deleteCalls.push(url);
      return { data: null };
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ profiles: [profile] }),
}));

vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/business-profiles/1/operating-schedule"]}>
      <Routes>
        <Route path="/business-profiles/:id/operating-schedule" element={<OperatingSchedule />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getCalls = [];
  putCalls = [];
  postCalls = [];
  deleteCalls = [];
  getHandlers = {
    schedule: (): OperatingScheduleEntry[] => [],
    overrides: (): OperatingDayOverride[] => [],
  };
});

describe("OperatingSchedule paged history preserves weekly edits", () => {
  it("retries the failed continuation cursor and preserves all loaded overrides and dirty weekly edits", async () => {
    let attempts = 0;
    const first = { id: 1, businessProfileId: 1, date: "2026-10-01", type: "CLOSED", reason: "First closure" };
    const second = { ...first, id: 2, date: "2026-10-02", reason: "Second closure" };
    const third = { ...first, id: 3, date: "2026-10-03", reason: "Third closure" };
    getHandlers.overrides = (params) => {
      if (!params.cursor) return { items: [first], nextCursor: "cursor-a" };
      if (params.cursor === "cursor-a") return { items: [second], nextCursor: "cursor-b" };
      if (++attempts === 1) throw new Error("Older dates unavailable");
      return { items: [third], nextCursor: null };
    };
    renderPage(); await screen.findByText("First closure");
    const sunday = screen.getByRole("button", { name: /Sun/ }); await userEvent.click(sunday);
    await userEvent.click(screen.getByRole("button", { name: "More dates" }));
    await screen.findByText("Second closure");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2025-01-31" } });
    await userEvent.click(screen.getByRole("button", { name: "More dates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Older dates unavailable");
    const failed = getCalls.at(-1)!.params;
    await userEvent.click(screen.getByRole("button", { name: "Retry dates" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(getCalls.at(-1)!.params).toEqual(failed);
    expect(screen.getByText("First closure")).toBeInTheDocument();
    expect(screen.getByText("Second closure")).toBeInTheDocument();
    expect(screen.getByText("Third closure")).toBeInTheDocument();
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    expect(putCalls).toHaveLength(0);
    expect(getCalls.filter((item) => item.url.endsWith("/operating-schedule"))).toHaveLength(1);
  });

  it.each([false, true])("rejects a repeated or cycling override cursor and preserves loaded dates (cycling: %s)", async (cycling) => {
    const first = { id: 1, businessProfileId: 1, date: "2026-10-01", type: "CLOSED", reason: "First closure" };
    getHandlers.overrides = (params) => {
      if (!params.cursor) return { items: [first], nextCursor: "cursor-a" };
      if (cycling && params.cursor === "cursor-a") return { items: [{ ...first, id: 2, date: "2026-10-02", reason: "Second closure" }], nextCursor: "cursor-b" };
      return { items: [{ ...first, id: 3, date: "2026-10-03", reason: "Invalid continuation" }], nextCursor: "cursor-a" };
    };
    renderPage(); await screen.findByText("First closure");
    if (cycling) {
      await userEvent.click(screen.getByRole("button", { name: "More dates" }));
      await screen.findByText("Second closure");
    }
    await userEvent.click(screen.getByRole("button", { name: "More dates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/\S/);
    expect(screen.getByText("First closure")).toBeInTheDocument();
    if (cycling) expect(screen.getByText("Second closure")).toBeInTheDocument();
    expect(screen.queryByText("Invalid continuation")).not.toBeInTheDocument();
    expect(getCalls.filter((item) => item.url.endsWith("/operating-overrides"))).toHaveLength(cycling ? 3 : 2);
  });
  it("requests bounded dates, appends older pages without duplicates, and retains unsaved weekdays", async () => {
    const first: OperatingDayOverride = { id: 1, businessProfileId: 1, date: "2026-10-01", type: "CLOSED", reason: "First closure" };
    const next: OperatingDayOverride = { id: 2, businessProfileId: 1, date: "2026-10-02", type: "OPEN", reason: "Second opening" };
    getHandlers.overrides = (params) => params.cursor ? { items: [first, next], nextCursor: null } : { items: [first], nextCursor: "after-first" };
    renderPage();
    const sunday = await screen.findByRole("button", { name: /Sun/ });
    await userEvent.click(sunday);
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "More dates" }));
    expect(await screen.findByText("Second opening")).toBeInTheDocument();
    expect(screen.getAllByText("First closure")).toHaveLength(1);
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    expect(putCalls).toHaveLength(0);
    const requests = getCalls.filter((item) => item.url.endsWith("/operating-overrides"));
    expect(requests[0]!.params).toMatchObject({ pageSize: 50, from: expect.stringMatching(/^\d{4}-\d{2}-01$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(requests[1]!.params).toEqual({ ...requests[0]!.params, cursor: "after-first" });
    expect(getCalls.filter((item) => item.url.endsWith("/operating-schedule"))).toHaveLength(1);
  });

  it("changes historical date bounds without reloading or saving dirty weekly entries", async () => {
    getHandlers.overrides = (params) => ({ items: params.from === "2025-01-01" ? [{ id: 4, businessProfileId: 1, date: "2025-01-15", type: "CLOSED", reason: "Earlier holiday" }] : [], nextCursor: null });
    renderPage();
    const sunday = await screen.findByRole("button", { name: /Sun/ });
    await userEvent.click(sunday);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2025-01-31" } });
    await userEvent.click(screen.getByRole("button", { name: "Show dates" }));
    expect(await screen.findByText("Earlier holiday")).toBeInTheDocument();
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    expect(putCalls).toHaveLength(0);
    expect(getCalls.filter((item) => item.url.endsWith("/operating-schedule"))).toHaveLength(1);
    expect(getCalls.at(-1)!.params).toEqual({ from: "2025-01-01", to: "2025-01-31", pageSize: 50 });
  });

  it("retains visible overrides and weekly edits after range failure and supports explicit retry", async () => {
    getHandlers.overrides = () => [{ id: 1, businessProfileId: 1, date: "2026-10-01", type: "CLOSED", reason: "Saved closure" }];
    renderPage(); await screen.findByText("Saved closure");
    const sunday = screen.getByRole("button", { name: /Sun/ }); await userEvent.click(sunday);
    getHandlers.overrides = () => { throw new Error("Dates unavailable"); };
    await userEvent.click(screen.getByRole("button", { name: "Show dates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dates unavailable");
    expect(screen.getByText("Saved closure")).toBeInTheDocument();
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    getHandlers.overrides = () => ({ items: [], nextCursor: null });
    await userEvent.click(screen.getByRole("button", { name: "Retry dates" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("No date overrides in this range")).toBeInTheDocument();
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    expect(putCalls).toHaveLength(0);
  });

  it("does not request a reversed date range", async () => {
    renderPage(); await screen.findByRole("button", { name: /Sun/ });
    const before = getCalls.length;
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-02-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2025-01-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show dates" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a start date on or before the end date.");
    expect(getCalls).toHaveLength(before);
  });
});

describe("OperatingSchedule — weekly schedule", () => {
  it("pre-checks all seven days open when no schedule has ever been configured", async () => {
    renderPage();
    const monday = await screen.findByRole("button", { name: /Mon/ });
    expect(monday).toHaveAttribute("aria-pressed", "true");
    const sunday = screen.getByRole("button", { name: /Sun/ });
    expect(sunday).toHaveAttribute("aria-pressed", "true");
  });

  it("does not submit anything on load — only an explicit Save writes the schedule", async () => {
    renderPage();
    await screen.findByRole("button", { name: /Mon/ });
    expect(putCalls).toHaveLength(0);
  });

  it("PUTs all seven entries, reflecting a toggled day, when the owner saves", async () => {
    renderPage();
    const sunday = await screen.findByRole("button", { name: /Sun/ });
    await userEvent.click(sunday);
    expect(sunday).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Save weekly schedule" }));

    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]!.url).toBe("/business-profiles/1/operating-schedule");
    const body = putCalls[0]!.body as { entries: OperatingScheduleEntry[] };
    expect(body.entries).toHaveLength(7);
    expect(body.entries.find((e) => e.weekday === 7)).toEqual({ weekday: 7, isOpen: false });
  });

  it("loads the owner's previously saved schedule instead of the all-open default", async () => {
    getHandlers.schedule = () => [
      { weekday: 1, isOpen: true },
      { weekday: 2, isOpen: true },
      { weekday: 3, isOpen: true },
      { weekday: 4, isOpen: true },
      { weekday: 5, isOpen: true },
      { weekday: 6, isOpen: false },
      { weekday: 7, isOpen: false },
    ];
    renderPage();
    const saturday = await screen.findByRole("button", { name: /Sat/ });
    expect(saturday).toHaveAttribute("aria-pressed", "false");
  });
});

describe("OperatingSchedule — date overrides", () => {
  it("lists existing overrides sorted by date", async () => {
    getHandlers.overrides = (): OperatingDayOverride[] => [
      { id: 2, businessProfileId: 1, date: "2026-08-25", type: "CLOSED", reason: "Fiesta" },
      { id: 1, businessProfileId: 1, date: "2026-08-01", type: "OPEN", reason: null },
    ];
    renderPage();

    const dates = await screen.findAllByText(/2026-08-(01|25)/);
    expect(dates[0]).toHaveTextContent("2026-08-01");
    expect(dates[1]).toHaveTextContent("2026-08-25");
    expect(screen.getByText("Fiesta")).toBeInTheDocument();
  });

  it("adds a new override without touching the weekly schedule endpoint", async () => {
    renderPage();
    await screen.findByRole("button", { name: /Mon/ });

    const visibleDate = (screen.getByLabelText("From") as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: visibleDate } });
    await userEvent.type(screen.getByLabelText(/Reason/), "Holiday");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postCalls).toHaveLength(1));
    expect(postCalls[0]!.url).toBe("/business-profiles/1/operating-overrides");
    expect(postCalls[0]!.body).toEqual({ date: visibleDate, type: "CLOSED", reason: "Holiday" });
    expect(putCalls).toHaveLength(0);
    expect(await screen.findByText("Holiday")).toBeInTheDocument();
  });

  it("removes an override after the confirm dialog is accepted", async () => {
    getHandlers.overrides = (): OperatingDayOverride[] => [
      { id: 5, businessProfileId: 1, date: "2026-08-25", type: "CLOSED", reason: "Fiesta" },
    ];
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /Remove override for 2026-08-25/ }));

    await waitFor(() => expect(deleteCalls).toEqual(["/business-profiles/1/operating-overrides/5"]));
    expect(screen.queryByText("Fiesta")).not.toBeInTheDocument();
  });
});
