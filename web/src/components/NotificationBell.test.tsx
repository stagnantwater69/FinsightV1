// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { NotificationBell } from "./NotificationBell";
import type { Notification } from "../lib/types";

const refresh = vi.fn();
const markRead = vi.fn();
const markAllRead = vi.fn();
let notificationState: {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
};
vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({ ...notificationState, refresh, markRead, markAllRead }),
}));
vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1, name: "Sari-sari" } }),
}));

const notification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 7,
  businessProfileId: 1,
  expenseRecordId: 42,
  type: "Possible duplicate",
  message: "This expense may repeat a receipt recorded earlier today.",
  dateCreated: new Date().toISOString(),
  readStatus: false,
  ...overrides,
});
const bell = () => render(
  <MemoryRouter>
    <NotificationBell />
    <button type="button">Outside the notification panel</button>
  </MemoryRouter>,
);
const openBell = async (user: ReturnType<typeof userEvent.setup>) => {
  const trigger = screen.getByRole("button", { name: /^Notifications —/ });
  await user.click(trigger);
  return { trigger, panel: screen.getByRole("dialog", { name: "Notifications" }) };
};

beforeEach(() => {
  vi.clearAllMocks();
  notificationState = { notifications: [], unreadCount: 0, loading: false, error: null };
});

describe("notification preview", () => {
  it("announces its expanded state and restores trigger focus on Escape", async () => {
    const user = userEvent.setup();
    bell();
    const { trigger, panel } = await openBell(user);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("dismisses on an outside click without stealing focus", async () => {
    const user = userEvent.setup();
    bell();
    await openBell(user);
    const outside = screen.getByRole("button", { name: "Outside the notification panel" });
    await user.click(outside);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("lets Tab leave the nonmodal preview and then closes it", async () => {
    const user = userEvent.setup();
    bell();
    const { panel } = await openBell(user);
    const archive = within(panel).getByRole("link", { name: /View all notifications/ });
    archive.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Outside the notification panel" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a load error and retry instead of a false all-clear", async () => {
    const user = userEvent.setup();
    notificationState.error = "Couldn't load notifications.";
    bell();
    const { panel } = await openBell(user);
    expect(within(panel).getByText(notificationState.error)).toBeVisible();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("only shows the all-clear after the empty list has loaded", async () => {
    const user = userEvent.setup();
    bell();
    await openBell(user);
    expect(screen.getByText("You're all caught up")).toBeVisible();
  });

  it("shows loading instead of an all-clear before the response arrives", async () => {
    const user = userEvent.setup();
    notificationState.loading = true;
    bell();
    await openBell(user);
    expect(screen.getByText(/Loading notifications/)).toBeInTheDocument();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });

  it("opens duplicate comparison, marks that notification read and closes the panel", async () => {
    const user = userEvent.setup();
    notificationState.notifications = [notification()];
    notificationState.unreadCount = 1;
    bell();
    const { panel } = await openBell(user);
    const review = within(panel).getByRole("link", { name: /Review duplicate/ });
    expect(review).toHaveAttribute("href", "/records?reviewDuplicateId=42");
    await user.click(review);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(7);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps full messages readable and offers no record link for batch summaries", async () => {
    const user = userEvent.setup();
    const message = "Import completed. " + "Review the imported expense descriptions and categories before your next monthly review. ".repeat(8);
    notificationState.notifications = [notification({ expenseRecordId: null, type: "Import complete", message })];
    notificationState.unreadCount = 1;
    bell();
    const { panel } = await openBell(user);
    expect(within(panel).getByText(message.trim())).toBeVisible();
    expect(within(panel).queryByRole("link", { name: /Review record|Review duplicate/ })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /^Mark read/ }));
    expect(markRead).toHaveBeenCalledExactlyOnceWith(7);
    expect(panel).toBeVisible();
  });

  it("keeps cached notifications visible when refreshing fails", async () => {
    const user = userEvent.setup();
    notificationState.notifications = [notification()];
    notificationState.error = "Couldn't load notifications.";
    bell();
    const { panel } = await openBell(user);
    expect(within(panel).getByText(notification().message)).toBeVisible();
    expect(within(panel).getByText(notificationState.error)).toBeVisible();
  });
});
