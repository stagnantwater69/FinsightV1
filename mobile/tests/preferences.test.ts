import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, commitPreferences, mergePreferences } from "../src/lib/preferences";
import type { UserPreferences } from "../src/lib/types";

/**
 * Account preferences, and what happens when the account cannot be told.
 *
 * WHY THIS IS WORTH A TEST: every setting on the Settings screen saves on the
 * tap, with no Save button and no confirmation. That is the right shape for a
 * phone, and it makes exactly one failure mode dangerous — a switch that moved
 * under the finger, stayed moved, and never reached the server. The owner has
 * no way to tell, and the setting silently means one thing on this phone and
 * another on every other device. So the rollback is pinned here rather than
 * left to a screen this project has no harness to render.
 */

const SERVER: UserPreferences = {
  showDashboardMascotMessage: false,
  tourStatus: "completed",
  tourStep: 9,
  tourAlwaysShow: false,
};

describe("default preferences", () => {
  /**
   * ON, and this is not a cosmetic default. It is what an account reads as
   * while /auth/me is still in flight, so anything else would blank the top of
   * Home for a beat on every cold start.
   */
  it("shows the daily mascot message until told otherwise", () => {
    expect(DEFAULT_PREFERENCES.showDashboardMascotMessage).toBe(true);
  });

  /**
   * Null rather than "not_started"/0 — the migrate-up in lib/tourStorage.ts
   * exists only because those two are different answers.
   */
  it("leaves the tour unknown rather than guessing it was never started", () => {
    expect(DEFAULT_PREFERENCES.tourStatus).toBeNull();
    expect(DEFAULT_PREFERENCES.tourStep).toBeNull();
  });
});

describe("mergePreferences", () => {
  it("lays a partial change over what is already believed", () => {
    expect(mergePreferences(SERVER, { showDashboardMascotMessage: true })).toEqual({
      ...SERVER,
      showDashboardMascotMessage: true,
    });
  });

  it("reads a not-yet-loaded account as the defaults", () => {
    expect(mergePreferences(null, { tourAlwaysShow: true })).toEqual({
      ...DEFAULT_PREFERENCES,
      tourAlwaysShow: true,
    });
  });
});

describe("commitPreferences", () => {
  it("moves the switch before the request, then adopts the server's answer", async () => {
    const seen: (UserPreferences | null)[] = [];
    const send = vi.fn(async () => ({ ...SERVER, showDashboardMascotMessage: true, tourStep: 10 }));

    await commitPreferences({
      current: SERVER,
      patch: { showDashboardMascotMessage: true },
      apply: (next) => seen.push(next),
      send,
    });

    // Optimistic first — the switch does not wait for the network.
    expect(seen[0]).toEqual({ ...SERVER, showDashboardMascotMessage: true });
    // ...and then the whole object the server returned, which is how a field
    // another device changed comes down instead of being re-asserted stale.
    expect(seen[1]).toEqual({ ...SERVER, showDashboardMascotMessage: true, tourStep: 10 });
    expect(seen).toHaveLength(2);
  });

  /**
   * PARTIAL, not a whole-object write. The tour writes its three fields from
   * the overlay while Settings writes the mascot flag from a row; a
   * whole-object send from either would carry the other's stale value up.
   */
  it("sends only the fields that changed", async () => {
    const send = vi.fn(async () => SERVER);
    await commitPreferences({
      current: SERVER,
      patch: { tourAlwaysShow: true },
      apply: () => undefined,
      send,
    });
    expect(send).toHaveBeenCalledWith({ tourAlwaysShow: true });
  });

  it("puts the previous value back and rethrows when the account refuses it", async () => {
    const seen: (UserPreferences | null)[] = [];
    const failure = new Error("Network request failed");

    await expect(
      commitPreferences({
        current: SERVER,
        patch: { showDashboardMascotMessage: true },
        apply: (next) => seen.push(next),
        send: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(seen[0]).toEqual({ ...SERVER, showDashboardMascotMessage: true });
    // Back exactly where it was, object for object — not "the defaults with
    // this one field flipped back", which would quietly reset the tour too.
    expect(seen[seen.length - 1]).toEqual(SERVER);
  });

  it("rolls back to not-loaded when nothing had arrived yet", async () => {
    const seen: (UserPreferences | null)[] = [];
    await expect(
      commitPreferences({
        current: null,
        patch: { showDashboardMascotMessage: false },
        apply: (next) => seen.push(next),
        send: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(seen[seen.length - 1]).toBeNull();
  });
});
