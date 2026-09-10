import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  CROP_RETRY_MESSAGE,
  CROP_WINDING_EPSILON,
  MIN_CROP_AREA_PX,
  MIN_CROP_EDGE_PX,
  cropQuadHint,
  cropQuadIssue,
  cropQuadProblem,
  transformFailureMessage,
} from "../src/lib/cropQuad";
import type { Corners } from "../src/lib/receiptCapture";

/**
 * The local mirror of the server's crop-quad rule.
 *
 * WHAT THIS CAN AND CANNOT SHOW. It checks the geometry, which is the only
 * part of the crop flow reachable from vitest: there is no render harness on
 * mobile, so CropEditor's drag handling, the disabled Apply action and the
 * hint actually appearing on screen still need a physical device.
 *
 * The rule being mirrored is `validatePerspectiveCorners` in
 * backend/src/lib/receiptPerspective.ts (owned by backend-api, read-only from
 * here). The direction that matters most is the one this suite states
 * explicitly: the client must never reject a quad the server would ACCEPT,
 * because that is an Apply button refusing work the backend was happy to do.
 */

const quad = (
  tl: [number, number],
  tr: [number, number],
  br: [number, number],
  bl: [number, number],
): Corners => ({
  topLeft: { x: tl[0], y: tl[1] },
  topRight: { x: tr[0], y: tr[1] },
  bottomRight: { x: br[0], y: br[1] },
  bottomLeft: { x: bl[0], y: bl[1] },
});

/**
 * The server's check, transcribed. Kept independent of the implementation so
 * the two can be compared rather than one asserting about itself.
 */
function serverAccepts(corners: Corners, width: number, height: number): boolean {
  const points = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > width || p.y > height)) return false;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i]!, b = points[(i + 1) % 4]!, c = points[(i + 2) % 4]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 1e-6 || Math.hypot(b.x - a.x, b.y - a.y) < 8) return false;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2 >= 64;
}

describe("the local crop-quad check", () => {
  it("accepts an ordinary rectangle", () => {
    expect(cropQuadProblem(quad([10, 10], [400, 10], [400, 900], [10, 900]), 500, 1000)).toBeNull();
  });

  it("accepts the full frame and a perspective-skewed receipt", () => {
    expect(cropQuadProblem(quad([0, 0], [500, 0], [500, 1000], [0, 1000]), 500, 1000)).toBeNull();
    expect(cropQuadProblem(quad([40, 20], [460, 60], [430, 950], [70, 890]), 500, 1000)).toBeNull();
  });

  it("rejects a corner dragged outside the photo", () => {
    expect(cropQuadProblem(quad([-1, 10], [400, 10], [400, 900], [10, 900]), 500, 1000)).toBe("outside-image");
    expect(cropQuadProblem(quad([10, 10], [501, 10], [400, 900], [10, 900]), 500, 1000)).toBe("outside-image");
  });

  /** THE DEFECT: a handle dragged past its neighbour, which used to upload. */
  it("rejects a self-crossing quad (top corners swapped)", () => {
    expect(cropQuadProblem(quad([400, 10], [10, 10], [400, 900], [10, 900]), 500, 1000)).toBe("not-convex");
  });

  it("rejects a concave quad", () => {
    expect(cropQuadProblem(quad([10, 10], [400, 10], [200, 400], [10, 900]), 500, 1000)).toBe("not-convex");
  });

  /** Anticlockwise: the same four points, valid as a shape, wound the wrong way. */
  it("rejects an anticlockwise quad, as the server does", () => {
    const corners = quad([10, 900], [400, 900], [400, 10], [10, 10]);
    expect(cropQuadProblem(corners, 500, 1000)).toBe("not-convex");
    expect(serverAccepts(corners, 500, 1000)).toBe(false);
  });

  it("rejects two corners sitting on top of each other", () => {
    expect(cropQuadProblem(quad([10, 10], [14, 10], [400, 900], [10, 900]), 500, 1000)).toBe("edge-too-short");
  });

  it("rejects a selection enclosing almost nothing", () => {
    // A flat sliver: every edge clears 8px, the 20px² it encloses does not
    // clear 64px². This is the only way to fail the area rule alone.
    expect(cropQuadProblem(quad([10, 10], [30, 10], [40, 11], [20, 11]), 500, 1000)).toBe("area-too-small");
  });

  it("treats a degenerate image size as unusable rather than throwing", () => {
    expect(cropQuadProblem(quad([0, 0], [1, 0], [1, 1], [0, 1]), 0, 0)).toBe("outside-image");
    expect(cropQuadProblem(quad([0, 0], [10, 0], [10, 10], [0, 10]), Number.NaN, 100)).toBe("outside-image");
  });

  it("carries the server's own thresholds, not approximations of them", () => {
    const server = readFileSync(join(__dirname, "..", "..", "backend", "src", "lib", "receiptPerspective.ts"), "utf8");
    const rule = server.slice(server.indexOf("export function validatePerspectiveCorners"));
    expect(rule).toContain(`< ${MIN_CROP_EDGE_PX}`);
    expect(rule).toContain(`< ${MIN_CROP_AREA_PX}`);
    // Spelled out rather than interpolated: `String(1e-6)` is "0.000001".
    expect(CROP_WINDING_EPSILON).toBe(1e-6);
    expect(rule).toContain("<= 1e-6");
  });

  /**
   * The direction that must never fail: anything the server accepts has to be
   * applyable here. A random sweep, because the hand-written cases above only
   * cover the shapes someone thought of.
   */
  it("never rejects a quad the server would accept", () => {
    let seed = 20260908;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 4000; i++) {
      const corners = quad(
        [rand() * 500, rand() * 1000],
        [rand() * 500, rand() * 1000],
        [rand() * 500, rand() * 1000],
        [rand() * 500, rand() * 1000],
      );
      const accepted = serverAccepts(corners, 500, 1000);
      expect(cropQuadProblem(corners, 500, 1000) === null, JSON.stringify(corners)).toBe(accepted);
    }
  });

  it("says what to do rather than naming the geometry", () => {
    for (const problem of ["outside-image", "not-convex", "edge-too-short", "area-too-small"] as const) {
      const hint = cropQuadHint(problem);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint).not.toMatch(/convex|clockwise|winding|quad|vertex/i);
    }
    expect(cropQuadIssue(quad([10, 10], [400, 10], [400, 900], [10, 900]), 500, 1000)).toBeNull();
    expect(cropQuadIssue(quad([400, 10], [10, 10], [400, 900], [10, 900]), 500, 1000)).toBe(cropQuadHint("not-convex"));
  });
});

describe("a refused /transform", () => {
  /** The exact string an owner used to be shown after a wasted upload. */
  it("replaces the endpoint's geometry wording", () => {
    expect(transformFailureMessage(400, "Crop corners must form a clockwise convex receipt with distinct corners")).toBe(CROP_RETRY_MESSAGE);
    expect(transformFailureMessage(400, "Crop corners must be inside the original image")).toBe(CROP_RETRY_MESSAGE);
    expect(transformFailureMessage(400, "Selected receipt area is too small")).toBe(CROP_RETRY_MESSAGE);
    expect(transformFailureMessage(400, undefined)).toBe(CROP_RETRY_MESSAGE);
  });

  /** But keeps a 400 that already tells the owner what to change. */
  it("keeps the too-large-photo instruction, which is already actionable", () => {
    const server = "This photo is too big to straighten (52MP). Lower your camera's photo size in its settings and take it again, or save this receipt using the photo as it is.";
    expect(transformFailureMessage(400, server)).toBe(server);
  });

  it("leaves non-400 messages alone — the transport already writes those", () => {
    expect(transformFailureMessage(503, "Receipt correction is busy. Try again shortly.")).toBe("Receipt correction is busy. Try again shortly.");
    expect(transformFailureMessage(undefined, "")).toBe(CROP_RETRY_MESSAGE);
  });
});
