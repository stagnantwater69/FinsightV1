// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fromPreferences, preferencePatch, readTour, reconcile, setAlwaysShowTour, writeTour } from "./tourStorage";
import type { UserPreferences } from "./types";

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  showDashboardMascotMessage: true,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
  ...over,
});

describe("tourStorage", () => {
  beforeEach(() => window.localStorage.clear());

  it("reads not_started when nothing is stored", () => {
    expect(readTour(7)).toEqual({ status: "not_started", alwaysShow: false });
  });

  it("round-trips status and step", () => {
    writeTour(7, { status: "in_progress", step: 4 });
    expect(readTour(7)).toEqual({ status: "in_progress", step: 4, alwaysShow: false });
  });

  it("keys by user id, so accounts on a shared machine don't collide", () => {
    writeTour(1, { status: "completed" });
    writeTour(2, { status: "skipped" });
    expect(readTour(1).status).toBe("completed");
    expect(readTour(2).status).toBe("skipped");
    expect(readTour(3).status).toBe("not_started");
  });

  it("treats corrupt or foreign data as not_started rather than throwing", () => {
    window.localStorage.setItem("finsight.tour.7", "{not json");
    expect(readTour(7)).toEqual({ status: "not_started", alwaysShow: false });

    window.localStorage.setItem("finsight.tour.7", JSON.stringify({ status: "yes please" }));
    expect(readTour(7)).toEqual({ status: "not_started", alwaysShow: false });

    window.localStorage.setItem("finsight.tour.7", JSON.stringify({ status: "completed", step: -2 }));
    expect(readTour(7)).toEqual({ status: "completed", step: undefined, alwaysShow: false });
  });

  describe("the always-show preference", () => {
    it("defaults to off, and only a literal true turns it on", () => {
      expect(readTour(7).alwaysShow).toBe(false);
      window.localStorage.setItem("finsight.tour.7", JSON.stringify({ status: "completed", alwaysShow: "yes" }));
      expect(readTour(7).alwaysShow).toBe(false);
    });

    it("survives being switched on and off", () => {
      setAlwaysShowTour(7, true);
      expect(readTour(7).alwaysShow).toBe(true);
      setAlwaysShowTour(7, false);
      expect(readTour(7).alwaysShow).toBe(false);
    });

    it("does not disturb progress when toggled mid-tour", () => {
      // The settings screen knows nothing about which step the tour reached;
      // writing the whole object from there would silently restart it.
      writeTour(7, { status: "in_progress", step: 6 });
      setAlwaysShowTour(7, true);
      expect(readTour(7)).toEqual({ status: "in_progress", step: 6, alwaysShow: true });
    });

    it("is kept per user, like every other tour value", () => {
      setAlwaysShowTour(1, true);
      expect(readTour(1).alwaysShow).toBe(true);
      expect(readTour(2).alwaysShow).toBe(false);
    });

    it("survives finishing the tour, so a demo setting is not silently undone", () => {
      setAlwaysShowTour(7, true);
      // What TourContext.stop writes.
      writeTour(7, { status: "completed", step: 9, alwaysShow: readTour(7).alwaysShow });
      expect(readTour(7)).toEqual({ status: "completed", step: 9, alwaysShow: true });
    });
  });
});

/**
 * The pure half of the server move. The provider-level wiring is asserted in
 * context/TourContext.migration.test.tsx; this pins the decision itself, which
 * is the part that must not be "fixed" by someone reading a null status as a
 * fresh start.
 */
describe("reconciling with the account", () => {
  it("adopts local state and pushes it up when the server has never been told", () => {
    const local = { status: "completed" as const, step: 9, alwaysShow: true };
    expect(reconcile(local, prefs({ tourStatus: null }))).toEqual({
      tour: local,
      push: { tourStatus: "completed", tourStep: 9, tourAlwaysShow: true },
    });
  });

  it("takes the server's answer, and pushes nothing, once it has one", () => {
    expect(
      reconcile(
        { status: "in_progress", step: 3, alwaysShow: false },
        prefs({ tourStatus: "completed", tourStep: 9, tourAlwaysShow: true }),
      ),
    ).toEqual({
      tour: { status: "completed", step: 9, alwaysShow: true },
      push: null,
    });
  });

  it("reads a null step as no saved progress rather than step zero", () => {
    expect(fromPreferences(prefs({ tourStatus: "completed", tourStep: null }))).toEqual({
      status: "completed",
      step: undefined,
      alwaysShow: false,
    });
  });

  it("clamps the step it sends into the range the API accepts", () => {
    // A corrupt cache entry must not turn into a 400 that loses the whole
    // migration; MAX_TOUR_STEP is 100 on the server.
    expect(preferencePatch({ status: "in_progress", step: 5000 }).tourStep).toBe(100);
    expect(preferencePatch({ status: "not_started" }).tourStep).toBe(0);
  });
});
