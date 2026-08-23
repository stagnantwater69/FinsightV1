import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The appearance preference: what it stores, and what it paints.
 *
 * WHY IT IS WORTH A TEST. Nothing else in this project can check a theme —
 * there is no render harness, so "the app turns dark" is a physical-device
 * observation. What CAN be pinned is the pair of facts the switch depends on:
 * that a chosen mode survives the app being closed (it is read back out of the
 * keystore on the next cold start), and that the two modes actually resolve to
 * different colours. A round trip that silently returns the default would
 * leave an owner re-picking Dark every morning with nothing on screen to say
 * why.
 *
 * `expo-secure-store` is mocked for the reason tourStorage.test.ts gives: it
 * is a native module with no JS implementation, and the behaviour under test
 * is the one around it.
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

const { DEFAULT_THEME, readThemeMode, writeThemeMode } = await import("../src/lib/themeStore");
const { palettes } = await import("../src/theme/palette");

beforeEach(() => {
  store.clear();
  state.failReads = false;
  state.failWrites = false;
});

describe("the appearance preference", () => {
  it("reads back whichever theme was chosen", async () => {
    await writeThemeMode("dark");
    expect(await readThemeMode()).toBe("dark");
    await writeThemeMode("light");
    expect(await readThemeMode()).toBe("light");
  });

  /**
   * Light, not the OS setting. There is no system/auto option, so "what did I
   * pick" has exactly one answer — and an existing owner must not be handed a
   * silent redesign on upgrade.
   */
  it("starts Light for a device that has never chosen", async () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(await readThemeMode()).toBe("light");
  });

  /**
   * NOT KEYED BY USER, unlike the tour. Appearance is a property of the screen
   * being looked at, and it has to be readable before anyone has signed in —
   * the login screen is the first thing a cold start paints.
   */
  it("stores one appearance for the device, under a key with no user in it", async () => {
    await writeThemeMode("dark");
    expect([...store.keys()]).toEqual(["finsight.appearance"]);
  });

  it("reads an unrecognised stored value as never chosen", async () => {
    store.set("finsight.appearance", "solarized");
    expect(await readThemeMode()).toBe("light");
  });

  it("survives a keystore that refuses to answer", async () => {
    state.failReads = true;
    await expect(readThemeMode()).resolves.toBe("light");
    state.failWrites = true;
    await expect(writeThemeMode("dark")).resolves.toBeUndefined();
  });
});

describe("the two palettes", () => {
  /**
   * A theme that stores fine and paints identically is the same bug as one
   * that does not store at all — and it is the one a source-level check would
   * miss. Page background and body ink are the two an owner sees first.
   */
  it("actually resolve to different colours", () => {
    expect(palettes.light.paper.DEFAULT).not.toBe(palettes.dark.paper.DEFAULT);
    expect(palettes.light.ink[900]).not.toBe(palettes.dark.ink[900]);
  });

  it("cover both modes and only those two", () => {
    expect(Object.keys(palettes).sort()).toEqual(["dark", "light"]);
  });
});

/**
 * The wiring between the two, which is all a source read can honestly claim.
 *
 * The Settings screen taking `setMode` from the shared control is what makes
 * the choice apply immediately AND persist — ThemeContext does both in one
 * call. A screen that kept its own `useState` would look right until the app
 * was closed. HOW IT LOOKS on a device is not covered here or anywhere.
 */
const SETTINGS = join(__dirname, "..", "src", "screens", "SettingsScreen.tsx");

describe("the Appearance control", () => {
  it("drives the app-wide theme rather than a copy of it", () => {
    const src = readFileSync(SETTINGS, "utf8");
    expect(src).toContain("useThemeControl");
    expect(src).toContain("onChange={setMode}");
  });

  it("offers Light and Dark, and nothing else", () => {
    const src = readFileSync(SETTINGS, "utf8");
    const values = [...src.matchAll(/value: "(light|dark|system|auto)"/g)].map((m) => m[1]);
    expect(values.sort()).toEqual(["dark", "light"]);
  });
});
