import { describe, expect, it, vi } from "vitest";
import type { StoredTour } from "../src/lib/tourStorage";
import type { UserPreferences } from "../src/lib/types";

/*
 * Mocked only so the module can be imported at all: lib/tourStorage.ts pulls
 * in expo-secure-store for its cache half, and that is a native module with no
 * JS implementation. Nothing below touches the keystore — these three
 * functions are pure. The cache itself is covered in tourStorage.test.ts.
 */
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
}));

const { fromPreferences, preferencePatch, reconcile } = await import("../src/lib/tourStorage");

/**
 * Moving the tour's memory from this phone onto the account.
 *
 * THIS IS THE HIGHEST-RISK PART OF THAT MOVE, and every failure of it is
 * silent. Tour state used to live only in the keystore. It now lives on the
 * user row, and the keystore is a cache — so on the first run of the new build
 * there are two answers about whether an owner has seen the tour, and picking
 * the wrong one either throws a ten-step tour over the Home screen of someone
 * who finished it last month, or hides it forever from someone who never has.
 *
 * The rule is one function, tested here rather than inside a provider this
 * project cannot render.
 */

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  showDashboardMascotMessage: true,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
  ...over,
});

describe("reconcile", () => {
  /**
   * `tourStatus === null` is the server saying it has never been told anything
   * about this account — which is the state EVERY existing account is in the
   * first time it runs a build that knows about these columns, including the
   * accounts of owners who completed the tour long ago. Reading that null as
   * "not_started" would re-offer the tour to all of them.
   */
  it("pushes local state up when the server has never been told", () => {
    const local: StoredTour = { status: "completed", step: 9, alwaysShow: true };
    const { tour, push } = reconcile(local, prefs({ tourStatus: null }));

    expect(tour).toEqual(local);
    expect(push).toEqual({ tourStatus: "completed", tourStep: 9, tourAlwaysShow: true });
  });

  it("pushes a genuinely new owner up as not_started rather than skipping the migration", () => {
    const { tour, push } = reconcile({ status: "not_started" }, prefs({ tourStatus: null }));
    expect(tour.status).toBe("not_started");
    // The push is what stops this running again on the next sign-in: after it
    // the row holds a real status, and the branch below takes over.
    expect(push).toEqual({ tourStatus: "not_started", tourStep: 0, tourAlwaysShow: false });
  });

  /**
   * A REAL STATUS WINS, and nothing goes up. The account's answer may have
   * been written by the laptop this morning; this phone's cache may be from
   * before the owner ever signed in on it.
   */
  it("adopts the server's answer and sends nothing when the account already knows", () => {
    const { tour, push } = reconcile(
      { status: "not_started" },
      prefs({ tourStatus: "completed", tourStep: 9, tourAlwaysShow: false }),
    );
    expect(tour).toEqual({ status: "completed", step: 9, alwaysShow: undefined });
    expect(push).toBeNull();
  });

  it("does not let a stale local completion bury an in-progress run from another device", () => {
    const { tour, push } = reconcile(
      { status: "completed", step: 9 },
      prefs({ tourStatus: "in_progress", tourStep: 3 }),
    );
    expect(tour).toEqual({ status: "in_progress", step: 3, alwaysShow: undefined });
    expect(push).toBeNull();
  });

  it("carries the replay preference down with the rest", () => {
    const { tour } = reconcile({ status: "not_started" }, prefs({ tourStatus: "skipped", tourAlwaysShow: true }));
    expect(tour.alwaysShow).toBe(true);
  });
});

describe("preferencePatch", () => {
  it("sends all three tour fields, so a partial write cannot leave two of them stale", () => {
    expect(preferencePatch({ status: "in_progress", step: 2 })).toEqual({
      tourStatus: "in_progress",
      tourStep: 2,
      tourAlwaysShow: false,
    });
  });

  /**
   * Clamped rather than trusted. A corrupt cache entry reaching the API as a
   * negative or absurd step would come back a 400 — and a 400 here loses the
   * whole migration, which is the one write that cannot simply be retried
   * later.
   */
  it("clamps a step the API would reject", () => {
    expect(preferencePatch({ status: "in_progress", step: -4 }).tourStep).toBe(0);
    expect(preferencePatch({ status: "in_progress", step: 5000 }).tourStep).toBe(100);
    expect(preferencePatch({ status: "completed" }).tourStep).toBe(0);
  });
});

describe("fromPreferences", () => {
  it("reads a never-recorded status as a tour never started", () => {
    expect(fromPreferences(prefs())).toEqual({ status: "not_started", step: undefined, alwaysShow: undefined });
  });

  it("ignores a nonsense step rather than resuming past the end", () => {
    expect(fromPreferences(prefs({ tourStatus: "in_progress", tourStep: -1 })).step).toBeUndefined();
  });
});
