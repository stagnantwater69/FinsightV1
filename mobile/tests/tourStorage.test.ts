import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tour's keystore record.
 *
 * WHY IT IS WORTH A TEST: everything this module stores is a decision about
 * whether to take over someone's screen, and every failure mode is silent. A
 * corrupt value that read as "never seen it" would re-run the tour on every
 * launch; a key that ignored the user id would let one owner's Skip silence
 * the tour for the next person handed the phone; a throw from the keystore
 * (locked device, wiped keychain) would take the dashboard down with it.
 *
 * `expo-secure-store` is mocked rather than imported: it is a native module
 * with no JS-only implementation, and the point here is the behaviour AROUND
 * it — the key, the parsing, the merge, and the swallowed errors.
 */

const store = new Map<string, string>();
const state = { failReads: false, failWrites: false };

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    if (state.failReads) throw new Error("keystore unavailable");
    return store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (state.failWrites) throw new Error("keystore unavailable");
    store.set(key, value);
  },
}));

const { readTour, writeTour, saveAlwaysShowTour, saveTourProgress } = await import(
  "../src/lib/tourStorage"
);

beforeEach(() => {
  store.clear();
  state.failReads = false;
  state.failWrites = false;
});

describe("readTour / writeTour", () => {
  it("round-trips a whole record", async () => {
    await writeTour(7, { status: "in_progress", step: 4, alwaysShow: true });
    expect(await readTour(7)).toEqual({ status: "in_progress", step: 4, alwaysShow: true });
  });

  it("reads nothing stored as a tour never started", async () => {
    expect(await readTour(7)).toEqual({ status: "not_started", step: undefined, alwaysShow: undefined });
  });

  /**
   * A phone gets handed around a shop. Without the per-user key, one owner
   * skipping the tour would silence it for every account on the device — the
   * same reason lib/onboardingDraft.ts keys its draft.
   */
  it("keeps each signed-in owner's tour separate", async () => {
    await writeTour(1, { status: "skipped" });
    await writeTour(2, { status: "in_progress", step: 3 });
    expect((await readTour(1)).status).toBe("skipped");
    expect((await readTour(2)).step).toBe(3);
    expect([...store.keys()]).toEqual(["finsight.tour.1", "finsight.tour.2"]);
  });

  /** SecureStore rejects anything outside alphanumerics, ".", "-" and "_". */
  it("uses a key SecureStore will accept", async () => {
    await writeTour(42, { status: "completed" });
    expect([...store.keys()][0]).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("corrupt and hostile stored values", () => {
  it("treats unparseable JSON as a tour never started", async () => {
    store.set("finsight.tour.7", "{not json");
    expect(await readTour(7)).toEqual({ status: "not_started" });
  });

  it("treats a value of the wrong shape as a tour never started", async () => {
    for (const raw of ["null", '"skipped"', "[1,2,3]", "12"]) {
      store.set("finsight.tour.7", raw);
      expect((await readTour(7)).status, raw).toBe("not_started");
    }
  });

  /**
   * An unrecognised status must not be trusted in EITHER direction: treating
   * it as terminal would hide the tour forever, so it reads as not_started —
   * and the start gate still requires a loaded dashboard, so the worst case is
   * one extra offer.
   */
  it("falls back to not_started for an unknown status", async () => {
    store.set("finsight.tour.7", JSON.stringify({ status: "paused", step: 2 }));
    const stored = await readTour(7);
    expect(stored.status).toBe("not_started");
    expect(stored.step).toBe(2);
  });

  it("discards a step that is not a usable index", async () => {
    for (const step of ["3", -1, Number.NaN, null, {}]) {
      store.set("finsight.tour.7", JSON.stringify({ status: "in_progress", step }));
      expect((await readTour(7)).step, JSON.stringify(step)).toBeUndefined();
    }
  });

  /**
   * Only a real `true` pins the tour open on every launch. A truthy leftover
   * of some other shape must not, because the consequence is the tour running
   * every single time the owner signs in and no obvious way to see why.
   */
  it("only accepts a literal true for alwaysShow", async () => {
    for (const alwaysShow of ["true", 1, {}, "yes"]) {
      store.set("finsight.tour.7", JSON.stringify({ status: "completed", alwaysShow }));
      expect((await readTour(7)).alwaysShow, JSON.stringify(alwaysShow)).toBeUndefined();
    }
    store.set("finsight.tour.7", JSON.stringify({ status: "completed", alwaysShow: true }));
    expect((await readTour(7)).alwaysShow).toBe(true);
  });
});

describe("keystore failures", () => {
  it("reads as a tour never started when the keystore cannot be read", async () => {
    state.failReads = true;
    expect(await readTour(7)).toEqual({ status: "not_started" });
  });

  it("swallows a failed write rather than throwing into the screen", async () => {
    state.failWrites = true;
    await expect(writeTour(7, { status: "completed" })).resolves.toBeUndefined();
    await expect(saveAlwaysShowTour(7, true)).resolves.toBeUndefined();
    await expect(saveTourProgress(7, "in_progress", 2)).resolves.toBeUndefined();
  });
});

/**
 * Progress and the preference are written from two different places — the
 * overlay advancing a step, and the toggle on the More screen. A plain write
 * from either would drop what the other had just stored, which is exactly how
 * "always show on login" would appear to switch itself back off after a tour.
 */
describe("partial writes", () => {
  it("keeps the preference when progress is saved", async () => {
    await saveAlwaysShowTour(3, true);
    await saveTourProgress(3, "in_progress", 5);
    expect(await readTour(3)).toEqual({ status: "in_progress", step: 5, alwaysShow: true });
  });

  it("keeps the progress when the preference is changed", async () => {
    await saveTourProgress(3, "in_progress", 5);
    await saveAlwaysShowTour(3, true);
    expect(await readTour(3)).toEqual({ status: "in_progress", step: 5, alwaysShow: true });
  });

  it("clears the preference when it is switched off", async () => {
    await saveAlwaysShowTour(3, true);
    await saveAlwaysShowTour(3, false);
    expect((await readTour(3)).alwaysShow).toBeUndefined();
  });

  it("records how a run ended", async () => {
    await saveTourProgress(3, "completed", 9);
    expect(await readTour(3)).toMatchObject({ status: "completed", step: 9 });
  });
});
