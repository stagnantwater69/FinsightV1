// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
const markRead = vi.fn();
const markAllRead = vi.fn();

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    ...notificationState,
    markRead,
    markAllRead,
    refresh,
  }),
}));

const page = () => render(<MemoryRouter><Notifications /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  notificationState = { notifications: [], unreadCount: 0, loading: false, error: null };
});

describe("the notifications archive after a failed load", () => {
  it("uses ordinary pressed filter buttons instead of tabs without panels", async () => {
    const user = userEvent.setup();
    page();

    const filters = screen.getByRole("group", { name: "Filter notifications" });
    const all = within(filters).getByRole("button", { name: "All" });
    const unread = within(filters).getByRole("button", { name: "Unread" });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(unread).toHaveAttribute("aria-pressed", "false");

    await user.click(unread);
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(unread).toHaveAttribute("aria-pressed", "true");
  });

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


const notification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 7,
  businessProfileId: profile.id,
  expenseRecordId: 42,
  type: "Possible duplicate",
  message: "This expense may repeat a receipt recorded earlier today.",
  dateCreated: new Date().toISOString(),
  readStatus: false,
  ...overrides,
});

describe("notification archive actions", () => {
  it("sends duplicate reviews to the comparison and marks only the selected notification read", async () => {
    const user = userEvent.setup();
    notificationState.notifications = [notification()];
    notificationState.unreadCount = 1;
    page();

    const review = screen.getByRole("link", { name: /Review duplicate/ });
    expect(review).toHaveAttribute("href", "/records?reviewDuplicateId=42");
    await user.click(review);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("opens other expense flags in record context without remarking a read notification", async () => {
    const user = userEvent.setup();
    notificationState.notifications = [notification({ type: "Large expense", readStatus: true })];
    page();

    const review = screen.getByRole("link", { name: /Review record/ });
    expect(review).toHaveAttribute("href", "/records?highlightRecordId=42");
    await user.click(review);
    expect(markRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Mark read/ })).not.toBeInTheDocument();
  });

  it("filters read items and restores them when All is selected", async () => {
    const user = userEvent.setup();
    const earlier = notification({ id: 8, readStatus: true, message: "An earlier reviewed expense." });
    notificationState.notifications = [notification(), earlier];
    notificationState.unreadCount = 1;
    page();

    const filters = screen.getByRole("group", { name: "Filter notifications" });
    await user.click(within(filters).getByRole("button", { name: /^Unread/ }));
    expect(screen.queryByText(earlier.message)).not.toBeInTheDocument();
    expect(screen.getByText(notification().message)).toBeVisible();
    await user.click(within(filters).getByRole("button", { name: /^All/ }));
    expect(screen.getByText(earlier.message)).toBeVisible();
  });

  it("keeps a cached message visible during a refresh error and offers retry", () => {
    notificationState.notifications = [notification()];
    notificationState.error = "Couldn't load notifications.";
    page();

    expect(screen.getByText(notification().message)).toBeVisible();
    expect(screen.getByText(notificationState.error)).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
  });

  it("marks all notifications read only after the owner asks", async () => {
    const user = userEvent.setup();
    notificationState.notifications = [notification()];
    notificationState.unreadCount = 1;
    page();

    expect(markAllRead).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(markAllRead).toHaveBeenCalledTimes(1);
  });
});
