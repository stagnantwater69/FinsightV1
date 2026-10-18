// @vitest-environment jsdom
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import { NotificationProvider, useNotifications } from "./NotificationContext";
import { invalidateServerState } from "../lib/serverStateCache";
import type { Notification } from "../lib/types";

const get = vi.fn();
const patch = vi.fn();
let selected: { id: number } | null = { id: 1 };
vi.mock("../lib/api", () => ({ api: { get: (...args: unknown[]) => get(...args), patch: (...args: unknown[]) => patch(...args) } }));
vi.mock("./BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected }) }));
const row: Notification = {
  id: 7, businessProfileId: 1, expenseRecordId: null, type: "Import complete",
  message: "Three expenses were imported.", dateCreated: new Date().toISOString(), readStatus: false,
};
function Probe() {
  const { loading, notifications, error, markRead, markAllRead, unreadCount } = useNotifications();
  return <>
    <p data-testid="loading">{String(loading)}</p>
    <p data-testid="error">{error ?? "none"}</p>
    <p data-testid="unread">{unreadCount}</p>
    {notifications.map((notification) => <p key={notification.id}>{notification.message} — {notification.readStatus ? "read" : "unread"}</p>)}
    <button onClick={() => void markRead(7)}>Mark first read</button>
    <button onClick={() => void markRead(8)}>Mark second read</button>
    <button onClick={() => void markAllRead()}>Mark all read</button>
  </>;
}
beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  selected = { id: 1 };
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("notification provider mount lifecycle", () => {
  it("replaces the aborted StrictMode mount request and settles the initial load", async () => {
    get.mockImplementationOnce((_url: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Request cancelled")), { once: true });
      }),
    ).mockResolvedValue({ data: [row] });
    render(<StrictMode><NotificationProvider><Probe /></NotificationProvider></StrictMode>);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByText(new RegExp(row.message))).toBeVisible();
    expect(screen.getByTestId("error")).toHaveTextContent("none");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][1].signal.aborted).toBe(false);
    expect(get.mock.calls[1][1].params).toEqual({ businessProfileId: 1 });
  });
});


describe("notification provider refresh consistency", () => {
  it("coalesces invalidation bursts and does not publish the superseded snapshot", async () => {
    const initial = deferred<{ data: Notification[] }>();
    const following = deferred<{ data: Notification[] }>();
    get.mockReturnValueOnce(initial.promise).mockReturnValueOnce(following.promise);
    render(<NotificationProvider><Probe /></NotificationProvider>);
    act(() => {
      for (let i = 0; i < 3; i++) invalidateServerState({ businessProfileId: 1, tags: ["notifications"] });
    });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => initial.resolve({ data: [row] }));
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(new RegExp(row.message))).not.toBeInTheDocument();
    const newest = { ...row, message: "The most recent notification." };
    await act(async () => following.resolve({ data: [newest] }));
    expect(screen.getByText(/The most recent notification/)).toBeVisible();
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not fetch again for another business's invalidation", async () => {
    get.mockResolvedValue({ data: [row] });
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    act(() => invalidateServerState({ businessProfileId: 2, tags: ["notifications"] }));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("replaces an in-flight request when the selected business changes", async () => {
    const initial = deferred<{ data: Notification[] }>();
    const other = { ...row, businessProfileId: 2, message: "The second business notification." };
    get.mockReturnValueOnce(initial.promise).mockResolvedValue({ data: [other] });
    const { rerender } = render(<NotificationProvider><Probe /></NotificationProvider>);
    selected = { id: 2 };
    rerender(<NotificationProvider><Probe /></NotificationProvider>);
    await act(async () => initial.resolve({ data: [row] }));
    expect(await screen.findByText(/The second business notification/)).toBeVisible();
    expect(screen.queryByText(new RegExp(row.message))).not.toBeInTheDocument();
    expect(get.mock.calls[1][1].params).toEqual({ businessProfileId: 2 });
  });

  it("ignores a failed read action that belongs to the previous business", async () => {
    const action = deferred<void>();
    patch.mockReturnValue(action.promise);
    get.mockResolvedValueOnce({ data: [row] });
    const { rerender } = render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    act(() => screen.getByRole("button", { name: "Mark first read" }).click());
    expect(screen.getByText(/Three expenses were imported. — read/)).toBeVisible();
    const other = { ...row, businessProfileId: 2, message: "The second business notification.", readStatus: true };
    get.mockResolvedValue({ data: [other] });
    selected = { id: 2 };
    rerender(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(/The second business notification. — read/);
    await act(async () => action.reject(new Error("Late network failure")));
    expect(screen.getByText(/The second business notification. — read/)).toBeVisible();
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });
});

describe("notification mutation failures", () => {
  const otherRow = { ...row, id: 8, message: "Another import finished." };

  function cooldown(seconds: number) {
    const config = { headers: new AxiosHeaders() };
    return new AxiosError("Rate limited", "ERR_BAD_REQUEST", config as never, {}, {
      status: 429, statusText: "", config: config as never, headers: {}, data: { retryAfterSeconds: seconds },
    });
  }

  it("restores one unread notification and exposes the server's retry seconds", async () => {
    get.mockResolvedValue({ data: [row, otherRow] });
    patch.mockRejectedValueOnce(cooldown(7));
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    await act(async () => screen.getByRole("button", { name: "Mark first read" }).click());
    expect(screen.getByTestId("error")).toHaveTextContent("Try again in 7s.");
    expect(screen.getByTestId("unread")).toHaveTextContent("2");
    expect(screen.getByText(/Three expenses were imported. — unread/)).toBeVisible();
    expect(patch).toHaveBeenCalledWith("/notifications/7/read", undefined, { serverStateScope: { businessProfileId: 1 } });
  });

  it("restores the previous individual read states after mark-all fails", async () => {
    get.mockResolvedValue({ data: [row, { ...otherRow, readStatus: true }] });
    patch.mockRejectedValueOnce(new Error("Notifications could not be saved"));
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    await act(async () => screen.getByRole("button", { name: "Mark all read" }).click());
    expect(screen.getByTestId("error")).toHaveTextContent("Notifications could not be saved");
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByText(/Another import finished. — read/)).toBeVisible();
    expect(patch).toHaveBeenCalledWith("/notifications/read-all", null, {
      params: { businessProfileId: 1 }, serverStateScope: { businessProfileId: 1 },
    });
  });

  it("does not roll back or show an obsolete single-row error after a newer mark-all succeeds", async () => {
    const older = deferred<void>();
    get.mockResolvedValue({ data: [row, otherRow] });
    patch.mockReturnValueOnce(older.promise).mockResolvedValueOnce({});
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    act(() => screen.getByRole("button", { name: "Mark first read" }).click());
    await act(async () => screen.getByRole("button", { name: "Mark all read" }).click());
    await act(async () => older.reject(new Error("Old request failed")));
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("keeps a newer successful row read when an overlapping mark-all request fails", async () => {
    const all = deferred<void>();
    get.mockResolvedValue({ data: [row, otherRow] });
    patch.mockReturnValueOnce(all.promise).mockResolvedValueOnce({});
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    act(() => screen.getByRole("button", { name: "Mark all read" }).click());
    await act(async () => screen.getByRole("button", { name: "Mark first read" }).click());
    await act(async () => all.reject(new Error("Mark-all failed")));
    expect(screen.getByText(/Three expenses were imported. — read/)).toBeVisible();
    expect(screen.getByText(/Another import finished. — unread/)).toBeVisible();
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("does not publish an older different-row failure over the newest successful action", async () => {
    const older = deferred<void>();
    get.mockResolvedValue({ data: [row, otherRow] });
    patch.mockReturnValueOnce(older.promise).mockResolvedValueOnce({});
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    act(() => screen.getByRole("button", { name: "Mark first read" }).click());
    await act(async () => screen.getByRole("button", { name: "Mark second read" }).click());
    await act(async () => older.reject(new Error("First request failed late")));
    expect(screen.getByText(/Three expenses were imported. — unread/)).toBeVisible();
    expect(screen.getByText(/Another import finished. — read/)).toBeVisible();
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("ignores a previous business's mark-all failure even if notification IDs overlap", async () => {
    const all = deferred<void>();
    patch.mockReturnValueOnce(all.promise);
    get.mockResolvedValueOnce({ data: [row] });
    const view = render(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(new RegExp(row.message));
    act(() => screen.getByRole("button", { name: "Mark all read" }).click());
    get.mockResolvedValueOnce({ data: [{ ...row, businessProfileId: 2, message: "Second business alert" }] });
    selected = { id: 2 };
    view.rerender(<NotificationProvider><Probe /></NotificationProvider>);
    await screen.findByText(/Second business alert — unread/);
    await act(async () => all.reject(cooldown(30)));
    expect(screen.getByTestId("error")).toHaveTextContent("none");
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByText(/Second business alert — unread/)).toBeVisible();
  });
});

describe("unread badge total", () => {
  // The list stops at 500 rows; the server sends the real total in a header.
  const withTotal = (rows: Notification[], total: number) => ({ data: rows, headers: { "x-unread-count": String(total) } });

  it("counts unread alerts the list does not include", async () => {
    get.mockResolvedValue(withTotal([row], 520));
    render(<NotificationProvider><Probe /></NotificationProvider>);

    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("520"));
  });

  it("drops by one when a listed alert is marked read", async () => {
    get.mockResolvedValue(withTotal([row], 520));
    patch.mockResolvedValue({ data: { ...row, readStatus: true } });
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("520"));

    await act(async () => screen.getByRole("button", { name: "Mark first read" }).click());

    expect(screen.getByTestId("unread")).toHaveTextContent("519");
  });

  it("reaches zero on mark-all-read and comes back if the request fails", async () => {
    get.mockResolvedValue(withTotal([row], 520));
    const action = deferred<void>();
    patch.mockReturnValue(action.promise);
    render(<NotificationProvider><Probe /></NotificationProvider>);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("520"));

    act(() => screen.getByRole("button", { name: "Mark all read" }).click());
    expect(screen.getByTestId("unread")).toHaveTextContent("0");

    await act(async () => action.reject(new Error("Network down")));
    expect(screen.getByTestId("unread")).toHaveTextContent("520");
  });

  it("falls back to counting rows when the header is missing", async () => {
    get.mockResolvedValue({ data: [row, { ...row, id: 8 }] });
    render(<NotificationProvider><Probe /></NotificationProvider>);

    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("2"));
  });
});
