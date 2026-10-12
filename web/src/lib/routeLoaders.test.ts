import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../pages/Dashboard", () => {
  throw new Error("dashboard chunk unavailable");
});

import {
  clearRoutePrefetchRegistry,
  connectionAllowsRoutePrefetch,
  loadAddExpenseRoute,
  loadDashboardRoute,
  loadEditExpenseRoute,
  loadExpenseInsightRoute,
  prefetchPrimaryRoutes,
  prefetchRoute,
  routeLoaderFor,
} from "./routeLoaders";

afterEach(() => clearRoutePrefetchRegistry());

describe("route intent prefetch", () => {
  it("maps exact and parameterized destinations to their shared lazy loaders", () => {
    expect(routeLoaderFor("/dashboard")).toBe(loadDashboardRoute);
    expect(routeLoaderFor("/records/expenses/new")).toBe(loadAddExpenseRoute);
    expect(routeLoaderFor("/records/expenses/42/edit")).toBe(loadEditExpenseRoute);
    expect(routeLoaderFor("/insights/expense-behavior")).toBe(loadExpenseInsightRoute);
    expect(routeLoaderFor("/insights/expense-behavior?period=month#top")).toBe(loadExpenseInsightRoute);
    expect(routeLoaderFor("/not-a-route")).toBeUndefined();
  });

  it.each([
    [{ saveData: true }, false],
    [{ effectiveType: "slow-2g" }, false],
    [{ effectiveType: "2g" }, false],
    [{ effectiveType: "3g" }, true],
    [{ effectiveType: "4g" }, true],
    [undefined, true],
  ] as const)("applies the connection guard for %j", (connection, allowed) => {
    expect(connectionAllowsRoutePrefetch(connection)).toBe(allowed);
  });

  it("treats a rejected chunk warm-up as optional so navigation can retry", async () => {
    await expect(prefetchRoute("/dashboard", { effectiveType: "4g" })).resolves.toBeUndefined();
  });

  it("skips the primary-tab warm-up on a save-data connection", async () => {
    // The Dashboard chunk is mocked to throw on import: reaching it would
    // still resolve, so this asserts the guard by the loader never being hit.
    const imported = vi.fn();
    vi.doMock("../pages/Records", () => {
      imported();
      return {};
    });
    await expect(prefetchPrimaryRoutes({ saveData: true })).resolves.toBeUndefined();
    expect(imported).not.toHaveBeenCalled();
  });
});
