import React, { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "./support/fixtures";
import type { PeriodSelection } from "../../src/lib/reportingPeriod";

const apiGet = vi.fn();
const screenRead = vi.fn();
const user = { id: 44 };
const takeBootstrapProfiles = () => null;

vi.mock("../../src/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : "Something went wrong."),
}));

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ profile: user, takeBootstrapProfiles }),
}));

const { BusinessProfileProvider, useBusinessProfiles } = await import(
  "../../src/context/BusinessProfileContext"
);
const { ReportingPeriodProvider, ReportingPeriodScope, useReportingPeriod } = await import(
  "../../src/context/ReportingPeriodContext"
);
const { invalidateServerState } = await import("../../src/lib/serverStateCache");

let business!: ReturnType<typeof useBusinessProfiles>;
let period!: ReturnType<typeof useReportingPeriod>;

function QueryProbe() {
  business = useBusinessProfiles();
  const periodValue = useReportingPeriod();
  period = periodValue;
  const businessId = business.selected?.id ?? null;
  const selectionKey = JSON.stringify(periodValue.selection);

  useEffect(() => {
    if (!businessId || !periodValue.ready) return;
    screenRead({ businessProfileId: businessId, selection: JSON.parse(selectionKey) as PeriodSelection });
  }, [businessId, periodValue.ready, selectionKey]);

  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  apiGet.mockReset();
  screenRead.mockReset();
});

afterEach(cleanup);

describe("ReportingPeriodProvider business isolation", () => {
  it("withholds the previous business's ready month until the next business's months resolve", async () => {
    const secondBusiness = { ...fixtures.businessProfile, id: 2, name: "Second business" };
    const secondMonths = deferred<{ months: string[] }>();

    apiGet.mockImplementation((path: string, query?: { businessProfileId?: number }) => {
      if (path === "/business-profiles") return Promise.resolve([fixtures.businessProfile, secondBusiness]);
      if (path === "/records/categories") return Promise.resolve([]);
      if (path === "/records/months" && query?.businessProfileId === fixtures.businessProfile.id) {
        return Promise.resolve({ months: ["2026-08"] });
      }
      if (path === "/records/months" && query?.businessProfileId === secondBusiness.id) {
        return secondMonths.promise;
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await render(
      <BusinessProfileProvider>
        <ReportingPeriodProvider>
          <QueryProbe />
        </ReportingPeriodProvider>
      </BusinessProfileProvider>,
    );

    await waitFor(() => {
      expect(screenRead).toHaveBeenCalledWith({
        businessProfileId: fixtures.businessProfile.id,
        selection: { kind: "month", month: "2026-08" } satisfies PeriodSelection,
      });
    });
    screenRead.mockClear();

    await act(() => business.selectProfile(secondBusiness.id));

    expect(period.ready).toBe(false);
    expect(period.monthsState).toBe("loading");
    expect(period.months).toEqual([]);
    expect(screenRead).not.toHaveBeenCalled();

    await act(() => secondMonths.resolve({ months: ["2025-12"] }));

    await waitFor(() => {
      expect(screenRead).toHaveBeenCalledTimes(1);
      expect(screenRead).toHaveBeenCalledWith({
        businessProfileId: secondBusiness.id,
        selection: { kind: "month", month: "2025-12" } satisfies PeriodSelection,
      });
    });
    expect(screenRead).not.toHaveBeenCalledWith({
      businessProfileId: secondBusiness.id,
      selection: { kind: "month", month: "2026-08" },
    });
  });

  it("loads months once cold, then refreshes only for a relevant mutation in the selected business", async () => {
    const secondBusiness = { ...fixtures.businessProfile, id: 2, name: "Second business" };
    let firstBusinessMonths: string[] = [];

    apiGet.mockImplementation((path: string, query?: { businessProfileId?: number }) => {
      if (path === "/business-profiles") return Promise.resolve([fixtures.businessProfile, secondBusiness]);
      if (path === "/records/categories") return Promise.resolve([]);
      if (path === "/records/months" && query?.businessProfileId === fixtures.businessProfile.id) {
        return Promise.resolve({ months: firstBusinessMonths });
      }
      if (path === "/records/months" && query?.businessProfileId === secondBusiness.id) {
        return Promise.resolve({ months: ["2026-01"] });
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await render(
      <BusinessProfileProvider>
        <ReportingPeriodProvider>
          <QueryProbe />
        </ReportingPeriodProvider>
      </BusinessProfileProvider>,
    );

    const monthsCalls = () => apiGet.mock.calls.filter(([path]) => path === "/records/months");
    await waitFor(() => expect(monthsCalls()).toHaveLength(1));
    await waitFor(() => expect(period.ready).toBe(true));
    expect(period.selection).toEqual({ kind: "week" });

    firstBusinessMonths = ["2025-11"];
    await act(async () => {
      invalidateServerState({
        businessProfileId: fixtures.businessProfile.id,
        pathPrefixes: ["/records", "/dashboard", "/insights"],
      });
    });

    await waitFor(() => expect(monthsCalls()).toHaveLength(2));
    await waitFor(() => expect(period.selection).toEqual({ kind: "month", month: "2025-11" }));

    await act(async () => {
      invalidateServerState({
        businessProfileId: secondBusiness.id,
        pathPrefixes: ["/records"],
      });
    });
    expect(monthsCalls()).toHaveLength(2);
  });

  it("coalesces invalidations during a cold request into one scoped follow-up", async () => {
    const secondBusiness = { ...fixtures.businessProfile, id: 2, name: "Second business" };
    const coldMonths = deferred<{ months: string[] }>();
    let monthRequest = 0;
    apiGet.mockImplementation((path: string, query?: { businessProfileId?: number }) => {
      if (path === "/business-profiles") return Promise.resolve([fixtures.businessProfile, secondBusiness]);
      if (path === "/records/categories") return Promise.resolve([]);
      if (path === "/records/months" && query?.businessProfileId === fixtures.businessProfile.id) {
        monthRequest += 1;
        return monthRequest === 1
          ? coldMonths.promise
          : Promise.resolve({ months: ["2025-10"] });
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await render(
      <BusinessProfileProvider>
        <ReportingPeriodProvider>
          <QueryProbe />
        </ReportingPeriodProvider>
      </BusinessProfileProvider>,
    );
    const monthsCalls = () => apiGet.mock.calls.filter(([path]) => path === "/records/months");
    await waitFor(() => expect(monthsCalls()).toHaveLength(1));

    await act(async () => {
      invalidateServerState({ pathPrefixes: ["/records"] });
      invalidateServerState({ businessProfileId: fixtures.businessProfile.id, pathPrefixes: ["/records"] });
      invalidateServerState({ businessProfileId: fixtures.businessProfile.id, pathPrefixes: ["/records"] });
    });
    expect(monthsCalls()).toHaveLength(1);

    await act(async () => {
      coldMonths.resolve({ months: [] });
      await coldMonths.promise;
    });
    await waitFor(() => expect(monthsCalls()).toHaveLength(2));
    await waitFor(() => expect(period.selection).toEqual({ kind: "month", month: "2025-10" }));
    expect(monthsCalls()).toHaveLength(2);
  });

  it("does not queue a refresh for another business while the selected business is loading", async () => {
    const secondBusiness = { ...fixtures.businessProfile, id: 2, name: "Second business" };
    const coldMonths = deferred<{ months: string[] }>();
    apiGet.mockImplementation((path: string, query?: { businessProfileId?: number }) => {
      if (path === "/business-profiles") return Promise.resolve([fixtures.businessProfile, secondBusiness]);
      if (path === "/records/categories") return Promise.resolve([]);
      if (path === "/records/months" && query?.businessProfileId === fixtures.businessProfile.id) {
        return coldMonths.promise;
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await render(
      <BusinessProfileProvider>
        <ReportingPeriodProvider>
          <QueryProbe />
        </ReportingPeriodProvider>
      </BusinessProfileProvider>,
    );
    const monthsCalls = () => apiGet.mock.calls.filter(([path]) => path === "/records/months");
    await waitFor(() => expect(monthsCalls()).toHaveLength(1));

    await act(async () => {
      invalidateServerState({ businessProfileId: secondBusiness.id, pathPrefixes: ["/records"] });
      coldMonths.resolve({ months: ["2025-09"] });
      await coldMonths.promise;
    });

    await waitFor(() => expect(period.selection).toEqual({ kind: "month", month: "2025-09" }));
    expect(monthsCalls()).toHaveLength(1);
  });
});

const scopeNames = ["dashboard", "expense-insight", "recovery-target", "spending-impact"] as const;
const scopedPeriods: Partial<Record<(typeof scopeNames)[number], ReturnType<typeof useReportingPeriod>>> = {};

function ScopedProbe({ name }: { name: (typeof scopeNames)[number] }) {
  business = useBusinessProfiles();
  scopedPeriods[name] = useReportingPeriod();
  return null;
}

function scopedTree(showInsights = true) {
  return (
    <BusinessProfileProvider>
      <ReportingPeriodProvider>
        {scopeNames.filter((name) => showInsights || name !== "expense-insight").map((name) => (
          <ReportingPeriodScope key={name} scope={name}>
            <ScopedProbe name={name} />
          </ReportingPeriodScope>
        ))}
      </ReportingPeriodProvider>
    </BusinessProfileProvider>
  );
}

function mockScopedMonths(secondMonths?: Promise<{ months: string[] }>) {
  const secondBusiness = { ...fixtures.businessProfile, id: 2, name: "Second business" };
  apiGet.mockImplementation((path: string, query?: { businessProfileId?: number }) => {
    if (path === "/business-profiles") return Promise.resolve([fixtures.businessProfile, secondBusiness]);
    if (path === "/records/categories") return Promise.resolve([]);
    if (path === "/records/months") {
      return query?.businessProfileId === secondBusiness.id
        ? secondMonths ?? Promise.resolve({ months: ["2025-12"] })
        : Promise.resolve({ months: ["2026-08", "2026-07"] });
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  return secondBusiness;
}

async function waitForScopes() {
  await waitFor(() => {
    for (const name of scopeNames) expect(scopedPeriods[name]?.ready).toBe(true);
  });
}

const monthsCalls = () => apiGet.mock.calls.filter(([path]) => path === "/records/months");

describe("independent screen reporting periods", () => {
  it("keeps Insight month and all-time choices separate from the other screens", async () => {
    mockScopedMonths();
    await render(scopedTree());
    await waitForScopes();
    await act(() => scopedPeriods["expense-insight"]!.setSelection({ kind: "month", month: "2026-07" }));
    expect(scopedPeriods["expense-insight"]!.selection).toEqual({ kind: "month", month: "2026-07" });
    for (const name of ["dashboard", "recovery-target", "spending-impact"] as const) {
      expect(scopedPeriods[name]!.selection).toEqual({ kind: "month", month: "2026-08" });
    }
    await act(() => scopedPeriods["expense-insight"]!.setSelection({ kind: "all" }));
    await act(() => scopedPeriods["recovery-target"]!.setSelection({ kind: "week" }));
    expect(scopedPeriods["expense-insight"]!.selection).toEqual({ kind: "all" });
    expect(scopedPeriods.dashboard!.selection).toEqual({ kind: "month", month: "2026-08" });
    expect(scopedPeriods["spending-impact"]!.selection).toEqual({ kind: "month", month: "2026-08" });
    expect(monthsCalls()).toHaveLength(1);
  });

  it("restores each screen's choice when its scope remounts", async () => {
    mockScopedMonths();
    const view = await render(scopedTree());
    await waitForScopes();
    await act(() => scopedPeriods["expense-insight"]!.setSelection({ kind: "all" }));
    await act(() => scopedPeriods.dashboard!.setSelection({ kind: "week" }));
    await view.rerender(scopedTree(false));
    await view.rerender(scopedTree());
    await waitForScopes();
    expect(scopedPeriods["expense-insight"]!.selection).toEqual({ kind: "all" });
    expect(scopedPeriods.dashboard!.selection).toEqual({ kind: "week" });
    expect(monthsCalls()).toHaveLength(1);
  });

  it("gates saved months during a business switch and restores the first business's screen choices", async () => {
    const pending = deferred<{ months: string[] }>();
    const secondBusiness = mockScopedMonths(pending.promise);
    await render(scopedTree());
    await waitForScopes();
    await act(() => scopedPeriods.dashboard!.setSelection({ kind: "month", month: "2026-07" }));
    await act(() => scopedPeriods["expense-insight"]!.setSelection({ kind: "all" }));
    await act(() => business.selectProfile(secondBusiness.id));
    for (const name of scopeNames) {
      expect(scopedPeriods[name]!.ready).toBe(false);
      expect(scopedPeriods[name]!.months).toEqual([]);
    }
    await act(() => pending.resolve({ months: ["2025-12"] }));
    await waitForScopes();
    for (const name of scopeNames) {
      expect(scopedPeriods[name]!.selection).toEqual({ kind: "month", month: "2025-12" });
    }
    const returnMonths = deferred<{ months: string[] }>();
    apiGet.mockImplementation((path: string) => {
      if (path === "/records/months") return returnMonths.promise;
      if (path === "/records/categories") return Promise.resolve([]);
      throw new Error(`Unexpected GET ${path}`);
    });
    await act(() => business.selectProfile(fixtures.businessProfile.id));
    expect(scopedPeriods.dashboard!.ready).toBe(false);
    await act(() => returnMonths.resolve({ months: ["2026-08", "2026-07"] }));
    await waitForScopes();
    expect(scopedPeriods.dashboard!.selection).toEqual({ kind: "month", month: "2026-07" });
    expect(scopedPeriods["expense-insight"]!.selection).toEqual({ kind: "all" });
    expect(scopedPeriods["recovery-target"]!.selection).toEqual({ kind: "month", month: "2026-08" });
  });

  it("shares one month refresh without replacing independent choices", async () => {
    mockScopedMonths();
    await render(scopedTree());
    await waitForScopes();
    await act(() => scopedPeriods["expense-insight"]!.setSelection({ kind: "all" }));
    await act(() => scopedPeriods.dashboard!.setSelection({ kind: "week" }));
    await act(() => invalidateServerState({ businessProfileId: fixtures.businessProfile.id, pathPrefixes: ["/records"] }));
    await waitFor(() => expect(monthsCalls()).toHaveLength(2));
    expect(scopedPeriods["expense-insight"]!.selection).toEqual({ kind: "all" });
    expect(scopedPeriods.dashboard!.selection).toEqual({ kind: "week" });
  });
});
