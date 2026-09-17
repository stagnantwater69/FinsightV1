// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Notifications } from "./Notifications";
import type { BusinessProfile, Notification } from "../lib/types";

/*
 * Reliability review 2026-09-17, item #20.
 *
 * A failed load rendered the error banner AND "Nothing needs your attention"
 * at the same time. The second is a claim about the server's list, and a
 * request that never answered gives no grounds for it.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

let notificationState: {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
};
const refresh = vi.fn();

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    ...notificationState,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh,
  }),
}));

const page = () => render(<MemoryRouter><Notifications /></MemoryRouter>);

beforeEach(() => {
  refresh.mockReset();
  notificationState = { notifications: [], unreadCount: 0, loading: false, error: null };
});

describe("the notifications archive after a failed load", () => {
  it("does not claim the archive is clear when the load failed", () => {
    notificationState.error = "Couldn't load notifications.";
    page();

    expect(screen.getByText("Couldn't load notifications.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing unread")).not.toBeInTheDocument();
  });

  it("offers a retry that asks the server again", async () => {
    const user = userEvent.setup();
    notificationState.error = "Couldn't load notifications.";
    page();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("still says the archive is clear when an empty list really did load", () => {
    page();

    expect(screen.getByText("Nothing needs your attention")).toBeInTheDocument();
  });
});
