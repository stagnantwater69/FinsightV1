import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import {
  beginServerStateSession,
  endServerStateSession,
  peekServerState,
  queryServerState,
  serverStateCacheStats,
  subscribeToServerState,
  type ServerStateScope,
} from "./serverStateCache";

vi.mock("./supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "test-token" } } })),
    },
  },
}));

const { api } = await import("./api");

const successAdapter = async (config: InternalAxiosRequestConfig) =>
  ({
    data: config.url === "/records/receipts/19/confirm" ? [] : {},
    status: config.method === "delete" ? 204 : 200,
    statusText: "OK",
    headers: {},
    config,
  }) as AxiosResponse;

const cachedScope: ServerStateScope = {
  resource: "/dashboard/summary",
  businessProfileId: 1,
  period: { kind: "month", month: "2026-09" },
  tags: ["dashboard", "financial"],
};

beforeEach(() => {
  api.defaults.adapter = successAdapter;
  beginServerStateSession("user-a");
});
afterEach(() => endServerStateSession());

describe("API mutation cache invalidation", () => {
  it("clears cached financial data and cancels in-flight reads after a successful mutation", async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribeToServerState((event) => events.push(event));
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    const notificationsScope: ServerStateScope = {
      resource: "/notifications",
      businessProfileId: 1,
      tags: ["notifications"],
    };
    await queryServerState(notificationsScope, async () => ["New duplicate"]);
    const otherBusiness = { ...cachedScope, businessProfileId: 2 };
    await queryServerState(otherBusiness, async () => ({ total: 8_000 }));
    let aborted = false;
    const pending = queryServerState(
      { ...cachedScope, resource: "/records/search" },
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );

    await api.post("/records/expenses", { businessProfileId: 1, amount: 500 });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(notificationsScope)).toBeNull();
    expect(peekServerState(otherBusiness)?.data).toEqual({ total: 8_000 });
    expect(serverStateCacheStats()).toMatchObject({ entries: 1, inFlight: 0 });
    expect(events).toContainEqual({
      type: "invalidate",
      target: {
        businessProfileId: 1,
        tags: ["financial", "record-months", "notifications"],
      },
    });
    unsubscribe();
  });

  it("keeps a 204 record delete scoped through request-local metadata", async () => {
    const otherBusiness = { ...cachedScope, businessProfileId: 2 };
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    await queryServerState(otherBusiness, async () => ({ total: 8_000 }));

    await api.delete("/records/expenses/41", {
      serverStateScope: { businessProfileId: 1 },
    });

    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(otherBusiness)?.data).toEqual({ total: 8_000 });
  });

  it("scopes receipt-confirmation invalidation when the response is an array", async () => {
    const otherBusiness = { ...cachedScope, businessProfileId: 2 };
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    await queryServerState(otherBusiness, async () => ({ total: 8_000 }));

    await api.post(
      "/records/receipts/19/confirm",
      { date: "2026-09-20" },
      { serverStateScope: { businessProfileId: 1 } },
    );

    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(otherBusiness)?.data).toEqual({ total: 8_000 });
  });

  it("does not invalidate on read-only simulation POSTs", async () => {
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));

    await api.post("/insights/reduction-simulation", { categoryId: 3 });

    expect(peekServerState(cachedScope)?.data).toEqual({ total: 12_000 });
  });

  it("does not invalidate for write-only feedback or uncommitted import and receipt staging", async () => {
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));

    await api.post("/insights/reduction-opportunities/feedback", {
      businessProfileId: 1,
      opportunityId: "opp-1",
      rating: "helpful",
    });
    await api.post("/records/csv-imports/preview", { businessProfileId: 1 });
    await api.delete("/records/csv-imports/stages/stage-1");
    await api.post("/records/receipts", { businessProfileId: 1 });

    expect(peekServerState(cachedScope)?.data).toEqual({ total: 12_000 });
  });

  it("invalidates recurring, finding, notification, and dashboard reads in one business", async () => {
    const recurringScope: ServerStateScope = {
      resource: "/insights/recurring-patterns",
      businessProfileId: 1,
      tags: ["recurring-patterns", "financial"],
    };
    const findingsScope = { ...cachedScope, resource: "/insights/findings" };
    const notificationsScope = { ...cachedScope, resource: "/notifications" };
    const recordsScope = { ...cachedScope, resource: "/records/search" };
    const otherBusinessDashboard = { ...cachedScope, businessProfileId: 2 };
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    await queryServerState(recurringScope, async () => ["rent"]);
    await queryServerState(findingsScope, async () => ["late rent"]);
    await queryServerState(notificationsScope, async () => ["Rent alert"]);
    await queryServerState(recordsScope, async () => ["record"]);
    await queryServerState(otherBusinessDashboard, async () => ({ total: 8_000 }));

    await api.patch(
      "/insights/recurring-patterns/7",
      { status: "DISMISSED" },
      { serverStateScope: { businessProfileId: 1 } },
    );

    expect(peekServerState(recurringScope)).toBeNull();
    expect(peekServerState(findingsScope)).toBeNull();
    expect(peekServerState(notificationsScope)).toBeNull();
    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(recordsScope)?.data).toEqual(["record"]);
    expect(peekServerState(otherBusinessDashboard)?.data).toEqual({ total: 8_000 });
  });

  it("keeps 204 recurring-schedule invalidation in the selected business", async () => {
    const recurringScope: ServerStateScope = {
      resource: "/insights/recurring-schedules",
      businessProfileId: 1,
      tags: ["recurring-schedules", "financial"],
    };
    const otherBusiness = { ...recurringScope, businessProfileId: 2 };
    await queryServerState(recurringScope, async () => ["rent"]);
    await queryServerState(otherBusiness, async () => ["utilities"]);

    await api.delete("/insights/recurring-schedules/7", {
      serverStateScope: { businessProfileId: 1 },
    });

    expect(peekServerState(recurringScope)).toBeNull();
    expect(peekServerState(otherBusiness)?.data).toEqual(["utilities"]);
  });

  it("invalidates finding-derived insight reads but keeps the records list", async () => {
    const findingsScope: ServerStateScope = {
      resource: "/insights/findings",
      businessProfileId: 1,
      tags: ["insights-findings", "financial"],
    };
    const recordsScope: ServerStateScope = {
      resource: "/records/search",
      businessProfileId: 1,
      tags: ["records", "financial"],
    };
    const overviewScope: ServerStateScope = {
      resource: "/insights/expense-overview",
      businessProfileId: 1,
      tags: ["expense-overview", "financial"],
    };
    const otherBusinessOverview = { ...overviewScope, businessProfileId: 2 };
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    await queryServerState(findingsScope, async () => ["finding"]);
    await queryServerState(overviewScope, async () => ({ opportunityCount: 1 }));
    await queryServerState(otherBusinessOverview, async () => ({ opportunityCount: 2 }));
    await queryServerState(recordsScope, async () => ["record"]);

    await api.patch(
      "/insights/findings/4/review",
      { status: "DISMISSED" },
      { serverStateScope: { businessProfileId: 1 } },
    );

    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(findingsScope)).toBeNull();
    expect(peekServerState(overviewScope)).toBeNull();
    expect(peekServerState(otherBusinessOverview)?.data).toEqual({ opportunityCount: 2 });
    expect(peekServerState(recordsScope)?.data).toEqual(["record"]);
  });

  it("keeps an accepted worker import cached until its terminal status is published", async () => {
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    const listener = vi.fn();
    const unsubscribe = subscribeToServerState(listener);
    api.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({
      data: { processingStatus: "PENDING", batchId: 9 },
      status: 202,
      statusText: "Accepted",
      headers: {},
      config,
    }) as AxiosResponse;

    await api.post("/records/csv-imports/confirm", { businessProfileId: 1 });

    expect(peekServerState(cachedScope)?.data).toEqual({ total: 12_000 });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("invalidates the selected dashboard after notification read mutations", async () => {
    const otherBusiness = { ...cachedScope, businessProfileId: 2 };
    await queryServerState(cachedScope, async () => ({ total: 12_000 }));
    await queryServerState(otherBusiness, async () => ({ total: 8_000 }));

    await api.patch("/notifications/17/read", undefined, {
      serverStateScope: { businessProfileId: 1 },
    });

    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(otherBusiness)?.data).toEqual({ total: 8_000 });

    await queryServerState(cachedScope, async () => ({ total: 11_000 }));
    await api.patch("/notifications/read-all", null, {
      params: { businessProfileId: 1 },
      serverStateScope: { businessProfileId: 1 },
    });
    expect(peekServerState(cachedScope)).toBeNull();
    expect(peekServerState(otherBusiness)?.data).toEqual({ total: 8_000 });
  });
});
