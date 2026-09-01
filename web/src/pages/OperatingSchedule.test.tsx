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

let getHandlers: Record<string, () => unknown>;
let putCalls: { url: string; body: unknown }[];
let postCalls: { url: string; body: unknown }[];
let deleteCalls: string[];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      const key = url.startsWith("/business-profiles/1/operating-schedule")
        ? "schedule"
        : url.startsWith("/business-profiles/1/operating-overrides")
          ? "overrides"
          : null;
      if (key && getHandlers[key]) return { data: getHandlers[key]!() };
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
  putCalls = [];
  postCalls = [];
  deleteCalls = [];
  getHandlers = {
    schedule: (): OperatingScheduleEntry[] => [],
    overrides: (): OperatingDayOverride[] => [],
  };
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

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-01" } });
    await userEvent.type(screen.getByLabelText(/Reason/), "Holiday");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postCalls).toHaveLength(1));
    expect(postCalls[0]!.url).toBe("/business-profiles/1/operating-overrides");
    expect(postCalls[0]!.body).toEqual({ date: "2026-09-01", type: "CLOSED", reason: "Holiday" });
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
