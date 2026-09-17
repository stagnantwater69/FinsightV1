// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { NotificationProvider, useNotifications } from "../context/NotificationContext";
import { Dashboard } from "./Dashboard";
import { ExpenseInsight } from "./ExpenseInsight";
import { FlaggedRecords } from "./FlaggedRecords";
import type {
  BusinessProfile,
  DashboardSummary,
  ExpenseBehavior,
  Notification,
  RecordItem,
  ReductionOpportunityResponse,
} from "../lib/types";

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
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
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

vi.mock("../lib/api", () => ({
  api: {
    get: (url: string, config?: GetConfig) => {
      const handler = getHandlers[url];
      if (!handler) return Promise.reject(new Error(`unmocked GET ${url}`));
      return abortable(handler(config?.params?.businessProfileId), config?.signal);
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
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

const emptyReduction = {
  period: { days: 30, start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" },
  dataQuality: { status: "sufficient", currentRecordCount: 10, previousRecordCount: 8, message: null },
  opportunities: [],
  detectorVersion: "v1",
} as unknown as ReductionOpportunityResponse;

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
});

describe("a business-profile switch during a slow read", () => {
  it("never lets the previous profile's dashboard summary land under the new name", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/dashboard/summary": perProfile(slow.promise, summaryWith(12345)),
      "/insights/expense-behavior": alwaysEmpty(behaviorWith("Inventory")),
      "/insights/reduction-opportunities": alwaysEmpty(emptyReduction),
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

  it("never lets the previous profile's expense behaviour land under the new name", async () => {
    const slow = deferred<{ data: unknown }>();
    getHandlers = {
      "/insights/expense-behavior": perProfile(slow.promise, behaviorWith("Transport")),
      "/insights/reduction-opportunities": alwaysEmpty(emptyReduction),
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
    await settle(slow, { data: behaviorWith("Inventory") });

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
    const tree = () => <NotificationProvider><Readout /></NotificationProvider>;

    const { rerender } = render(tree());

    selectedProfile = profileB;
    rerender(tree());

    expect(await screen.findByText("Second store import finished")).toBeInTheDocument();
    await settle(slow, { data: [notification("Sari-sari duplicate found")] });

    expect(screen.queryByText("Sari-sari duplicate found")).not.toBeInTheDocument();
  });
});
