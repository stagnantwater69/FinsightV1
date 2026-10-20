// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import {
  NotificationProvider,
  useNotifications,
} from "../context/NotificationContext";
import { BusinessOwnedBoundary } from "../components/BusinessOwnedBoundary";
import { Dashboard } from "./Dashboard";
import { ExpenseInsight } from "./ExpenseInsight";
import { FlaggedRecords } from "./FlaggedRecords";
import { RecoveryInsightPage } from "./RecoveryInsightPage";
import type {
  BusinessProfile,
  DashboardSummary,
  ExpenseBehavior,
  Notification,
  RecordItem,
  RecoveryInsight,
  ReductionOpportunityResponse,
} from "../lib/types";
import type { DashboardExpenseOverview, DetailExpenseOverview } from "../lib/expenseOverview";
import { invalidateServerState } from "../lib/serverStateCache";

/*
 * Reliability review 2026-09-17, item #19.
 *
 * Switching business profile while a read is slow used to settle the PREVIOUS
 * profile's figures into the page that now carries the NEW profile's name.
 * Records.tsx already carried the AbortSignal pattern; these four did not.
 *
 * Every test here holds the first profile's request open, switches profile,
 * lets the second profile answer, and only then releases the first. The fetch
 * mock rejects an aborted request the way axios does, so a page that forgets
 * to pass the signal is the page whose stale response arrives.
 */

const profileA = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
  largeExpenseThresholdPercent: 20,
} as unknown as BusinessProfile;
const profileB = { ...profileA, id: 2, name: "Second store" } as unknown as BusinessProfile;

let selectedProfile: BusinessProfile;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Rejects on abort, as axios does, so `signal` is actually load-bearing. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("canceled"), { code: "ERR_CANCELED" }));
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail);
    promise.then(resolve, reject);
  });
}

type GetConfig = { params?: Record<string, unknown>; signal?: AbortSignal };
/** url -> (businessProfileId) -> response promise. */
let getHandlers: Record<string, (businessProfileId: unknown) => Promise<{ data: unknown }>>;
let patchCalls: Array<{ url: string; body: unknown; config: unknown }>;
let patchResponses: Promise<{ data: unknown }>[];

vi.mock("../lib/api", () => ({
  api: {
    get: (url: string, config?: GetConfig) => {
      const handler = getHandlers[url];
      if (!handler) return Promise.reject(new Error(`unmocked GET ${url}`));
      return abortable(handler(config?.params?.businessProfileId), config?.signal);
    },
    post: async () => ({ data: {} }),
    patch: (url: string, body?: unknown, config?: unknown) => {
      patchCalls.push({ url, body, config });
      return patchResponses.shift() ?? Promise.resolve({ data: {} });
    },
    delete: async () => ({ data: {} }),
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedProfile, profiles: [profileA, profileB], loading: false }),
}));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { id: 1, firstName: "Ken" }, preferences: {
    showDashboardMascotMessage: false, tourStatus: null, tourStep: null, tourAlwaysShow: false,
  } }),
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }, { id: 2, name: "Transport" }] }),
}));
vi.mock("../context/AiChatContext", () => ({ useAiChat: () => ({ openChat: vi.fn() }) }));
vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));

function summaryWith(availableFunds: number): DashboardSummary {
  return {
    periodDays: 30,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    overview: { availableFunds, totalExpenses: 1, totalSalesReference: 1 },
    expenseCategoryBreakdown: [],
    recoveryStatus: {
      expectedMonthlyExpenses: 20000, operatingDays: 26, dailyNeededTarget: 770,
      salesThisMonth: 30000, remainingTarget: 0, daysInMonth: 31,
      calendarDaysLeftInMonth: 10, remainingOperatingDays: 8,
      remainingOperatingDaysIsApproximated: false, adjustedDailyTarget: 0,
      todaysTarget: 0, todaysSales: 0, todaysGap: 0, todaysStatus: "at",
      monthCoveragePercent: 100, onTrack: true,
    },
    recordsNeedingReview: 0,
    alerts: [],
    lifetime: { recordCount: 4, latestRecordDate: "2026-01-30T00:00:00.000Z" },
  } as unknown as DashboardSummary;
}

function behaviorWith(categoryName: string): ExpenseBehavior {
  return {
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-01-31T00:00:00.000Z",
    previousPeriodStart: "2025-12-01T00:00:00.000Z",
    previousPeriodEnd: "2025-12-31T00:00:00.000Z",
    periodDays: 30,
    totals: { current: 12000, previous: 9000 },
    dailyTotals: [],
    categoryTrends: [{
      categoryId: 1, categoryName, current: 12000, previous: 9000,
      direction: "up", change: 3000, percentChange: 33.3, recordCount: 4,
    }],
    unusualExpenses: [],
    insufficientHistoryCategories: [],
    latestExpenseDate: new Date().toISOString(),
  } as unknown as ExpenseBehavior;
}

function recoveryWith(expectedMonthlyExpenses: number): RecoveryInsight {
  return {
    expectedMonthlyExpenses,
    operatingDays: 26,
    dailyNeededTarget: expectedMonthlyExpenses / 26,
    salesThisMonth: 1_000,
    remainingTarget: expectedMonthlyExpenses - 1_000,
    daysInMonth: 31,
    calendarDaysLeftInMonth: 10,
    remainingOperatingDays: 8,
    remainingOperatingDaysIsApproximated: false,
    adjustedDailyTarget: (expectedMonthlyExpenses - 1_000) / 8,
    todaysTarget: expectedMonthlyExpenses / 26,
    todaysSales: 500,
    todaysGap: 500 - expectedMonthlyExpenses / 26,
    todaysStatus: "below",
    monthCoveragePercent: 10,
    onTrack: false,
    monthStart: "2026-09-01T00:00:00.000Z",
    today: "2026-09-20T00:00:00.000Z",
    coverageDays: 20,
    dailyCoverage: [],
  } as RecoveryInsight;
}

const emptyReduction = {
  period: { days: 30, start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" },
  dataQuality: { status: "sufficient", currentRecordCount: 10, previousRecordCount: 8, message: null },
  opportunities: [],
  detectorVersion: "v1",
} as unknown as ReductionOpportunityResponse;

function dashboardOverviewWith(categoryName: string): DashboardExpenseOverview {
  const behavior = behaviorWith(categoryName);
  return {
    view: "dashboard",
    comparison: {
      status: "available",
      data: {
        period: behavior.period,
        totals: behavior.totals,
        categoryTrends: behavior.categoryTrends,
      },
    },
    topOpportunity: { status: "available", data: null },
  };
}

function detailOverviewWith(categoryName: string): DetailExpenseOverview {
  return {
    view: "detail",
    behavior: { status: "available", data: behaviorWith(categoryName) },
    opportunities: { status: "available", data: emptyReduction },
  };
}

function flaggedRecord(description: string): RecordItem {
  return {
    id: 1, type: "expense", businessProfileId: 1, duplicateOfRecordId: null,
    date: "2026-03-04T00:00:00.000Z", description, amount: 2400,
    categoryId: 1, categoryName: "Inventory", largeExpenseFlag: true,
    source: "MANUAL_ENTRY", reviewStatus: "Needs Review", duplicateStatus: "Not Checked",
    createdAt: "2026-03-04T00:00:00.000Z",
  } as unknown as RecordItem;
}

function notification(message: string): Notification {
  return {
    id: 1, businessProfileId: 1, expenseRecordId: null, message,
    type: "LARGE_EXPENSE", dateCreated: new Date().toISOString(), readStatus: false,
  };
}

/**
 * Releases the held request and gives its continuation a full macrotask to
 * render. Without the wait a `waitFor(... not.toBeInTheDocument())` passes on
 * its first tick against the unfixed code too, which would make these tests
 * prove nothing.
 */
async function settle(held: Deferred<{ data: unknown }>, response: { data: unknown }) {
  await act(async () => {
    held.resolve(response);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Answers `first` for profile A and `second` for everyone else. */
function perProfile(first: Promise<{ data: unknown }>, second: unknown) {
  return (businessProfileId: unknown) =>
    businessProfileId === profileA.id ? first : Promise.resolve({ data: second });
}

const alwaysEmpty = (data: unknown) => () => Promise.resolve({ data });

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  selectedProfile = profileA;
  getHandlers = {};
  patchCalls = [];
  patchResponses = [];
});

describe("a business-profile switch during a slow read", () => {
  it("never lets the previous profile's dashboard summary land under the new name", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/dashboard/summary": perProfile(slow.promise, summaryWith(12345)),
      "/insights/expense-overview": alwaysEmpty(dashboardOverviewWith("Inventory")),
    };

    const { rerender } = render(
      <MemoryRouter><ThemeProvider><Dashboard /></ThemeProvider></MemoryRouter>,
    );

    selectedProfile = profileB;
    rerender(<MemoryRouter><ThemeProvider><Dashboard /></ThemeProvider></MemoryRouter>);

    expect(await screen.findByText("PHP 12,345")).toBeInTheDocument();
    await settle(slow, { data: summaryWith(50000) });

    expect(screen.queryByText("PHP 50,000")).not.toBeInTheDocument();
    expect(screen.getByText("PHP 12,345")).toBeInTheDocument();
  });

  it("never lets the previous profile's expense overview land under the new name", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/insights/expense-overview": perProfile(slow.promise, detailOverviewWith("Transport")),
      "/records/flagged": alwaysEmpty({ items: [], nextCursor: null }),
      "/records/flagged/count": alwaysEmpty({ total: 0, expenses: 0, sales: 0 }),
      "/insights/findings": alwaysEmpty({ items: [], nextCursor: null }),
      "/insights/recurring-patterns": alwaysEmpty([]),
      "/insights/recurring-schedules": alwaysEmpty([]),
    };

    const tree = () => (
      <MemoryRouter><ThemeProvider><ExpenseInsight /></ThemeProvider></MemoryRouter>
    );
    const { rerender } = render(tree());

    selectedProfile = profileB;
    rerender(tree());

    expect(await screen.findAllByText("Transport")).not.toHaveLength(0);
    await settle(slow, { data: detailOverviewWith("Inventory") });

    expect(screen.queryByText("Inventory")).not.toBeInTheDocument();
  });

  it("never lets the previous profile's flagged queue land under the new name", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/records/flagged": perProfile(slow.promise, { items: [flaggedRecord("Delivery van")], nextCursor: null }),
      "/insights/findings": alwaysEmpty({ items: [], nextCursor: null }),
      "/records/csv-imports/batches": alwaysEmpty([]),
    };

    const tree = () => (
      <MemoryRouter initialEntries={["/records/flagged"]}>
        <ThemeProvider><FlaggedRecords /></ThemeProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree());

    selectedProfile = profileB;
    rerender(tree());

    expect(await screen.findByText(/Delivery van/)).toBeInTheDocument();
    await settle(slow, { data: { items: [flaggedRecord("Rice sack")], nextCursor: null } });

    expect(screen.queryByText(/Rice sack/)).not.toBeInTheDocument();
  });

  it("never lets the previous profile's notifications land in the bell", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/notifications": perProfile(slow.promise, [notification("Second store import finished")]),
    };

    function Readout() {
      const { notifications } = useNotifications();
      return <ul>{notifications.map((n) => <li key={n.id}>{n.message}</li>)}</ul>;
    }
    const tree = () => (
      <BusinessOwnedBoundary>
        <NotificationProvider><Readout /></NotificationProvider>
      </BusinessOwnedBoundary>
    );

    const { rerender } = render(tree());

    selectedProfile = profileB;
    rerender(tree());

    expect(screen.queryByText("Sari-sari duplicate found")).not.toBeInTheDocument();
    expect(await screen.findByText("Second store import finished")).toBeInTheDocument();
    await settle(slow, { data: [notification("Sari-sari duplicate found")] });

    expect(screen.queryByText("Sari-sari duplicate found")).not.toBeInTheDocument();
  });

  it("aborts an invalidation-driven notification refresh when the business changes", async () => {
    const slowRefresh = deferred<{ data: unknown }>();
    let firstBusinessRequests = 0;
    getHandlers = {
      "/notifications": (businessProfileId) => {
        if (businessProfileId !== profileA.id) {
          return Promise.resolve({ data: [notification("Second store alert")] });
        }
        firstBusinessRequests += 1;
        return firstBusinessRequests === 1
          ? Promise.resolve({ data: [notification("First store alert")] })
          : slowRefresh.promise;
      },
    };
    function Readout() {
      const { notifications } = useNotifications();
      return <ul>{notifications.map((item) => <li key={item.id}>{item.message}</li>)}</ul>;
    }
    const tree = () => <NotificationProvider><Readout /></NotificationProvider>;
    const { rerender } = render(tree());
    expect(await screen.findByText("First store alert")).toBeInTheDocument();

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      resourcePrefix: "/notifications",
    }));
    await waitFor(() => expect(firstBusinessRequests).toBe(2));

    selectedProfile = profileB;
    rerender(tree());
    expect(await screen.findByText("Second store alert")).toBeInTheDocument();
    await settle(slowRefresh, { data: [notification("Late first store alert")] });
    expect(screen.queryByText("Late first store alert")).not.toBeInTheDocument();
    expect(screen.getByText("Second store alert")).toBeInTheDocument();
  });

  it("keeps the latest notification refresh when same-business requests resolve out of order", async () => {
    const olderRefresh = deferred<{ data: unknown }>();
    const newerRefresh = deferred<{ data: unknown }>();
    let requests = 0;
    getHandlers = {
      "/notifications": () => {
        requests += 1;
        if (requests === 1) return Promise.resolve({ data: [notification("Initial alert")] });
        return requests === 2 ? olderRefresh.promise : newerRefresh.promise;
      },
    };
    function Readout() {
      const { notifications } = useNotifications();
      return <ul>{notifications.map((item) => <li key={item.id}>{item.message}</li>)}</ul>;
    }

    render(<NotificationProvider><Readout /></NotificationProvider>);
    expect(await screen.findByText("Initial alert")).toBeInTheDocument();

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      resourcePrefix: "/notifications",
    }));
    await waitFor(() => expect(requests).toBe(2));
    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      tags: ["notifications"],
    }));
    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      resourcePrefixes: ["/notifications", "/dashboard/summary"],
    }));
    expect(requests).toBe(2);

    await settle(olderRefresh, { data: [notification("Stale alert")] });
    await waitFor(() => expect(requests).toBe(3));
    expect(screen.queryByText("Stale alert")).not.toBeInTheDocument();
    await settle(newerRefresh, { data: [notification("Latest alert")] });
    expect(await screen.findByText("Latest alert")).toBeInTheDocument();
    expect(screen.getByText("Latest alert")).toBeInTheDocument();
  });

  it("deduplicates ordinary notification refreshes against the active request", async () => {
    const initial = deferred<{ data: unknown }>();
    let requests = 0;
    getHandlers = {
      "/notifications": () => {
        requests += 1;
        return initial.promise;
      },
    };
    function Controls() {
      const { refresh } = useNotifications();
      return <button type="button" onClick={() => { void refresh(); void refresh(); }}>Refresh twice</button>;
    }

    render(<NotificationProvider><Controls /></NotificationProvider>);
    expect(requests).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh twice" }));
    expect(requests).toBe(1);

    await settle(initial, { data: [notification("Only response")] });
    expect(requests).toBe(1);
  });

  it("does not let a pre-mutation notification refresh undo optimistic read state", async () => {
    const staleSingleRefresh = deferred<{ data: unknown }>();
    const staleAllRefresh = deferred<{ data: unknown }>();
    const unread = [
      notification("First alert"),
      { ...notification("Second alert"), id: 2 },
    ];
    let requests = 0;
    getHandlers = {
      "/notifications": () => {
        requests += 1;
        if (requests === 1) return Promise.resolve({ data: unread });
        return requests === 2 ? staleSingleRefresh.promise : staleAllRefresh.promise;
      },
    };
    function Controls() {
      const { notifications, markRead, markAllRead } = useNotifications();
      return (
        <>
          {notifications.map((item) => (
            <span key={item.id}>{item.id}:{item.readStatus ? "read" : "unread"}</span>
          ))}
          <button type="button" onClick={() => void markRead(1)}>Read first</button>
          <button type="button" onClick={() => void markAllRead()}>Read all</button>
        </>
      );
    }

    render(<NotificationProvider><Controls /></NotificationProvider>);
    expect(await screen.findByText("1:unread")).toBeInTheDocument();

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      tags: ["notifications"],
    }));
    await waitFor(() => expect(requests).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Read first" }));
    await waitFor(() => expect(patchCalls).toContainEqual({
      url: "/notifications/1/read",
      body: undefined,
      config: { serverStateScope: { businessProfileId: profileA.id } },
    }));
    await settle(staleSingleRefresh, { data: unread });
    expect(screen.getByText("1:read")).toBeInTheDocument();
    expect(screen.getByText("2:unread")).toBeInTheDocument();

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      resourcePrefix: "/notifications",
    }));
    await waitFor(() => expect(requests).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    await waitFor(() => expect(patchCalls).toContainEqual({
      url: "/notifications/read-all",
      body: null,
      config: {
        params: { businessProfileId: profileA.id },
        serverStateScope: { businessProfileId: profileA.id },
      },
    }));
    await settle(staleAllRefresh, { data: unread });
    expect(screen.getByText("1:read")).toBeInTheDocument();
    expect(screen.getByText("2:read")).toBeInTheDocument();
  });

  it("does not let an older mark-one failure undo a newer mark-all success", async () => {
    const olderMarkOne = deferred<{ data: unknown }>();
    patchResponses = [olderMarkOne.promise, Promise.resolve({ data: {} })];
    getHandlers = {
      "/notifications": async () => ({
        data: [notification("First alert"), { ...notification("Second alert"), id: 2 }],
      }),
    };
    function Controls() {
      const { notifications, markRead, markAllRead } = useNotifications();
      return (
        <>
          {notifications.map((item) => (
            <span key={item.id}>{item.id}:{item.readStatus ? "read" : "unread"}</span>
          ))}
          <button type="button" onClick={() => void markRead(1)}>Read first</button>
          <button type="button" onClick={() => void markAllRead()}>Read all</button>
        </>
      );
    }

    render(<NotificationProvider><Controls /></NotificationProvider>);
    expect(await screen.findByText("1:unread")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read first" }));
    fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    await waitFor(() => expect(patchCalls).toHaveLength(2));
    expect(screen.getByText("1:read")).toBeInTheDocument();
    expect(screen.getByText("2:read")).toBeInTheDocument();

    await act(async () => {
      olderMarkOne.reject(new Error("mark one failed"));
      await olderMarkOne.promise.catch(() => undefined);
    });
    expect(screen.getByText("1:read")).toBeInTheDocument();
    expect(screen.getByText("2:read")).toBeInTheDocument();
  });

  it("does not let an older mark-all failure restore over a newer row success", async () => {
    const olderMarkAll = deferred<{ data: unknown }>();
    patchResponses = [olderMarkAll.promise, Promise.resolve({ data: {} })];
    getHandlers = {
      "/notifications": async () => ({
        data: [notification("First alert"), { ...notification("Second alert"), id: 2 }],
      }),
    };
    function Controls() {
      const { notifications, markRead, markAllRead } = useNotifications();
      return (
        <>
          {notifications.map((item) => (
            <span key={item.id}>{item.id}:{item.readStatus ? "read" : "unread"}</span>
          ))}
          <button type="button" onClick={() => void markRead(1)}>Read first</button>
          <button type="button" onClick={() => void markAllRead()}>Read all</button>
        </>
      );
    }

    render(<NotificationProvider><Controls /></NotificationProvider>);
    expect(await screen.findByText("1:unread")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    fireEvent.click(screen.getByRole("button", { name: "Read first" }));
    await waitFor(() => expect(patchCalls).toHaveLength(2));

    await act(async () => {
      olderMarkAll.reject(new Error("mark all failed"));
      await olderMarkAll.promise.catch(() => undefined);
    });
    expect(screen.getByText("1:read")).toBeInTheDocument();
    expect(screen.getByText("2:unread")).toBeInTheDocument();
  });

  it("never lets the previous profile's cached recovery request land under the new name", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/insights/recovery": perProfile(slow.promise, recoveryWith(12_345)),
      "/business-profiles/1/recovery-plans": alwaysEmpty([]),
      "/business-profiles/2/recovery-plans": alwaysEmpty([]),
    };
    const tree = () => <MemoryRouter><RecoveryInsightPage /></MemoryRouter>;
    const { rerender } = render(tree());

    selectedProfile = profileB;
    rerender(tree());

    expect((await screen.findAllByText("PHP 12,345")).length).toBeGreaterThan(0);
    await settle(slow, { data: recoveryWith(54_321) });
    expect(screen.queryByText("PHP 54,321")).not.toBeInTheDocument();
  });

  it("scopes notification mutations locally and refreshes only for a related business event", async () => {
    let requests = 0;
    getHandlers = {
      "/notifications": async () => {
        requests += 1;
        return { data: [notification("Rent alert")] };
      },
    };

    function Controls() {
      const { notifications, markRead, markAllRead } = useNotifications();
      return (
        <>
          <span>{notifications[0]?.message}</span>
          <button type="button" onClick={() => void markRead(1)}>Read one</button>
          <button type="button" onClick={() => void markAllRead()}>Read all</button>
        </>
      );
    }

    render(<NotificationProvider><Controls /></NotificationProvider>);
    expect(await screen.findByText("Rent alert")).toBeInTheDocument();
    expect(requests).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Read one" }));
    await waitFor(() => expect(patchCalls).toContainEqual({
      url: "/notifications/1/read",
      body: undefined,
      config: { serverStateScope: { businessProfileId: profileA.id } },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    await waitFor(() => expect(patchCalls).toContainEqual({
      url: "/notifications/read-all",
      body: null,
      config: {
        params: { businessProfileId: profileA.id },
        serverStateScope: { businessProfileId: profileA.id },
      },
    }));

    act(() => invalidateServerState({
      businessProfileId: profileB.id,
      resourcePrefix: "/notifications",
    }));
    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      resourcePrefix: "/dashboard/summary",
    }));
    act(() => invalidateServerState({
      businessProfileId: profileB.id,
      tags: ["financial", "record-months", "notifications"],
    }));
    expect(requests).toBe(1);

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      tags: ["financial", "record-months", "notifications"],
    }));
    await waitFor(() => expect(requests).toBe(2));

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      resourcePrefixes: ["/insights/recurring-", "/notifications"],
    }));
    await waitFor(() => expect(requests).toBe(3));

    act(() => invalidateServerState({ resourcePrefix: "/notifications" }));
    await waitFor(() => expect(requests).toBe(4));
  });
});
