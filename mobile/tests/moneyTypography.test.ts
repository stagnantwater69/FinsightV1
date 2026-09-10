import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Currency figures must align in a column on BOTH platforms.
 *
 * THE REGRESSION THIS PINS. `Money` was switched from the IBM Plex Mono faces
 * to Inter while keeping `fontVariant: ["tabular-nums"]`. In React Native 0.86
 * `fontVariant` is declared on `TextStyleIOS` only
 * (node_modules/react-native/Libraries/StyleSheet/StyleSheetTypes.d.ts) — it
 * does nothing on Android, so every currency column in the app (the Records
 * list, the dashboard tiles, the daily-coverage rows) quietly went to
 * proportional digits there while still looking correct on an iPhone and in
 * review.
 *
 * Checked by reading the source: there is no render harness on mobile, and
 * components/ui.tsx imports react-native, which this runner cannot load. Same
 * approach as uploadTransport.test.ts.
 */

const UI = readFileSync(join(__dirname, "..", "src", "components", "ui.tsx"), "utf8");
const RN_TYPES = join(__dirname, "..", "node_modules", "react-native", "Libraries", "StyleSheet", "StyleSheetTypes.d.ts");

/** Just the body of the Money component. */
function moneyBody(): string {
  const start = UI.indexOf("export function Money(");
  expect(start, "components/ui.tsx no longer defines Money").toBeGreaterThan(-1);
  const end = UI.indexOf("\nexport function ", start + 1);
  return UI.slice(start, end === -1 ? undefined : end);
}

describe("Money", () => {
  it("renders every weight in a fixed-advance face", () => {
    const body = moneyBody();
    expect(body).toContain("font.monoSemibold");
    expect(body).toContain("font.monoMedium");
    expect(body).toMatch(/:\s*font\.mono\b/);
  });

  /** The specific swap that broke Android alignment. */
  it("never falls back to the proportional sans faces for an amount", () => {
    expect(moneyBody()).not.toMatch(/font\.sans/);
  });

  /**
   * `fontVariant` may stay — it is the belt to the face's braces on iOS — but
   * alignment must not DEPEND on it, which is what the mono face guarantees.
   */
  it("does not rely on fontVariant, which is iOS-only in this React Native", () => {
    const declaration = readFileSync(RN_TYPES, "utf8");
    const iosOnly = declaration.slice(declaration.indexOf("interface TextStyleIOS"));
    expect(iosOnly.slice(0, iosOnly.indexOf("interface TextStyleAndroid"))).toContain("fontVariant");
  });
});
