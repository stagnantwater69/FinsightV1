import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { ApiError } from "../../src/middleware/error.middleware";
import { boundedDecodeDimensions, boundedPerspectiveDimensions, transformReceiptPerspective, validatePerspectiveCorners, type PerspectiveCorners } from "../../src/lib/receiptPerspective";

const frame = (width: number, height: number): PerspectiveCorners => ({
  topLeft: { x: 0, y: 0 }, topRight: { x: width, y: 0 },
  bottomRight: { x: width, y: height }, bottomLeft: { x: 0, y: height },
});

describe("receipt perspective validation", () => {
  it("accepts full frame and a clockwise trapezoid", () => {
    expect(validatePerspectiveCorners(frame(100, 200), 100, 200)).toHaveLength(4);
    expect(validatePerspectiveCorners({ ...frame(100, 200), topLeft: { x: 20, y: 10 }, topRight: { x: 80, y: 10 } }, 100, 200)).toHaveLength(4);
  });

  it.each([
    { ...frame(100, 200), topLeft: { x: -1, y: 0 } },
    { ...frame(100, 200), topLeft: { x: Number.NaN, y: 0 } },
    { ...frame(100, 200), bottomRight: { x: 101, y: 200 } },
    { ...frame(100, 200), topRight: { x: 0, y: 200 }, bottomLeft: { x: 100, y: 0 } },
    { ...frame(100, 200), bottomRight: { x: 10, y: 10 } },
    frame(2, 2),
  ])("rejects out-of-bounds, nonfinite, crossed, concave and tiny selections", (corners) => {
    expect(() => validatePerspectiveCorners(corners, 100, 200)).toThrow();
  });
});

describe("bounded perspective dimensions", () => {
  it.each([[600, 3000], [3000, 600], [1200, 10000]])("preserves elongated receipt dimensions %ix%i", (width, height) => {
    expect(boundedPerspectiveDimensions(width, height)).toEqual({ width, height });
  });
  it.each([[4000, 3000], [3000, 4000], [4000, 4000]])("retains the ordinary photo 2048-edge cap %ix%i", (width, height) => {
    expect(Math.max(...Object.values(boundedPerspectiveDimensions(width, height)))).toBe(2048);
  });
  it.each([[4000, 100000], [100000, 4000], [1200, 16000], [16000, 1200], [8000, 30000]])("bounds oversized panoramas %ix%i", (width, height) => {
    const result = boundedPerspectiveDimensions(width, height);
    expect(result.width * result.height).toBeLessThanOrEqual(12_000_000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(16000);
    expect(Math.min(result.width, result.height)).toBeLessThanOrEqual(2048);
    // Pixel rounding has the same relative effect in either orientation; an
    // absolute ratio tolerance unfairly amplifies landscape rounding error.
    const relativeAspectError = Math.abs((result.width / result.height) / (width / height) - 1);
    expect(relativeAspectError).toBeLessThan(0.002);
  });
  it.each([[0, 20], [-1, 20], [Number.NaN, 20], [20, Infinity]])("rejects invalid dimensions", (width, height) => {
    expect(() => boundedPerspectiveDimensions(width, height)).toThrow();
  });
});

describe("bounded decode dimensions", () => {
  it("keeps an ordinary photograph at full size rather than the 2048 output cap", () => {
    expect(boundedDecodeDimensions(4000, 3000)).toEqual({ width: 4000, height: 3000 });
  });
  it.each([[9000, 6000], [40000, 3000], [3000, 40000]])("still bounds pixels and edges %ix%i", (width, height) => {
    const result = boundedDecodeDimensions(width, height);
    expect(result.width * result.height).toBeLessThanOrEqual(12_000_000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(16_000);
  });
  it("never enlarges a small image", () => {
    expect(boundedDecodeDimensions(40, 60)).toEqual({ width: 40, height: 60 });
  });
});

describe("actual perspective image resampling", () => {
  /*
   * The defect this pins: decoding the whole frame down to the ordinary
   * 2048 output cap left a receipt occupying part of the picture resampled
   * from a few hundred source pixels, which is where thermal print is lost.
   */
  it("keeps a part-of-frame receipt's own resolution instead of the frame's cap", async () => {
    const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "white" } }).jpeg().toBuffer();
    const result = await transformReceiptPerspective(input, {
      topLeft: { x: 1500, y: 200 }, topRight: { x: 2400, y: 200 },
      bottomRight: { x: 2400, y: 2700 }, bottomLeft: { x: 1500, y: 2700 },
    });
    // The selection is 900x2500 in the original photograph; the old
    // frame-scaled decode produced roughly 460x1280 from the same corners.
    expect(result.width).toBeGreaterThan(700);
    expect(result.height).toBeGreaterThan(1900);
    expect(result.width * result.height).toBeLessThanOrEqual(12_000_000);
  });

  it("leaves a full-frame ordinary photograph on the 2048 cap", async () => {
    const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "white" } }).jpeg().toBuffer();
    const result = await transformReceiptPerspective(input, frame(4000, 3000));
    expect(Math.max(result.width, result.height)).toBe(2048);
  });

  it("bounds decoded and warped oversized panorama output", async () => {
    const input = await sharp({ create: { width: 1200, height: 12000, channels: 3, background: "white" } }).png().toBuffer();
    const result = await transformReceiptPerspective(input, frame(1200, 12000));
    expect(result.width * result.height).toBeLessThanOrEqual(12_000_000);
    expect(result.width).toBeGreaterThan(1000);
    expect(result.height).toBeGreaterThan(10000);
    expect(await sharp(Buffer.from(result.base64, "base64")).metadata()).toMatchObject({ width: result.width, height: result.height });
  });

  it.each([false, true])("preserves a full-frame 600x3000 receipt including EXIF rotation=%s", async (rotated) => {
    const input = await sharp({ create: { width: rotated ? 3000 : 600, height: rotated ? 600 : 3000, channels: 3, background: "white" } })
      .jpeg().withMetadata({ orientation: rotated ? 6 : 1 }).toBuffer();
    const result = await transformReceiptPerspective(input, frame(600, 3000));
    expect(result).toMatchObject({ width: 600, height: 3000, transformVersion: "perspective-v2" });
    expect(await sharp(Buffer.from(result.base64, "base64")).metadata()).toMatchObject({ width: 600, height: 3000 });
  });
  it("preserves a full-frame image's orientation, dimensions and colours", async () => {
    const width = 80, height = 120;
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      data[offset] = x < width / 2 ? 220 : 20;
      data[offset + 1] = y < height / 2 ? 200 : 30;
      data[offset + 2] = 50;
    }
    const input = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const result = await transformReceiptPerspective(input, frame(width, height));
    expect(result).toMatchObject({ width, height, mimeType: "image/jpeg", transformVersion: "perspective-v2" });
    const decoded = await sharp(Buffer.from(result.base64, "base64")).raw().toBuffer();
    for (const [x, y] of [[10, 10], [60, 10], [10, 100], [60, 100]]) {
      const offset = (y! * width + x!) * 3;
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(decoded[offset + channel]! - data[offset + channel]!)).toBeLessThan(8);
    }
  });

  it("warps a trapezoid into a rectangle rather than only cropping its bounding box", async () => {
    const width = 120, height = 120;
    const data = Buffer.alloc(width * height * 3);
    // Red horizontal coordinate ramp makes incorrect bounding-box sampling visible.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 3] = x * 2;
    const input = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const result = await transformReceiptPerspective(input, {
      topLeft: { x: 30, y: 10 }, topRight: { x: 90, y: 10 },
      bottomRight: { x: 110, y: 110 }, bottomLeft: { x: 10, y: 110 },
    });
    expect(result.width).toBe(100);
    const decoded = await sharp(Buffer.from(result.base64, "base64")).raw().toBuffer();
    const topLeftRed = decoded[(5 * result.width + 5) * 3]!;
    const bottomLeftRed = decoded[((result.height - 6) * result.width + 5) * 3]!;
    expect(topLeftRed).toBeGreaterThan(bottomLeftRed + 20);
  });

  it("uses EXIF-oriented dimensions when interpreting crop corners", async () => {
    const input = await sharp({ create: { width: 80, height: 120, channels: 3, background: "white" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await transformReceiptPerspective(input, frame(120, 80));
    expect(result).toMatchObject({ width: 120, height: 80 });
  });

  it("fails safely on invalid bytes and continues accepting subsequent valid work", async () => {
    await expect(transformReceiptPerspective(Buffer.from("not an image"), frame(80, 120))).rejects.toThrow(/Could not correct/);
    const input = await sharp({ create: { width: 80, height: 120, channels: 3, background: "white" } }).png().toBuffer();
    await expect(transformReceiptPerspective(input, frame(80, 120))).resolves.toMatchObject({ width: 80, height: 120 });
  });
});

/**
 * Three ways this endpoint used to answer an owner badly. None of them is a
 * bug in the warp itself, which is why they survived the suite above.
 */
describe("what a busy or oversized correction tells the owner", () => {
  /*
   * The gate used to be a process-wide `activeTransforms >= 2`, so two owners
   * cropping at the same moment made a THIRD owner's crop fail — a refusal
   * caused entirely by other people's traffic, on work measured at ~565ms.
   * Six at once is well past the old ceiling and still under the new queue's
   * capacity, so every one of them must be SERVED, not refused.
   */
  it("serves simultaneous corrections from different owners instead of refusing the extras", async () => {
    const input = await sharp({ create: { width: 200, height: 300, channels: 3, background: "white" } }).png().toBuffer();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => transformReceiptPerspective(input, frame(200, 300))),
    );
    expect(results).toHaveLength(6);
    for (const result of results) expect(result).toMatchObject({ width: 200, height: 300 });
  });

  /*
   * A 40MP+ gallery photo (well under the 10MB upload limit) passed every
   * check here, because `metadata()` does not decode and sharp only enforces
   * `limitInputPixels` when it does — so the throw came from inside
   * `.toBuffer()` and was caught by the catch-all, which told the owner to
   * "use the original or try another photo". Every photo from that phone is
   * the same size, so no other photo would have worked.
   */
  it("names the size when a photo is too large to decode, rather than blaming the photo", async () => {
    const input = await sharp({ create: { width: 8000, height: 5200, channels: 3, background: "white" } })
      .jpeg({ quality: 60 }).toBuffer();
    const failure = await transformReceiptPerspective(input, frame(8000, 5200)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    const { status, message } = failure as ApiError;
    expect(status).toBe(400);
    expect(message).toMatch(/too big to straighten \(42MP\)/);
    // The advice must be something the owner can actually do.
    expect(message).toMatch(/photo size/i);
    expect(message).not.toMatch(/try another photo/i);
  });

  /** Developer copy: "clockwise convex" reached the phone screen verbatim. */
  it("explains a bad corner selection in words rather than geometry", () => {
    const crossed = { ...frame(100, 200), topRight: { x: 0, y: 200 }, bottomLeft: { x: 100, y: 0 } };
    const failure = (() => {
      try { validatePerspectiveCorners(crossed, 100, 200); return null; } catch (error) { return error; }
    })();
    expect(failure).toBeInstanceOf(ApiError);
    const { message } = failure as ApiError;
    expect(message).toMatch(/drag the four corners/i);
    expect(message).not.toMatch(/convex|clockwise|winding/i);
  });
});
