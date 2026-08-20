// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readTour, setAlwaysShowTour, writeTour } from "./tourStorage";

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
