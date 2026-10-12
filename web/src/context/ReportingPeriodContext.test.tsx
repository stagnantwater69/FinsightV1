// @vitest-environment jsdom
import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessProfile } from "../lib/types";
import { invalidateServerState } from "../lib/serverStateCache";
import { PeriodFilter } from "../components/PeriodFilter";
import { ReportingPeriodProvider, useReportingPeriod } from "./ReportingPeriodContext";

/** The month picker renders its options only while open. */
async function findMonthOption(name: string) {
  if (!screen.queryByRole("listbox")) {
    const trigger = screen.getByRole("combobox", { name: "Month" });
    await waitFor(() => expect(trigger).toBeEnabled());
    act(() => trigger.click());
  }
  return screen.findByRole("option", { name });
}

const profileA = { id: 1, name: "First store" } as BusinessProfile;
const profileB = { id: 2, name: "Second store" } as BusinessProfile;
let selectedProfile = profileA;
let monthRequests: Record<number, Promise<{ data: { months: string[] } }>[]>;
let requestedBusinessIds: number[];

vi.mock("./BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedProfile }),
}));

vi.mock("../lib/api", () => ({
  api: {
    get: (_url: string, config: { params: { businessProfileId: number } }) => {
      const businessProfileId = config.params.businessProfileId;
      requestedBusinessIds.push(businessProfileId);
      const request = monthRequests[businessProfileId]?.shift();
      if (!request) return Promise.reject(new Error(`No month response for business ${businessProfileId}`));
      return request;
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const readySnapshots: string[] = [];

function Probe() {
  const period = useReportingPeriod();
  const selection = period.selection.kind === "month"
    ? `month:${period.selection.month}`
    : period.selection.kind;
  const snapshot = `${selectedProfile.id}:${period.ready}:${selection}:${period.months.join(",")}`;

  useEffect(() => {
    if (period.ready) readySnapshots.push(snapshot);
  }, [period.ready, snapshot]);

  return <output data-testid="period-state">{snapshot}</output>;
}

beforeEach(() => {
  window.sessionStorage.clear();
  selectedProfile = profileA;
  readySnapshots.length = 0;
  monthRequests = {};
  requestedBusinessIds = [];
});

describe("ReportingPeriodProvider business ownership", () => {
  it("gates readiness and hides the previous business's months during a profile switch", async () => {
    const first = deferred<{ data: { months: string[] } }>();
    const second = deferred<{ data: { months: string[] } }>();
    monthRequests[profileA.id] = [first.promise];
    monthRequests[profileB.id] = [second.promise];

    const tree = () => (
      <ReportingPeriodProvider>
        <Probe />
      </ReportingPeriodProvider>
    );
    const { rerender } = render(tree());
    expect(screen.getByTestId("period-state")).toHaveTextContent("1:false:week:");

    await act(async () => {
      first.resolve({ data: { months: ["2026-08", "2026-07"] } });
      await first.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent(
        "1:true:month:2026-08:2026-08,2026-07",
      );
    });

    readySnapshots.length = 0;
    selectedProfile = profileB;
    rerender(tree());

    expect(screen.getByTestId("period-state")).toHaveTextContent("2:false:week:");
    expect(readySnapshots).toEqual([]);

    await act(async () => {
      second.resolve({ data: { months: ["2025-12"] } });
      await second.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent(
        "2:true:month:2025-12:2025-12",
      );
    });
    expect(readySnapshots).toEqual(["2:true:month:2025-12:2025-12"]);
  });

  it("loads once on a cold mount without an immediate duplicate refresh", async () => {
    monthRequests[profileA.id] = [Promise.resolve({ data: { months: ["2026-09"] } })];

    render(
      <ReportingPeriodProvider>
        <Probe />
      </ReportingPeriodProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent("1:true:month:2026-09:2026-09");
    });
    await act(async () => Promise.resolve());
    expect(requestedBusinessIds).toEqual([profileA.id]);
  });

  it("quietly adds a newly committed historical month only for the active business", async () => {
    monthRequests[profileA.id] = [
      Promise.resolve({ data: { months: [] } }),
      Promise.resolve({ data: { months: ["2024-11"] } }),
    ];

    render(
      <ReportingPeriodProvider>
        <Probe />
      </ReportingPeriodProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent("1:true:week:");
    });

    act(() => invalidateServerState({ businessProfileId: profileB.id, tags: ["financial", "record-months"] }));
    act(() => invalidateServerState({ businessProfileId: profileA.id, tags: ["financial"] }));
    expect(requestedBusinessIds).toEqual([profileA.id]);

    act(() => invalidateServerState({ businessProfileId: profileA.id, tags: ["financial", "record-months"] }));
    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent("1:true:month:2024-11:2024-11");
    });
    expect(requestedBusinessIds).toEqual([profileA.id, profileA.id]);
  });

  it("queues one scoped mutation refresh until the cold load settles", async () => {
    const initial = deferred<{ data: { months: string[] } }>();
    const refresh = deferred<{ data: { months: string[] } }>();
    monthRequests[profileA.id] = [initial.promise, refresh.promise];

    render(
      <ReportingPeriodProvider>
        <Probe />
      </ReportingPeriodProvider>,
    );
    act(() => invalidateServerState({ businessProfileId: profileA.id, tags: ["record-months"] }));
    expect(requestedBusinessIds).toEqual([profileA.id]);

    await act(async () => {
      initial.resolve({ data: { months: ["2021-01"] } });
      await initial.promise;
    });
    await waitFor(() => expect(requestedBusinessIds).toEqual([profileA.id, profileA.id]));
    expect(screen.getByTestId("period-state")).toHaveTextContent("1:false:week:");
    expect(readySnapshots).toEqual([]);

    await act(async () => {
      refresh.resolve({ data: { months: ["2023-06"] } });
      await refresh.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent("1:true:month:2023-06:2023-06");
    });
  });

  it("treats an unscoped record-month invalidation as global", async () => {
    monthRequests[profileA.id] = [
      Promise.resolve({ data: { months: [] } }),
      Promise.resolve({ data: { months: ["2022-04"] } }),
    ];
    render(
      <ReportingPeriodProvider>
        <Probe />
      </ReportingPeriodProvider>,
    );
    await waitFor(() => expect(requestedBusinessIds).toEqual([profileA.id]));

    act(() => invalidateServerState({ tags: ["record-months"] }));

    await waitFor(() => {
      expect(screen.getByTestId("period-state")).toHaveTextContent("1:true:month:2022-04:2022-04");
    });
    expect(requestedBusinessIds).toEqual([profileA.id, profileA.id]);
  });

  it("shows an honest initial month-load error and retries", async () => {
    const initialFailure = deferred<{ data: { months: string[] } }>();
    monthRequests[profileA.id] = [
      initialFailure.promise,
      Promise.resolve({ data: { months: ["2026-09"] } }),
    ];
    render(
      <ReportingPeriodProvider>
        <PeriodFilter />
      </ReportingPeriodProvider>,
    );
    await act(async () => {
      initialFailure.reject(new Error("offline"));
      await initialFailure.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load months. Retry");
    expect(screen.getByRole("combobox", { name: "Month" })).toHaveAttribute(
      "title",
      "Couldn't load months",
    );

    act(() => screen.getByRole("button", { name: "Retry loading months" }).click());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await findMonthOption("September 2026")).toBeInTheDocument();
    expect(requestedBusinessIds).toEqual([profileA.id, profileA.id]);
  });

  it("retains known months and exposes retry when a quiet refresh fails", async () => {
    const quietFailure = deferred<{ data: { months: string[] } }>();
    monthRequests[profileA.id] = [
      Promise.resolve({ data: { months: ["2026-08"] } }),
      quietFailure.promise,
      Promise.resolve({ data: { months: ["2026-09", "2026-08"] } }),
    ];
    render(
      <ReportingPeriodProvider>
        <PeriodFilter />
      </ReportingPeriodProvider>,
    );
    expect(await findMonthOption("August 2026")).toBeInTheDocument();

    act(() => invalidateServerState({
      businessProfileId: profileA.id,
      tags: ["record-months"],
    }));
    await act(async () => {
      quietFailure.reject(new Error("offline"));
      await quietFailure.promise.catch(() => undefined);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Month list may be out of date. Retry");
    expect(await findMonthOption("August 2026")).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "Retry loading months" }).click());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await findMonthOption("September 2026")).toBeInTheDocument();
    expect(await findMonthOption("August 2026")).toBeInTheDocument();
    expect(requestedBusinessIds).toEqual([profileA.id, profileA.id, profileA.id]);
  });
});
