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
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb, waitForScanProcessing } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
  ocrGate.release = null;
});

afterAll(disconnectDb);

const PNG = Buffer.from("fake-image-bytes");

describe("POST /api/v1/records/receipts", () => {
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

  it("rejects an unauthenticated upload", async () => {
    const res = await request(app)
      .post("/api/v1/records/receipts")
      .field("businessProfileId", String(ctx.profile.id))
      .attach("files", PNG, { filename: "receipt.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/records/receipts/:id", () => {
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
