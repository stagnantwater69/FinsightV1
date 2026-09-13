import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The only test in this suite that goes through real HTTP.
 *
 * Everything else calls the services directly, which is the right level for
 * business logic — but the async-scan change lives partly in the HTTP layer
 * itself: the status code the upload answers with (202, not 201), the route
 * that polling depends on existing at all, and the shape a client actually
 * receives. A service-level test cannot see any of that, so it would have
 * passed just as happily with the route unregistered.
 *
 * Storage and the read pipeline are mocked for the same reason they are
 * everywhere else — what is under test here is the wiring, not OCR accuracy.
 */
vi.mock("../../src/services/storage.service", () => ({
  uploadReceiptImage: vi.fn(async () => "1/mock-receipt.jpg"),
  uploadCsvFile: vi.fn(async () => "1/mock.csv"),
  signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed.jpg"),
  deleteReceiptImage: vi.fn(async () => true),
}));

const { ocrGate } = vi.hoisted(() => ({
  // Held open so a test can observe "Processing" before letting the read
  // finish — the whole point of the change is that this window exists.
  ocrGate: { release: null as null | (() => void) },
}));
vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractReceipt: async () => {
      if (ocrGate.release) {
        await new Promise<void>((resolve) => {
          ocrGate.release = resolve;
        });
      }
      return {
        text: "ABC STORE\nDate: 2026-07-20\nRice 25kg 1220.00\nTOTAL 1220.00",
        confidence: 95,
        lines: [],
      };
    },
  };
});

vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, categoriseReceiptItems: vi.fn(async () => []) };
});

vi.mock("../../src/services/visionOcr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/visionOcr.service")>();
  return { ...actual, extractReceiptWithVision: vi.fn(async () => null) };
});

// Auth is the one thing that cannot be exercised for real here — it validates
// against a live Supabase project. Mocked at the token-resolution seam only,
// so requireAuth's own logic (bearer parsing, the user lookup, the 401 paths)
// still runs against the real database row created below.
const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

import request from "supertest";
import sharp from "sharp";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { deleteReceiptImage, uploadReceiptImage } from "../../src/services/storage.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, waitForScanProcessing } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  PNG = await sharp({ create: { width: 80, height: 120, channels: 3, background: "white" } }).jpeg().toBuffer();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
  ocrGate.release = null;
  let storedFiles = 0;
  vi.mocked(uploadReceiptImage).mockReset().mockImplementation(async () => `1/mock-receipt-${++storedFiles}.jpg`);
  vi.mocked(deleteReceiptImage).mockClear();
});

afterAll(disconnectDb);

// A real decoded image is required at the HTTP upload boundary; OCR is mocked.
let PNG: Buffer;

describe("POST /api/v1/records/receipts/transform", () => {
  const corners = JSON.stringify({ topLeft: { x: 0, y: 0 }, topRight: { x: 80, y: 0 }, bottomRight: { x: 80, y: 120 }, bottomLeft: { x: 0, y: 120 } });

  it("requires authentication before accepting correction work", async () => {
    const response = await request(app).post("/api/v1/records/receipts/transform").field("corners", corners).attach("file", PNG, "receipt.jpg");
    expect(response.status).toBe(401);
  });

  it("returns a usable corrected JPEG without creating a scan or financial record", async () => {
    const image = await sharp({ create: { width: 80, height: 120, channels: 3, background: "white" } }).png().toBuffer();
    const response = await request(app).post("/api/v1/records/receipts/transform").set(...AUTH)
      .field("corners", corners).attach("file", image, { filename: "receipt.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ width: 80, height: 120, mimeType: "image/jpeg", transformVersion: "perspective-v2" });
    expect((await sharp(Buffer.from(response.body.base64, "base64")).metadata()).format).toBe("jpeg");
    expect(await prisma.receiptScan.count()).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("rejects missing files and malformed corner data", async () => {
    const missing = await request(app).post("/api/v1/records/receipts/transform").set(...AUTH).field("corners", corners);
    expect(missing.status).toBe(400);
    const invalid = await request(app).post("/api/v1/records/receipts/transform").set(...AUTH)
      .field("corners", "{broken").attach("file", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });
    expect(invalid.status).toBe(400);
    expect(await prisma.receiptScan.count()).toBe(0);
  });
});

describe("POST /api/v1/records/receipts", () => {
  it("rejects fake image bytes before storing a scan", async () => {
    const response = await request(app).post("/api/v1/records/receipts").set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .attach("files", Buffer.from("not an image"), { filename: "receipt.jpg", contentType: "image/jpeg" });
    expect(response.status).toBe(400);
    expect(await prisma.receiptScan.count()).toBe(0);
  });

  it("replays simultaneous uploads with one key and rejects changing its contents", async () => {
    const upload = (buffer: Buffer) => request(app).post("/api/v1/records/receipts").set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id)).field("idempotencyKey", "receipt-http-retry")
      .attach("files", buffer, { filename: "receipt.jpg", contentType: "image/jpeg" });
    const [first, second] = await Promise.all([upload(PNG), upload(PNG)]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.id).toBe(second.body.id);
    expect(await prisma.receiptScan.count()).toBe(1);
    await waitForScanProcessing(first.body.id);
    expect((await upload(PNG)).body.id).toBe(first.body.id);
    const different = await sharp({ create: { width: 80, height: 120, channels: 3, background: "black" } }).jpeg().toBuffer();
    expect((await upload(different)).status).toBe(409);
    expect(await prisma.receiptScan.count()).toBe(1);
  });

  it.each([false, true])("arbitrates an upload-key race and cleans up only losing files (different contents: %s)", async (differentContents) => {
    // Neither upload can create its scan until both have stored a distinct
    // object. This forces the unique-index race instead of hoping HTTP timing
    // happens to exercise it.
    let releaseUploads!: () => void;
    const uploadsReady = new Promise<void>((resolve) => { releaseUploads = resolve; });
    vi.mocked(uploadReceiptImage)
      .mockImplementationOnce(async () => { await uploadsReady; return "1/race-first.jpg"; })
      .mockImplementationOnce(async () => { releaseUploads(); await uploadsReady; return "1/race-second.jpg"; });
    const otherImage = differentContents
      ? await sharp({ create: { width: 80, height: 120, channels: 3, background: "black" } }).jpeg().toBuffer()
      : PNG;
    const upload = (buffer: Buffer) => request(app).post("/api/v1/records/receipts").set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id)).field("idempotencyKey", "receipt-forced-race")
      .attach("files", buffer, { filename: "receipt.jpg", contentType: "image/jpeg" });
    const responses = await Promise.all([upload(PNG), upload(otherImage)]);
    expect(responses.map((response) => response.status).sort()).toEqual(differentContents ? [202, 409] : [202, 202]);
    expect(await prisma.receiptScan.count()).toBe(1);
    const winner = await prisma.receiptScan.findFirstOrThrow();
    await waitForScanProcessing(winner.id);
    if (!differentContents) expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    expect(vi.mocked(deleteReceiptImage).mock.calls.map(([path]) => path)).toEqual([
      winner.imageFile === "1/race-first.jpg" ? "1/race-second.jpg" : "1/race-first.jpg",
    ]);
  });

  it("does not replay another profile's receipt, even with the same client key", async () => {
    const upload = (profileId: number) => request(app).post("/api/v1/records/receipts").set(...AUTH)
      .field("businessProfileId", String(profileId)).field("idempotencyKey", "shared-client-key")
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });
    const first = await upload(ctx.profile.id);
    expect(first.status).toBe(202);
    await waitForScanProcessing(first.body.id);
    const other = await makeOwnerWithProfile();
    authUserId.value = other.user.authId;
    const storedBefore = vi.mocked(uploadReceiptImage).mock.calls.length;
    expect((await upload(ctx.profile.id)).status).toBe(404);
    expect(uploadReceiptImage).toHaveBeenCalledTimes(storedBefore);
    const second = await upload(other.profile.id);
    expect(second.status).toBe(202);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.businessProfileId).toBe(other.profile.id);
    await waitForScanProcessing(second.body.id);
    expect(await prisma.receiptScan.count()).toBe(2);
  });

  it.each(["processed image", "capture metadata"])("rejects a replay whose %s changed", async (changedField) => {
    const different = await sharp({ create: { width: 80, height: 120, channels: 3, background: "black" } }).jpeg().toBuffer();
    const upload = (changed: boolean) => request(app).post("/api/v1/records/receipts").set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id)).field("idempotencyKey", "receipt-variant-replay")
      .field("captureMetadata", JSON.stringify([{ captureMode: changed && changedField === "capture metadata" ? "long" : "standard" }]))
      .attach("files", changed && changedField === "processed image" ? different : PNG, { filename: "processed.jpg", contentType: "image/jpeg" })
      .attach("originalFiles", PNG, { filename: "original.jpg", contentType: "image/jpeg" });
    const first = await upload(false);
    expect(first.status).toBe(202);
    await waitForScanProcessing(first.body.id);
    const storedBefore = vi.mocked(uploadReceiptImage).mock.calls.length;
    expect((await upload(true)).status).toBe(409);
    expect(uploadReceiptImage).toHaveBeenCalledTimes(storedBefore);
    expect(await prisma.receiptScan.count()).toBe(1);
  });

  it("answers 202 with a pollable scan rather than 201 with a finished one", async () => {
    const res = await request(app)
      .post("/api/v1/records/receipts")
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });

    // 202 Accepted is the contract: the photographs are stored and a scan
    // exists, but reading them has not finished.
    expect(res.status).toBe(202);
    expect(res.body.id).toBeGreaterThan(0);
    expect(res.body.processingStatus).toBe("Processing");
    // The DTO shape is the same one the finished scan will have, so a client
    // renders from one type throughout — the figures are simply still null.
    expect(res.body).toHaveProperty("extractedAmount", null);
    expect(res.body).toHaveProperty("items");

    await waitForScanProcessing(res.body.id);
  });

  it("still refuses an upload with no file", async () => {
    const res = await request(app)
      .post("/api/v1/records/receipts")
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id));

    expect(res.status).toBe(400);
  });

  it("accepts paired original and processed pages with validated provenance", async () => {
    const metadata = [{
      source: "manual-camera",
      captureMode: "long",
      processingMode: "manual-crop",
      originalWidth: 1200,
      originalHeight: 2000,
      processedWidth: 900,
      processedHeight: 1700,
      corners: {
        topLeft: { x: 100, y: 100 }, topRight: { x: 1000, y: 100 },
        bottomRight: { x: 1000, y: 1800 }, bottomLeft: { x: 100, y: 1800 },
      },
      transformVersion: "manual-axis-crop-v1",
    }];
    const res = await request(app)
      .post("/api/v1/records/receipts")
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("captureMetadata", JSON.stringify(metadata))
      .attach("files", PNG, { filename: "processed.jpg", contentType: "image/jpeg" })
      .attach("originalFiles", PNG, { filename: "original.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(202);
    await waitForScanProcessing(res.body.id);
    const page = await prisma.receiptScanPage.findFirstOrThrow({ where: { receiptScanId: res.body.id } });
    expect(page.processedImageFile).not.toBeNull();
    expect(page.captureMetadata).toMatchObject({ processingMode: "manual-crop", captureMode: "long" });
    expect(page.originalRawText).toContain("TOTAL 1220.00");
    expect(page.processedRawText).toContain("TOTAL 1220.00");
  });

  it("rejects crop metadata whose corners leave the original image", async () => {
    const res = await request(app)
      .post("/api/v1/records/receipts")
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("captureMetadata", JSON.stringify([{
        originalWidth: 100,
        originalHeight: 100,
        corners: {
          topLeft: { x: 0, y: 0 }, topRight: { x: 101, y: 0 },
          bottomRight: { x: 101, y: 100 }, bottomLeft: { x: 0, y: 100 },
        },
      }]))
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated upload", async () => {
    const res = await request(app)
      .post("/api/v1/records/receipts")
      .field("businessProfileId", String(ctx.profile.id))
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/records/receipts/:id", () => {
  it("returns printed details and blocks foreign-currency confirmation at the HTTP boundary", async () => {
    const scan = await prisma.receiptScan.create({ data: {
      businessProfileId: ctx.profile.id, imageFile: "1/foreign.jpg", processingStatus: "Complete",
      rawText: "Receipt No: INV-1\nSubtotal USD 100.00\nTax 12.00\nTOTAL USD 112.00\nPayment: Visa **** 1234",
    } });
    const response = await request(app).get(`/api/v1/records/receipts/${scan.id}`).set(...AUTH);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ requiresManualCurrencyConversion: true,
      receiptDetails: { currency: "USD", subtotal: 100, tax: 12, paymentMethod: "Visa", receiptNumber: "INV-1" } });
    expect(response.body).not.toHaveProperty("uploadKey");
    expect(response.body).not.toHaveProperty("uploadHash");
    const confirm = await request(app).post(`/api/v1/records/receipts/${scan.id}/confirm`).set(...AUTH)
      .send({ date: "2026-09-01", description: "Stock", amount: 112, splits: [{ categoryId: ctx.categories.Inventory, amount: 112 }] });
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toMatch(/foreign currency/i);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("reports Processing while the read is in flight, then Complete with the figures", async () => {
    // Hold the read open so the in-flight state is observable rather than
    // raced past.
    ocrGate.release = () => {};

    const created = await request(app)
      .post("/api/v1/records/receipts")
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });
    expect(created.status).toBe(202);

    // Give the background task a moment to actually reach the gate.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const midRead = await request(app)
      .get(`/api/v1/records/receipts/${created.body.id}`)
      .set(...AUTH);
    expect(midRead.status).toBe(200);
    expect(midRead.body.processingStatus).toBe("Processing");
    expect(midRead.body.extractedAmount).toBeNull();

    // Let the read finish.
    ocrGate.release?.();
    ocrGate.release = null;
    await waitForScanProcessing(created.body.id);

    const done = await request(app)
      .get(`/api/v1/records/receipts/${created.body.id}`)
      .set(...AUTH);
    expect(done.body.processingStatus).toBe("Complete");
    expect(done.body.extractedAmount).toBe(1220);
    expect(done.body.extractedVendor).toBe("ABC STORE");
  });

  it("refuses to confirm a scan that is still being read", async () => {
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: ctx.profile.id,
        imageFile: "1/mid-read.jpg",
        confirmationStatus: "Pending",
        processingStatus: "Processing",
      },
    });

    const res = await request(app)
      .post(`/api/v1/records/receipts/${scan.id}/confirm`)
      .set(...AUTH)
      .send({
        date: "2026-07-20",
        description: "Anything",
        amount: 100,
        splits: [{ categoryId: ctx.categories.Inventory, amount: 100 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/still being read/i);
  });

  it("does not reveal another owner's scan to a poller", async () => {
    const created = await request(app)
      .post("/api/v1/records/receipts")
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });
    await waitForScanProcessing(created.body.id);

    const other = await makeOwnerWithProfile();
    authUserId.value = other.user.authId;

    // 404, not 403 — the same non-disclosure rule used everywhere else.
    const res = await request(app)
      .get(`/api/v1/records/receipts/${created.body.id}`)
      .set(...AUTH);
    expect(res.status).toBe(404);
  });
});
