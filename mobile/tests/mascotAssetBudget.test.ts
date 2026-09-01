import { readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * The mascot art stays inside a size budget.
 *
 * WHY THIS EXISTS. `mascotAssets.test.ts` proves every state points at a file
 * that is on disk; it says nothing about how big that file is. The poses were
 * originally shipped at ~1254x1254 and 1.0–1.9 MB each while rendering at
 * 64–104pt. On a device the file size is the smaller half of the problem: a
 * 1254x1254 PNG decodes to a ~6.3 MB ARGB_8888 bitmap, and several of those
 * alive at once is an out-of-memory risk on a low-end Android phone. At 512
 * the same bitmap is ~1.0 MB.
 *
 * WHY 512 IS THE CEILING. The largest `<Mascot size={…}>` in the app is 104pt.
 * At a 3x device pixel ratio that asks for ~312px, so 512 leaves headroom for
 * a bigger placement or a 4x screen (416px) without paying for pixels nobody
 * can see. Raising this number needs a render size that justifies it, not a
 * nicer-looking source export.
 *
 * WHAT THIS CANNOT COVER, and nothing else here does either: whether the
 * downscaled art still reads at 64pt, whether it looks right on a dark screen,
 * and actual memory on real hardware. Those are device checks.
 */

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const COMPONENTS = join(SRC, "components");

/** Longest side, in pixels, for any mascot pose that ships in the bundle. */
const MAX_EDGE = 512;
/** Per-file ceiling. The heaviest pose today is ~316 KB; this is headroom, not a target. */
const MAX_BYTES = 400 * 1024;
/** Everything the two tables pull in, together. Today's total is ~6.4 MB. */
const MAX_TOTAL_BYTES = 9 * 1024 * 1024;

/**
 * Deliberately outside the budget, with a reason.
 *
 * `finsightlogo.png` is not just the `brandMark` pose — `assets/README.md`
 * records it as the single source the launch icons, the adaptive foreground
 * and the splash art are all derived from, and those derivatives are cut at
 * 1024 and kept unquantised on purpose. Shrinking it here would quietly
 * degrade every native resource in the app. Giving the mapper its own smaller
 * copy is a reasonable follow-up; it is a change to `MascotState.tsx`, not to
 * this file's threshold.
 */
const EXEMPT = new Set(["assets/mascot/finsightlogo.png"]);

/**
 * Every `require("…/assets/mascot/…png")` in the two files allowed to hold one.
 *
 * Scoped to `assets/mascot/` on purpose. `TourMascot` also requires
 * `assets/greeting.png`, which belongs to the greeting sequence and its own
 * provenance note in `assets/README.md` — it is not this budget's to police.
 */
function referencedAssets(): string[] {
  const files = [join(COMPONENTS, "MascotState.tsx"), join(COMPONENTS, "tour", "TourMascot.tsx")];
  const found = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/require\("([^"]*assets\/mascot\/[^"]+\.png)"\)/g)) {
      // Normalised to a repo-relative path so the two files' differing depths
      // of `../` collapse to the same key.
      const abs = join(file, "..", m[1]!);
      found.add(abs.slice(ROOT.length + 1).replace(/\\/g, "/"));
    }
  }
  return [...found].sort();
}

/**
 * Width and height straight off the PNG header.
 *
 * No image library is a dependency of this project and none should become one
 * for a test. A PNG's IHDR is fixed-layout: 8-byte signature, 4-byte length,
 * 4-byte type, then width and height as big-endian uint32.
 */
function pngSize(abs: string): { width: number; height: number } {
  const buf = readFileSync(abs);
  const signature = buf.subarray(0, 8).toString("hex");
  expect(signature, `${abs} is not a PNG`).toBe("89504e470d0a1a0a");
  expect(buf.subarray(12, 16).toString("ascii"), `${abs} has no leading IHDR`).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const budgeted = referencedAssets().filter((rel) => !EXEMPT.has(rel));

describe("the mascot art budget", () => {
  it("finds the referenced art at all", () => {
    // Guards every assertion below from passing vacuously if the tables move
    // or the require spelling changes.
    expect(referencedAssets().length).toBeGreaterThanOrEqual(25);
    expect(budgeted.length).toBeGreaterThanOrEqual(24);
  });

  it("keeps every bundled pose within 512px on its longest side", () => {
    const oversized = budgeted
      .map((rel) => ({ rel, ...pngSize(join(ROOT, rel)) }))
      .filter(({ width, height }) => Math.max(width, height) > MAX_EDGE)
      .map(({ rel, width, height }) => `${rel} is ${width}x${height}`);
    expect(
      oversized,
      `Mascot art above ${MAX_EDGE}px. Downscale it (preserve the aspect ratio) rather than raising the ceiling.`,
    ).toEqual([]);
  });

  it("keeps every bundled pose under the per-file ceiling", () => {
    const heavy = budgeted
      .map((rel) => ({ rel, bytes: statSync(join(ROOT, rel)).size }))
      .filter(({ bytes }) => bytes > MAX_BYTES)
      .map(({ rel, bytes }) => `${rel} is ${Math.round(bytes / 1024)} KB`);
    expect(heavy, `Mascot art above ${MAX_BYTES / 1024} KB.`).toEqual([]);
  });

  it("keeps the referenced art under the collective ceiling", () => {
    const total = referencedAssets().reduce((sum, rel) => sum + statSync(join(ROOT, rel)).size, 0);
    expect(
      total,
      `Referenced mascot art totals ${(total / 1024 / 1024).toFixed(2)} MB.`,
    ).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  /**
   * The plate mitigation in `MascotState.tsx` assumes the art is opaque, so a
   * pose that suddenly carries alpha is not a bug — it is the re-export this
   * folder is waiting for, and it means `plate={false}` becomes available for
   * that pose. Failing here is how that news reaches somebody instead of
   * shipping as a pose framed on a plate it no longer needs.
   */
  it("notices if a pose is re-exported with a real alpha channel", () => {
    const withAlpha = budgeted.filter((rel) => {
      const buf = readFileSync(join(ROOT, rel));
      // IHDR colour type is the byte after the 8-bit depth, at offset 25.
      // 4 = greyscale+alpha, 6 = truecolour+alpha.
      const colourType = buf.readUInt8(25);
      return colourType === 4 || colourType === 6;
    });
    expect(
      withAlpha,
      "A pose now has an alpha channel. If it is genuinely cut out, pass plate={false} where it is used, " +
        "update assets/mascot/README.md, and move it into this test's allowance.",
    ).toEqual([]);
  });

  /**
   * The exemption is a named decision, not a hole to grow. If the mapper stops
   * pointing at the badge this row is dead and should be deleted with it.
   */
  it("still uses the one asset it exempts", () => {
    expect(referencedAssets()).toContain("assets/mascot/finsightlogo.png");
  });
});
