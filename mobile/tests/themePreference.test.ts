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

const {
  DEFAULT_THEME,
  DEFAULT_THEME_PREFERENCE,
  readThemeMode,
  readThemePreference,
  writeThemeMode,
  writeThemePreference,
} = await import("../src/lib/themeStore");
const { palettes, resolveThemeMode } = await import("../src/theme/palette");

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
   * Light, not the OS setting, EVEN NOW THAT "Use device setting" EXISTS.
   * Nothing in the keystore distinguishes a fresh install from an owner who
   * has been running the Light app since before the third option shipped, so
   * defaulting to the OS would hand that second group a silent redesign on
   * upgrade.
   */
  it("starts Light for a device that has never chosen", async () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(DEFAULT_THEME_PREFERENCE).toBe("light");
    expect(await readThemeMode()).toBe("light");
    expect(await readThemePreference()).toBe("light");
  });

  /**
   * THE MIGRATION, which has to be a no-op and is worth pinning as one.
   *
   * "light" and "dark" are the only values that were ever written under this
   * key, both are still legal preferences meaning exactly what they meant, and
   * the third option shares the same key rather than adding a second one — so
   * an owner who chose Dark before the upgrade still has Dark after it, with
   * no read-then-rewrite step that could half-fail.
   */
  it("reads a preference stored by the two-option build back unchanged", async () => {
    store.set("finsight.appearance", "dark");
    expect(await readThemePreference()).toBe("dark");
    store.set("finsight.appearance", "light");
    expect(await readThemePreference()).toBe("light");
  });

  it("round-trips the device-setting option", async () => {
    await writeThemePreference("system");
    expect(await readThemePreference()).toBe("system");
    // Written under the same key, not a second one beside it.
    expect([...store.keys()]).toEqual(["finsight.appearance"]);
  });

  /**
   * `readThemeMode` cannot see the device's scheme, so it answers with the
   * plain default rather than guessing. The app does not take this path —
   * ThemeContext resolves "system" against `Appearance` — but a caller that
   * only understands two palettes must still get one of the two.
   */
  it("narrows a stored device-setting choice to a real palette for mode readers", async () => {
    await writeThemePreference("system");
    expect(await readThemeMode()).toBe("light");
    // …without overwriting what the owner actually chose.
    expect(await readThemePreference()).toBe("system");
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
    expect(src).toContain("onChange={setPreference}");
  });

  it("offers Light, Dark and the device setting, and nothing else", () => {
    const src = readFileSync(SETTINGS, "utf8");
    const values = [...src.matchAll(/value: "(light|dark|system|auto)"/g)].map((m) => m[1]);
    expect(values.sort()).toEqual(["dark", "light", "system"]);
  });

  /**
   * The bug this exists to prevent: binding the chips to the RESOLVED mode.
   * With the device setting chosen, `mode` is Light or Dark, so the control
   * would show one of those selected and the owner's actual answer would
   * vanish the first time they opened Settings.
   */
  it("shows what the owner chose, not what is currently painted", () => {
    const src = readFileSync(SETTINGS, "utf8");
    expect(src).toContain("value={preference}");
    expect(src).not.toContain("value={mode}");
  });
});

/**
 * The resolution rule itself. Two palettes, three answers — this is the
 * function that keeps the third one from needing a third palette.
 */
describe("resolving a preference against the device", () => {
  it("defers to the device only for the device setting", () => {
    expect(resolveThemeMode("system", "dark")).toBe("dark");
    expect(resolveThemeMode("system", "light")).toBe("light");
  });

  it("ignores the device when the owner picked a side", () => {
    expect(resolveThemeMode("light", "dark")).toBe("light");
    expect(resolveThemeMode("dark", "light")).toBe("dark");
  });
});
