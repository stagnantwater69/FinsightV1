// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const gets: string[] = [];
let blocked = false;

vi.mock("./api", () => ({
  api: {
    get: async (url: string) => {
      gets.push(url);
      return { data: { items: [], nextCursor: null, expenses: 0, sales: 0, total: 0 } };
    },
  },
}));
vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 4 } }),
}));
vi.mock("../context/FutureDatedRecordsContext", () => ({
  useFutureDatedRecords: () => ({ blocked }),
}));
vi.mock("../context/ReportingPeriodContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/ReportingPeriodContext")>()),
  useReportingPeriod: () => ({ months: ["2026-10"], monthsState: "ready" }),
}));

const { PrefetchLink } = await import("../components/PrefetchLink");
const { RouteDataPrefetchProvider } = await import("./routeDataPrefetch");
const { beginServerStateSession, endServerStateSession } = await import("./serverStateCache");

function hover(to: string) {
  render(
    <MemoryRouter>
      <RouteDataPrefetchProvider>
        <PrefetchLink to={to}>Go</PrefetchLink>
      </RouteDataPrefetchProvider>
    </MemoryRouter>,
  );
  fireEvent.pointerEnter(screen.getByRole("link", { name: "Go" }));
}

beforeEach(() => {
  gets.length = 0;
  blocked = false;
});
afterEach(() => endServerStateSession());

describe("route data warm-up", () => {
  it("starts a screen's main read when its link is pointed at", async () => {
    beginServerStateSession(9);
    hover("/records");
    await vi.waitFor(() => expect(gets).toEqual(["/records/search", "/records/flagged/count"]));
  });

  it("asks nothing before the cache knows whose session it is", async () => {
    hover("/records");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gets).toEqual([]);
  });

  it("asks nothing for a screen the future-dated gate is holding closed", async () => {
    beginServerStateSession(9);
    blocked = true;
    hover("/insights/expense-behavior");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gets).toEqual([]);
  });

  it("asks nothing for a screen whose first read it cannot predict", async () => {
    beginServerStateSession(9);
    hover("/profile");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gets).toEqual([]);
  });
});
