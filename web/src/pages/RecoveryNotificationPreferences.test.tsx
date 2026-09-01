// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RecoveryNotificationPreferences } from "./RecoveryNotificationPreferences";
import type { BusinessProfile, RecoveryNotificationPreference } from "../lib/types";

/**
 * Recovery Target notification preferences — plan §7.5/§10.8/§11 Phase 6.
 *
 * Covers: the page renders the backend's own effective defaults without
 * requiring any setup step, a save round-trips through PUT, and the
 * both-or-neither quiet-hours rule is enforced client-side before any
 * network call happens.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

const DEFAULT_PREF: RecoveryNotificationPreference = {
  targetIncreaseAlertEnabled: true,
  targetIncreaseThresholdPercent: 15,
  behindThreeDaysAlertEnabled: true,
  openDayNoSalesAlertEnabled: true,
  projectionShortfallAlertEnabled: true,
  coverageReachedAlertEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  minHoursBetweenNotifications: 24,
};

let getResponse: RecoveryNotificationPreference;
let putCalls: { url: string; body: unknown }[];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/business-profiles/1/recovery-notification-preferences") {
        return { data: getResponse };
      }
      throw new Error(`unmocked GET ${url}`);
    },
    put: async (url: string, body: unknown) => {
      putCalls.push({ url, body });
      return { data: { ...getResponse, ...(body as object) } };
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ profiles: [profile] }),
}));

const toastCalls: string[] = [];
vi.mock("../components/Toast", () => ({ useToast: () => (msg: string) => toastCalls.push(msg) }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/business-profiles/1/recovery-notifications"]}>
      <Routes>
        <Route path="/business-profiles/:id/recovery-notifications" element={<RecoveryNotificationPreferences />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  putCalls = [];
  toastCalls.length = 0;
  getResponse = { ...DEFAULT_PREF };
});

describe("RecoveryNotificationPreferences", () => {
  it("renders the backend's own defaults without any setup step", async () => {
    renderPage();
    expect(await screen.findByLabelText(/Target increased beyond a threshold/)).toBeChecked();
    expect(screen.getByLabelText(/Behind pace for three days/)).toBeChecked();
    expect(screen.getByLabelText(/Monthly target reached/)).toBeChecked();
    expect(screen.getByLabelText("Threshold")).toHaveValue(15);
    expect(screen.getByLabelText("Minimum hours between notifications")).toHaveValue(24);
  });

  it("marks the two inert triggers as coming soon, not currently active", async () => {
    renderPage();
    expect(await screen.findByLabelText(/Open day ending with no sales \(coming soon\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Projection crosses to shortfall \(coming soon\)/)).toBeInTheDocument();
    expect(screen.getByText(/Not active yet — FinSight can't yet reliably tell/)).toBeInTheDocument();
  });

  it("saves via PUT and reflects the response", async () => {
    renderPage();
    await screen.findByLabelText(/Target increased beyond a threshold/);

    await userEvent.click(screen.getByLabelText(/Behind pace for three days/));
    await userEvent.click(screen.getByRole("button", { name: /Save preferences/ }));

    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]!.url).toBe("/business-profiles/1/recovery-notification-preferences");
    const body = putCalls[0]!.body as RecoveryNotificationPreference;
    expect(body.behindThreeDaysAlertEnabled).toBe(false);
    expect(toastCalls).toContain("Recovery Target notification preferences saved.");
  });

  it("rejects saving quiet hours with only a start set, without calling the API", async () => {
    renderPage();
    await screen.findByLabelText(/Target increased beyond a threshold/);

    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: "22:00" } });
    await userEvent.click(screen.getByRole("button", { name: /Save preferences/ }));

    expect(await screen.findByText(/Set both a quiet-hours start and end/)).toBeInTheDocument();
    expect(putCalls).toHaveLength(0);
  });

  it("accepts quiet hours when both start and end are set", async () => {
    renderPage();
    await screen.findByLabelText(/Target increased beyond a threshold/);

    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText(/^End/), { target: { value: "06:00" } });
    await userEvent.click(screen.getByRole("button", { name: /Save preferences/ }));

    await waitFor(() => expect(putCalls).toHaveLength(1));
    const body = putCalls[0]!.body as RecoveryNotificationPreference;
    expect(body.quietHoursStart).toBe("22:00");
    expect(body.quietHoursEnd).toBe("06:00");
  });
});
