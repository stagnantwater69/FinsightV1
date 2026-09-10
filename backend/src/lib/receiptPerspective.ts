import sharp from "sharp";
import { Worker } from "node:worker_threads";
import { ApiError } from "../middleware/error.middleware";

export type PerspectivePoint = { x: number; y: number };
export type PerspectiveCorners = {
  topLeft: PerspectivePoint; topRight: PerspectivePoint;
  bottomRight: PerspectivePoint; bottomLeft: PerspectivePoint;
};

const MAX_PIXELS = 12_000_000;
const MAX_EDGE = 16_000;

/** Keep receipt panoramas legible while bounding both decode and worker buffers. */
export function boundedPerspectiveDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ApiError(400, "Image dimensions must be positive and finite");
  }
  const longest = Math.max(width, height), shortest = Math.min(width, height);
  const elongated = longest / shortest >= 3;
  const maxEdge = elongated ? MAX_EDGE : 2048;
  const scale = Math.min(1, maxEdge / longest, 2048 / shortest, Math.sqrt(MAX_PIXELS / width / height));
  let w = Math.max(2, Math.min(maxEdge, Math.round(width * scale)));
  let h = Math.max(2, Math.min(maxEdge, Math.round(height * scale)));
  // Rounding must not push a near-limit panorama over the pixel budget.
  if (w * h > MAX_PIXELS) {
    if (w >= h) w = Math.floor(MAX_PIXELS / h);
    else h = Math.floor(MAX_PIXELS / w);
  }
  return { width: w, height: h };
}

/**
 * How large the SOURCE photograph may be decoded, which is a different
 * question from how large the corrected receipt may be.
 *
 * The output bound above deliberately caps an ordinary photograph's longest
 * edge at 2048, because a whole 4000px frame of a receipt on a counter carries
 * no more readable print than a 2048px one. Applying that same cap to the
 * DECODE starves the crop: a receipt occupying a third of the frame is then
 * resampled from roughly 700 source pixels of width, and thermal print does
 * not survive that — the print is a few pixels wide to begin with.
 *
 * So the decode is bounded only by what memory and the warp loop can carry
 * (the same 12 MP / 16000px budget the output already accepts), and the caller
 * picks the decode scale from the crop rather than from the frame. Nothing
 * here enlarges: `scale` is capped at 1.
 */
export function boundedDecodeDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ApiError(400, "Image dimensions must be positive and finite");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / width / height));
  let w = Math.max(2, Math.round(width * scale));
  let h = Math.max(2, Math.round(height * scale));
  if (w * h > MAX_PIXELS) {
    if (w >= h) w = Math.floor(MAX_PIXELS / h);
    else h = Math.floor(MAX_PIXELS / w);
  }
  return { width: w, height: h };
}

/** Coordinates use the EXIF-oriented image, with its outer bounds at width/height. */
export function validatePerspectiveCorners(corners: PerspectiveCorners, width: number, height: number) {
  const points = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > width || p.y > height)) {
    throw new ApiError(400, "Crop corners must be inside the original image");
  }
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i]!, b = points[(i + 1) % 4]!, c = points[(i + 2) % 4]!;
    // Positive winding in screen coordinates; also rejects crossing and concave quads.
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 1e-6 || Math.hypot(b.x - a.x, b.y - a.y) < 8) {
      // The precise condition — clockwise winding, convex, no coincident or
      // near-coincident corners — is a statement about the quad the client
      // sent, not something an owner holding a phone can act on. They get the
      // instruction; the geometry stays in the code and the log.
      throw new ApiError(400, "Drag the four corners to the edges of the receipt, then try again.");
    }
    area += a.x * b.y - b.x * a.y;
  }
  if (area / 2 < 64) throw new ApiError(400, "Selected receipt area is too small");
  return points;
}

// Fixed source, never user-supplied code. CPU-heavy resampling runs off the API thread.
const WARP_WORKER = `
const { parentPort, workerData: d } = require('node:worker_threads');
const [p0,p1,p2,p3] = d.points;
const dx1=p1.x-p2.x, dx2=p3.x-p2.x, dx3=p0.x-p1.x+p2.x-p3.x;
const dy1=p1.y-p2.y, dy2=p3.y-p2.y, dy3=p0.y-p1.y+p2.y-p3.y;
const det=dx1*dy2-dx2*dy1;
const g=(dx3*dy2-dx2*dy3)/det, h=(dx1*dy3-dx3*dy1)/det;
const a=p1.x-p0.x+g*p1.x, b=p3.x-p0.x+h*p3.x;
const e=p1.y-p0.y+g*p1.y, f=p3.y-p0.y+h*p3.y;
const out = new Uint8Array(d.ow*d.oh*3);
for(let y=0;y<d.oh;y++) for(let x=0;x<d.ow;x++) {
  const u=(x+0.5)/d.ow, v=(y+0.5)/d.oh, den=g*u+h*v+1;
  const sx=Math.max(0,Math.min(d.w-1,(a*u+b*v+p0.x)/den-0.5));
  const sy=Math.max(0,Math.min(d.h-1,(e*u+f*v+p0.y)/den-0.5));
  const ix=Math.floor(sx), iy=Math.floor(sy), jx=Math.min(ix+1,d.w-1), jy=Math.min(iy+1,d.h-1);
  const fx=sx-ix, fy=sy-iy, o=(y*d.ow+x)*3;
  for(let k=0;k<3;k++) out[o+k]=Math.round(
    d.data[(iy*d.w+ix)*3+k]*(1-fx)*(1-fy)+d.data[(iy*d.w+jx)*3+k]*fx*(1-fy)+
    d.data[(jy*d.w+ix)*3+k]*(1-fx)*fy+d.data[(jy*d.w+jx)*3+k]*fx*fy);
}
parentPort.postMessage(out, [out.buffer]);
`;

/**
 * How much of this correction may run at once, process-wide.
 *
 * This gate exists to bound peak memory: each in-flight warp holds a decoded
 * RGB frame plus the clone handed to its worker, and nothing else in the
 * process reserves room for that. It is NOT an abuse control — abuse is
 * already handled per user by the TRANSFORM_BURST database limiter, which is
 * durable and does not care which replica the request lands on.
 *
 * The previous ceiling of 2 conflated the two jobs and got the trade badly
 * wrong: a measured warp costs ~565ms for a 12MP output, so two owners
 * cropping at the same instant were enough to make a THIRD owner's crop fail
 * outright with "busy" — one owner's ordinary work refusing another's, on a
 * counter of that replica's own making that resets on restart and multiplies
 * across replicas.
 *
 * Now a request over the ceiling WAITS for a slot instead of being refused,
 * which at ~565ms of work is a short queue rather than an error, and only a
 * genuinely saturated process (every slot busy AND the queue full) still
 * answers 503 — by which point the honest answer really is "try again".
 */
const MAX_CONCURRENT_TRANSFORMS = 4;
const MAX_QUEUED_TRANSFORMS = 12;
const QUEUE_WAIT_MS = 8_000;

/**
 * The largest SOURCE photograph this will decode.
 *
 * Also passed to sharp as `limitInputPixels` below, but that is only a
 * backstop: sharp enforces it at DECODE time, and `metadata()` does not
 * decode — so a 50MP gallery photo used to sail through every check here and
 * throw deep inside `.toBuffer()`, landing in the catch-all at the bottom.
 * The owner was then told to "use the original or try another photo" about a
 * photo that is not corrupt and a phone whose every picture is the same size,
 * so no other photo would have worked either. Checked up front instead, with
 * an answer they can act on.
 */
const MAX_SOURCE_PIXELS = 40_000_000;

let activeTransforms = 0;
type Waiter = { resolve: () => void; reject: (error: unknown) => void; timer: NodeJS.Timeout };
const transformQueue: Waiter[] = [];

async function acquireTransformSlot(): Promise<void> {
  if (activeTransforms < MAX_CONCURRENT_TRANSFORMS) {
    activeTransforms++;
    return;
  }
  if (transformQueue.length >= MAX_QUEUED_TRANSFORMS) {
    throw new ApiError(503, "Receipt correction is busy. Try again shortly.");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const at = transformQueue.indexOf(waiter);
        if (at >= 0) transformQueue.splice(at, 1);
        reject(new ApiError(503, "Receipt correction is busy. Try again shortly."));
      }, QUEUE_WAIT_MS),
    };
    // Never hold the process open on a queue that is only waiting.
    waiter.timer.unref?.();
    transformQueue.push(waiter);
  });
  // No increment: the slot was HANDED OVER by releaseTransformSlot, so the
  // active count already accounts for it. Incrementing here would let the
  // ceiling drift upwards one handover at a time.
}

function releaseTransformSlot(): void {
  const next = transformQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  activeTransforms--;
}

export async function transformReceiptPerspective(buffer: Buffer, corners: PerspectiveCorners) {
  await acquireTransformSlot();
  try {
    /*
     * The header is read with the pixel limit OFF, and the limit is then
     * applied by this code rather than by sharp.
     *
     * Not a loosening: `metadata()` parses the header and decodes nothing, so
     * reading the dimensions of a 50MP photograph costs the same as reading a
     * 2MP one. Everything that actually decodes still goes through `input`
     * below, which keeps the limit. What this buys is the ability to ANSWER —
     * sharp's own rejection is the string "Input image exceeds pixel limit",
     * thrown from a call this cannot distinguish from a corrupt file, so it
     * fell into the catch-all and told the owner to try another photo. Their
     * phone takes every photo at that size; there was no other photo to try.
     */
    const metadata = await sharp(buffer, { limitInputPixels: false, failOn: "error" }).metadata();
    const input = sharp(buffer, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error" });
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
      throw new ApiError(400, "Use a single JPEG, PNG, or WEBP image");
    }
    if (metadata.width * metadata.height > MAX_SOURCE_PIXELS) {
      const megapixels = Math.round((metadata.width * metadata.height) / 1_000_000);
      throw new ApiError(
        400,
        `This photo is too big to straighten (${megapixels}MP). Lower your camera's photo size in its settings and take it again, or save this receipt using the photo as it is.`,
      );
    }
    const swapped = (metadata.orientation ?? 1) >= 5;
    const originalWidth = swapped ? metadata.height : metadata.width;
    const originalHeight = swapped ? metadata.width : metadata.height;
    const points = validatePerspectiveCorners(corners, originalWidth, originalHeight);
    /*
     * The decode is scaled from the CROP, not from the frame.
     *
     * The corrected receipt is allowed to be as large as
     * `boundedPerspectiveDimensions` says, so the source has to still carry
     * that many pixels across the selected quad when it is resampled. Taking
     * the frame's own bound instead threw away resolution the output was
     * entitled to whenever the receipt did not fill the picture, which is the
     * ordinary case for a photograph taken on a counter.
     *
     * A full-frame selection is unchanged by this: the crop scale is then the
     * frame's own scale.
     */
    const gap = (a: PerspectivePoint, b: PerspectivePoint) => Math.hypot(a.x - b.x, a.y - b.y);
    const cropWidth = Math.max(gap(points[0]!, points[1]!), gap(points[3]!, points[2]!));
    const cropHeight = Math.max(gap(points[0]!, points[3]!), gap(points[1]!, points[2]!));
    const cropOutput = boundedPerspectiveDimensions(cropWidth, cropHeight);
    const cropScale = Math.min(1, Math.max(cropOutput.width / cropWidth, cropOutput.height / cropHeight));
    const inputSize = boundedDecodeDimensions(originalWidth * cropScale, originalHeight * cropScale);
    const { data, info } = await input.rotate().resize({ ...inputSize, fit: "fill", withoutEnlargement: true })
      .flatten({ background: "white" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const scaled = points.map(p => ({ x: p.x * info.width / originalWidth, y: p.y * info.height / originalHeight }));
    const distance = (i: number, j: number) => Math.hypot(scaled[i]!.x - scaled[j]!.x, scaled[i]!.y - scaled[j]!.y);
    const naturalWidth = Math.max(distance(0, 1), distance(3, 2));
    const naturalHeight = Math.max(distance(0, 3), distance(1, 2));
    const { width, height } = boundedPerspectiveDimensions(naturalWidth, naturalHeight);
    const warped = await new Promise<Buffer>((resolve, reject) => {
      let receivedResult = false;
      /*
       * The decoded pixels are CLONED into the worker, which is a copy this
       * would rather not make — but sharp hands back a Buffer over external
       * memory that `transferList` refuses ("Cannot transfer object of
       * unsupported type"), so the copy is not avoidable this way. The
       * concurrency gate above is what bounds the resulting peak.
       */
      const worker = new Worker(WARP_WORKER, {
        eval: true,
        workerData: { data, points: scaled, w: info.width, h: info.height, ow: width, oh: height },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      const timer = setTimeout(() => { void worker.terminate(); reject(new ApiError(503, "Receipt correction timed out. Try a smaller image.")); }, 10_000);
      worker.once("message", (result: Uint8Array) => { receivedResult = true; clearTimeout(timer); resolve(Buffer.from(result)); });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", code => { clearTimeout(timer); if (code !== 0 || !receivedResult) reject(new ApiError(503, "Receipt correction could not complete")); });
    });
    const jpeg = await sharp(warped, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    return { base64: jpeg.toString("base64"), mimeType: "image/jpeg" as const, width, height, transformVersion: "perspective-v2" as const };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Could not correct this image. Use the original or try another photo.");
  } finally {
    releaseTransformSlot();
  }
}
