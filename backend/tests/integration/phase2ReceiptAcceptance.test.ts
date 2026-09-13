import { AccountDeletionStage, AccountStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authByToken, storage } = vi.hoisted(() => ({
  authByToken: new Map<string, string>(),
  storage: {
    sequence: 0,
    uploadReceiptImage: vi.fn(),
    deleteReceiptImage: vi.fn(),
    inspectReceiptImage: vi.fn(),
    downloadReceiptImageBounded: vi.fn(),
    signedReceiptImageUrl: vi.fn(),
  },
}));

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        admin: {
          deleteUser: async () => ({ data: {}, error: null }),
        },
        getUser: async (token: string) => {
          const authId = authByToken.get(token);
          return authId
            ? { data: { user: { id: authId } }, error: null }
            : { data: { user: null }, error: new Error("bad token") };
        },
      },
    },
  };
});

vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadReceiptImage: storage.uploadReceiptImage,
    deleteReceiptImage: storage.deleteReceiptImage,
    inspectReceiptImage: storage.inspectReceiptImage,
    downloadReceiptImageBounded: storage.downloadReceiptImageBounded,
    signedReceiptImageUrl: storage.signedReceiptImageUrl,
  };
});

import request from "supertest";
import sharp from "sharp";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { cleanUpReceiptScanIfOrphaned } from "../../src/lib/sourceCleanup";
import { lockDuplicateKey } from "../../src/lib/recordLock";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { runAccountDeletionWorkerOnce } from "../../src/services/accountDeletion.service";
import {
  createReceiptCaptureBatch,
  getReceiptCaptureBatch,
} from "../../src/services/receiptCaptureBatch.service";
import {
  bulkCreateExpenseRecords,
  createExpenseRecord,
  createExpenseRecordWithin,
  updateExpenseRecord,
} from "../../src/services/expenseRecord.service";
import { uploadAndScan } from "../../src/services/receiptScan/queue";
import {
  persistReceiptProcessingOutput,
  runReceiptWorkerOnce,
} from "../../src/services/receiptScan/worker";
import { refreshReceiptDuplicateCandidatesForScan } from "../../src/services/receiptDuplicate.service";
import { runReceiptPurgeWorkerOnce } from "../../src/services/receiptPurge.service";
import {
  disconnectDb,
  makeOwnerWithProfile,
  makeProfile,
  resetDb,
} from "../setup/testDb";

const BATCHES = "/api/v1/records/receipt-batches";
const RECEIPTS = "/api/v1/records/receipts";
const auth = (token: string) => ["Authorization", `Bearer ${token}`] as const;

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  owner = await makeOwnerWithProfile({}, ["Inventory"]);
  other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
  authByToken.clear();
  authByToken.set("owner-token", owner.user.authId);
  authByToken.set("other-token", other.user.authId);

  storage.sequence = 0;
  storage.uploadReceiptImage.mockReset().mockImplementation(async (businessProfileId: number) => (
    `${businessProfileId}/phase2-${++storage.sequence}.jpg`
  ));
  storage.deleteReceiptImage.mockReset().mockResolvedValue(true);
  storage.inspectReceiptImage.mockReset().mockResolvedValue({ sizeBytes: 128, mimetype: "image/jpeg" });
  storage.downloadReceiptImageBounded.mockReset().mockResolvedValue(Buffer.from("unused"));
  storage.signedReceiptImageUrl.mockReset().mockResolvedValue("https://example.test/receipt.jpg");
});

afterAll(disconnectDb);

function page(label: string) {
  return {
    source: "buffer" as const,
    buffer: Buffer.from(label),
    mimetype: "image/jpeg",
    originalname: `${label}.jpg`,
  };
}

async function waitForProfileAdvisoryWaiter(
  businessProfileId: number,
  minimumWaiters = 1,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND classid = ${businessProfileId}::oid
    `;
    if ((row?.waiting ?? 0) >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the duplicate gate contender");
}

async function makeBatch(expectedReceiptCount = 2, status: "COLLECTING" | "PROCESSING" | "PARTIAL_FAILURE" = "COLLECTING") {
  return prisma.receiptCaptureBatch.create({
    data: {
      businessProfileId: owner.profile.id,
      clientBatchKey: `phase2-${expectedReceiptCount}-${status.toLowerCase()}`,
      expectedReceiptCount,
      status,
    },
  });
}

async function makeEditableScan(input: {
  businessProfileId?: number;
  captureBatchId?: number;
  receiptOrdinal?: number;
  status?: "Complete" | "Failed" | "Processing";
  confirmationStatus?: "Pending" | "Confirmed";
  path?: string;
}) {
  const businessProfileId = input.businessProfileId ?? owner.profile.id;
  const path = input.path ?? `${businessProfileId}/editable-source.jpg`;
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      captureBatchId: input.captureBatchId,
      receiptOrdinal: input.receiptOrdinal,
      imageFile: path,
      extractedDate: new Date("2026-09-13T00:00:00.000Z"),
      extractedVendor: "Owner Store",
      extractedDescription: "Rice purchase",
      extractedAmount: 100,
      processingStatus: input.status ?? "Complete",
      confirmationStatus: input.confirmationStatus ?? "Pending",
      pages: {
        create: [{
          pageNumber: 1,
          imageFile: path,
          processedImageFile: `${businessProfileId}/editable-derived.jpg`,
        }],
      },
      items: {
        create: [{
          lineNumber: 1,
          name: "Rice",
          amount: 100,
          amountConfidence: 82,
        }],
      },
    },
    include: { items: true, pages: true },
  });
}

describe("Phase 2 receipt batch contract", () => {
  it("creates one profile-scoped batch under concurrent replay and rejects key reuse with a different count", async () => {
    const input = {
      businessProfileId: owner.profile.id,
      clientBatchKey: "owner-separate-receipts-1",
      expectedReceiptCount: 3,
    };

    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => createReceiptCaptureBatch(owner.user.id, input)),
    );

    expect(new Set(attempts.map((attempt) => attempt.batch.id)).size).toBe(1);
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect(await prisma.receiptCaptureBatch.count()).toBe(1);

    const replay = await request(app)
      .post(BATCHES)
      .set(...auth("owner-token"))
      .send(input);
    expect(replay.status).toBe(200);
    expect(replay.body).not.toHaveProperty("clientBatchKey");
    expect(JSON.stringify(replay.body)).not.toMatch(/\.jpg|imageFile|processedImageFile/);

    const conflict = await request(app)
      .post(BATCHES)
      .set(...auth("owner-token"))
      .send({ ...input, expectedReceiptCount: 2 });
    expect(conflict.status).toBe(409);

    const foreignCreate = await request(app)
      .post(BATCHES)
      .set(...auth("owner-token"))
      .send({ ...input, businessProfileId: other.profile.id, clientBatchKey: "foreign-batch-key" });
    expect(foreignCreate.status).toBe(404);

    const foreignRead = await request(app)
      .get(`${BATCHES}/${attempts[0]!.batch.id}`)
      .set(...auth("other-token"));
    expect(foreignRead.status).toBe(404);
  });

  it("keeps multi-page scans in ordered child receipts and derives every durable batch state", async () => {
    const batch = await makeBatch(3);
    const second = await uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "batch-child-second",
      receiptBatchId: batch.id,
      receiptOrdinal: 2,
      pages: [page("second-a"), page("second-b")],
    });
    const first = await uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "batch-child-first",
      receiptBatchId: batch.id,
      receiptOrdinal: 1,
      pages: [page("first")],
    });

    const collecting = await getReceiptCaptureBatch(owner.user.id, batch.id);
    expect(collecting.status).toBe("COLLECTING");
    expect(collecting.receipts.map((receipt) => receipt.receiptOrdinal)).toEqual([1, 2]);
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: second.id } })).toBe(2);

    const uploadsBeforeDuplicate = storage.uploadReceiptImage.mock.calls.length;
    await expect(uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "duplicate-batch-position",
      receiptBatchId: batch.id,
      receiptOrdinal: 1,
      pages: [page("duplicate")],
    })).rejects.toMatchObject({ status: 409 });
    expect(storage.uploadReceiptImage).toHaveBeenCalledTimes(uploadsBeforeDuplicate);

    const third = await uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "batch-child-third",
      receiptBatchId: batch.id,
      receiptOrdinal: 3,
      pages: [page("third")],
    });
    expect((await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("PROCESSING");

    await prisma.receiptScan.update({ where: { id: first.id }, data: { processingStatus: "Complete", extractedAmount: 10 } });
    await prisma.receiptScan.update({ where: { id: second.id }, data: { processingStatus: "Failed", extractedAmount: 20 } });
    await prisma.receiptScan.update({ where: { id: third.id }, data: { processingStatus: "Complete", extractedAmount: 30 } });
    const partial = await getReceiptCaptureBatch(owner.user.id, batch.id);
    expect(partial.status).toBe("PARTIAL_FAILURE");
    expect(partial.receipts.map((receipt) => receipt.extractedAmount)).toEqual([10, 20, 30]);

    await prisma.receiptScan.updateMany({
      where: { captureBatchId: batch.id },
      data: { processingStatus: "Failed" },
    });
    expect((await getReceiptCaptureBatch(owner.user.id, batch.id)).status).toBe("FAILED");

    await prisma.receiptScan.updateMany({
      where: { captureBatchId: batch.id },
      data: { processingStatus: "Complete" },
    });
    expect((await getReceiptCaptureBatch(owner.user.id, batch.id)).status).toBe("READY_FOR_REVIEW");

    await prisma.receiptScan.updateMany({
      where: { captureBatchId: batch.id },
      data: { confirmationStatus: "Confirmed" },
    });
    const complete = await getReceiptCaptureBatch(owner.user.id, batch.id);
    expect(complete.status).toBe("COMPLETE");
    expect(complete.finishedAt).not.toBeNull();
  });

  it("arbitrates a simultaneous ordinal claim and rejects a batch from another owned profile before storage", async () => {
    const batch = await makeBatch(2);
    const sameOwnerProfile = await makeProfile(owner.user.id, { name: "Owner Second Store" });
    await expect(uploadAndScan(owner.user.id, {
      businessProfileId: sameOwnerProfile.id,
      idempotencyKey: "wrong-profile-batch",
      receiptBatchId: batch.id,
      receiptOrdinal: 1,
      pages: [page("wrong-profile")],
    })).rejects.toMatchObject({ status: 404 });
    expect(storage.uploadReceiptImage).not.toHaveBeenCalled();

    const settled = await Promise.allSettled([
      uploadAndScan(owner.user.id, {
        businessProfileId: owner.profile.id,
        idempotencyKey: "ordinal-race-one",
        receiptBatchId: batch.id,
        receiptOrdinal: 1,
        pages: [page("race-one")],
      }),
      uploadAndScan(owner.user.id, {
        businessProfileId: owner.profile.id,
        idempotencyKey: "ordinal-race-two",
        receiptBatchId: batch.id,
        receiptOrdinal: 1,
        pages: [page("race-two")],
      }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { status: 409 } });
    expect(await prisma.receiptScan.count({ where: { captureBatchId: batch.id } })).toBe(1);
    expect(storage.uploadReceiptImage.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(storage.uploadReceiptImage.mock.calls.length).toBeLessThanOrEqual(2);
    expect(storage.deleteReceiptImage).toHaveBeenCalledTimes(storage.uploadReceiptImage.mock.calls.length - 1);
  });
});

describe("Phase 2 resumable receipt history", () => {
  it("applies owner-scoped status filters without exposing receipt evidence or OCR internals", async () => {
    const processing = await makeEditableScan({ status: "Processing", path: `${owner.profile.id}/private-processing.jpg` });
    const ready = await makeEditableScan({ status: "Complete", path: `${owner.profile.id}/private-ready.jpg` });
    const failed = await makeEditableScan({ status: "Failed", path: `${owner.profile.id}/private-failed.jpg` });
    const confirmed = await makeEditableScan({
      status: "Complete",
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/private-confirmed.jpg`,
    });
    await prisma.receiptScan.updateMany({
      where: { id: { in: [processing.id, ready.id, failed.id, confirmed.id] } },
      data: {
        rawText: "PRIVATE OCR CONTENT",
        uploadHash: "private-upload-hash",
        sourceImageHash: "f".repeat(64),
      },
    });

    const active = await request(app)
      .get(RECEIPTS)
      .query({ businessProfileId: owner.profile.id })
      .set(...auth("owner-token"));
    expect(active.status).toBe(200);
    expect(new Set(active.body.items.map((item: { id: number }) => item.id))).toEqual(
      new Set([processing.id, ready.id, failed.id]),
    );
    expect(JSON.stringify(active.body)).not.toMatch(
      /imageFile|processedImageFile|rawText|uploadHash|sourceImageHash|private-(processing|ready|failed|confirmed)/,
    );

    const expectedByStatus = new Map([
      ["processing", [processing.id]],
      ["ready", [ready.id]],
      ["failed", [failed.id]],
      ["confirmed", [confirmed.id]],
      ["all", [processing.id, ready.id, failed.id, confirmed.id]],
    ]);
    for (const [status, expectedIds] of expectedByStatus) {
      const response = await request(app)
        .get(RECEIPTS)
        .query({ businessProfileId: owner.profile.id, status })
        .set(...auth("owner-token"));
      expect(response.status).toBe(200);
      expect(new Set(response.body.items.map((item: { id: number }) => item.id))).toEqual(new Set(expectedIds));
    }

    const foreign = await request(app)
      .get(RECEIPTS)
      .query({ businessProfileId: other.profile.id, status: "all" })
      .set(...auth("owner-token"));
    expect(foreign.status).toBe(404);
  });

  it("paginates a tied creation timestamp by descending id without gaps or duplicates", async () => {
    const tiedAt = new Date("2026-09-13T08:30:00.000Z");
    const scans = [];
    for (let index = 0; index < 5; index++) {
      const scan = await makeEditableScan({ path: `${owner.profile.id}/history-${index}.jpg` });
      scans.push(await prisma.receiptScan.update({
        where: { id: scan.id },
        data: { createdAt: tiedAt },
      }));
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(app)
        .get(RECEIPTS)
        .query({
          businessProfileId: owner.profile.id,
          status: "active",
          take: 2,
          ...(cursor ? { cursor } : {}),
        })
        .set(...auth("owner-token"));
      expect(response.status).toBe(200);
      expect(response.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...response.body.items.map((item: { id: number }) => item.id));
      cursor = response.body.nextCursor;
    } while (cursor);

    expect(seen).toEqual(scans.map((scan) => scan.id).sort((left, right) => right - left));
    expect(new Set(seen).size).toBe(scans.length);

    const malformed = await request(app)
      .get(RECEIPTS)
      .query({ businessProfileId: owner.profile.id, cursor: "not-a-valid-cursor" })
      .set(...auth("owner-token"));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/invalid receipt history cursor/i);
  });
});

describe("Phase 2 item correction revision guard", () => {
  it("records name and amount corrections once, rejects stale writes, and hides foreign scans", async () => {
    const scan = await makeEditableScan({});
    const item = scan.items[0]!;
    const patched = await request(app)
      .patch(`${RECEIPTS}/${scan.id}/items/${item.id}`)
      .set(...auth("owner-token"))
      .send({ name: "Premium rice", amount: 120.5, expectedScanRevision: 0 });

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ scanRevision: 1 });
    expect(patched.body).not.toHaveProperty("imageFile");
    expect(patched.body.items[0]).toMatchObject({
      name: "Premium rice",
      amount: 120.5,
      ownerEditedFields: expect.arrayContaining(["name", "amount"]),
    });

    const corrections = await prisma.receiptFieldCorrection.findMany({
      where: { receiptScanId: scan.id },
      orderBy: { field: "asc" },
    });
    expect(corrections.map((correction) => ({
      field: correction.field,
      source: correction.source,
      originalValue: correction.originalValue,
      finalValue: correction.finalValue,
      lineNumber: correction.lineNumber,
    }))).toEqual([
      { field: "itemAmount", source: "ocr", originalValue: "100.00", finalValue: "120.50", lineNumber: 1 },
      { field: "itemName", source: "ocr", originalValue: "Rice", finalValue: "Premium rice", lineNumber: 1 },
    ]);

    const stale = await request(app)
      .patch(`${RECEIPTS}/${scan.id}/items/${item.id}`)
      .set(...auth("owner-token"))
      .send({ name: "Stale overwrite", amount: 1, expectedScanRevision: 0 });
    expect(stale.status).toBe(409);

    const foreign = await request(app)
      .patch(`${RECEIPTS}/${scan.id}/items/${item.id}`)
      .set(...auth("other-token"))
      .send({ name: "Foreign overwrite", amount: 1, expectedScanRevision: 1 });
    expect(foreign.status).toBe(404);

    const stored = await prisma.receiptScan.findUniqueOrThrow({
      where: { id: scan.id },
      include: { items: true, corrections: true },
    });
    expect(stored.scanRevision).toBe(1);
    expect(stored.items[0]).toMatchObject({ name: "Premium rice" });
    expect(Number(stored.items[0]!.amount)).toBe(120.5);
    expect(stored.corrections).toHaveLength(2);
  });

  it("allows either confirm or edit to win a race, but never commits both", async () => {
    const scan = await makeEditableScan({});
    const item = scan.items[0]!;
    const [edit, confirm] = await Promise.all([
      request(app)
        .patch(`${RECEIPTS}/${scan.id}/items/${item.id}`)
        .set(...auth("owner-token"))
        .send({ name: "Edited rice", amount: 120, expectedScanRevision: 0 }),
      request(app)
        .post(`${RECEIPTS}/${scan.id}/confirm`)
        .set(...auth("owner-token"))
        .send({
          expectedScanRevision: 0,
          date: "2026-09-13",
          description: "Rice purchase",
          amount: 100,
          splits: [{ categoryId: owner.categories.Inventory, amount: 100 }],
        }),
    ]);

    expect([edit.status, confirm.status].filter((status) => status === 409)).toHaveLength(1);
    expect([edit.status, confirm.status].filter((status) => status === 200 || status === 201)).toHaveLength(1);

    const stored = await prisma.receiptScan.findUniqueOrThrow({
      where: { id: scan.id },
      include: { items: true },
    });
    if (stored.confirmationStatus === "Confirmed") {
      expect(stored.scanRevision).toBe(0);
      expect(stored.items[0]!.name).toBe("Rice");
      expect(await prisma.expenseRecord.count({ where: { receiptScanId: scan.id } })).toBe(1);
    } else {
      expect(stored.scanRevision).toBe(1);
      expect(stored.items[0]!.name).toBe("Edited rice");
      expect(await prisma.expenseRecord.count({ where: { receiptScanId: scan.id } })).toBe(0);
    }
  });
});

describe("Phase 2 worker and whole-scan retry", () => {
  it("serializes simultaneous child completions into the final stored batch status", async () => {
    const batch = await makeBatch(2, "PROCESSING");
    const scans = await Promise.all([1, 2].map((receiptOrdinal) => prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        captureBatchId: batch.id,
        receiptOrdinal,
        imageFile: `${owner.profile.id}/concurrent-${receiptOrdinal}.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        processingWorkerId: `phase2-worker-${receiptOrdinal}`,
        processingAttemptCount: 1,
        processingHeartbeatAt: new Date(),
        pages: {
          create: [{
            pageNumber: 1,
            imageFile: `${owner.profile.id}/concurrent-${receiptOrdinal}.jpg`,
          }],
        },
      },
    })));

    await Promise.all(scans.map((scan, index) => persistReceiptProcessingOutput(
      scan.id,
      owner.profile.id,
      { workerId: `phase2-worker-${index + 1}`, attempt: 1 },
      {
        scan: { rawText: `TOTAL ${index + 1}.00`, extractedAmount: index + 1 },
        pages: [{ pageNumber: 1, data: { rawText: `TOTAL ${index + 1}.00` } }],
        items: {
          parsedItems: [],
          vendor: null,
          extractedByVision: false,
          amountConfidences: [],
          itemEvidence: [],
        },
      },
    )));

    expect((await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("READY_FOR_REVIEW");
    expect(await prisma.receiptScan.count({
      where: { captureBatchId: batch.id, processingStatus: "Complete" },
    })).toBe(2);
  });

  it("serializes simultaneous child confirmations into the final stored batch status", async () => {
    const batch = await makeBatch(2, "PROCESSING");
    const first = await makeEditableScan({ captureBatchId: batch.id, receiptOrdinal: 1 });
    const second = await makeEditableScan({ captureBatchId: batch.id, receiptOrdinal: 2 });
    await prisma.receiptCaptureBatch.update({
      where: { id: batch.id },
      data: { status: "READY_FOR_REVIEW" },
    });

    const [left, right] = await Promise.all([
      request(app)
        .post(`${RECEIPTS}/${first.id}/confirm`)
        .set(...auth("owner-token"))
        .send({
          expectedScanRevision: 0,
          date: "2026-09-13",
          vendor: "First Merchant",
          description: "First receipt",
          amount: 100,
          splits: [{ categoryId: owner.categories.Inventory, amount: 100 }],
        }),
      request(app)
        .post(`${RECEIPTS}/${second.id}/confirm`)
        .set(...auth("owner-token"))
        .send({
          expectedScanRevision: 0,
          date: "2026-09-13",
          vendor: "Second Merchant",
          description: "Second receipt",
          amount: 200,
          splits: [{ categoryId: owner.categories.Inventory, amount: 200 }],
        }),
    ]);

    expect([left.status, right.status]).toEqual([201, 201]);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "COMPLETE",
      finishedAt: expect.any(Date),
    });
  });

  it("persists a ready batch status in the same successful worker transaction", async () => {
    const batch = await makeBatch(2, "PROCESSING");
    await makeEditableScan({ captureBatchId: batch.id, receiptOrdinal: 1 });
    const working = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        captureBatchId: batch.id,
        receiptOrdinal: 2,
        imageFile: `${owner.profile.id}/worker-source.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        processingWorkerId: "phase2-test-worker",
        processingAttemptCount: 1,
        processingHeartbeatAt: new Date(),
        pages: { create: [{ pageNumber: 1, imageFile: `${owner.profile.id}/worker-source.jpg` }] },
      },
    });

    await persistReceiptProcessingOutput(
      working.id,
      owner.profile.id,
      { workerId: "phase2-test-worker", attempt: 1 },
      {
        scan: { rawText: "TOTAL 100.00", extractedAmount: 100 },
        pages: [{ pageNumber: 1, data: { rawText: "TOTAL 100.00" } }],
        items: {
          parsedItems: [],
          vendor: null,
          extractedByVision: false,
          amountConfidences: [],
          itemEvidence: [],
        },
      },
    );

    expect((await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("READY_FOR_REVIEW");
  });

  it("persists a partial-failure batch state when the worker exhausts stored-evidence retries", async () => {
    const batch = await makeBatch(2, "PROCESSING");
    await makeEditableScan({ captureBatchId: batch.id, receiptOrdinal: 1 });
    const failing = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        captureBatchId: batch.id,
        receiptOrdinal: 2,
        imageFile: `${owner.profile.id}/unavailable.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        nextProcessingAttemptAt: new Date(0),
        pages: { create: [{ pageNumber: 1, imageFile: `${owner.profile.id}/unavailable.jpg` }] },
      },
    });
    storage.inspectReceiptImage.mockRejectedValue(new Error("storage outage"));

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await runReceiptWorkerOnce()).toBe(true);
      const state = await prisma.receiptScan.findUniqueOrThrow({ where: { id: failing.id } });
      expect(state.processingAttemptCount).toBe(attempt);
      if (attempt < 3) {
        expect(state.processingStatus).toBe("Processing");
        expect((await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("PROCESSING");
        await prisma.receiptScan.update({
          where: { id: failing.id },
          data: { nextProcessingAttemptAt: new Date(0) },
        });
      }
    }

    const terminal = await prisma.receiptScan.findUniqueOrThrow({ where: { id: failing.id } });
    expect(terminal).toMatchObject({
      processingStatus: "Failed",
      processingErrorCode: "RECEIPT_EVIDENCE_UNAVAILABLE",
    });
    expect((await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("PARTIAL_FAILURE");
  });

  it("retries the same scan from stored page paths once and never uploads again", async () => {
    const batch = await makeBatch(2, "PARTIAL_FAILURE");
    await makeEditableScan({ captureBatchId: batch.id, receiptOrdinal: 1 });
    const failed = await makeEditableScan({
      captureBatchId: batch.id,
      receiptOrdinal: 2,
      status: "Failed",
      path: `${owner.profile.id}/failed-source.jpg`,
    });
    await prisma.receiptScan.update({
      where: { id: failed.id },
      data: {
        processingAttemptCount: 3,
        processingError: "The receipt could not be read.",
        processingErrorCode: "RECEIPT_PROCESSING_FAILED",
      },
    });

    const foreign = await request(app)
      .post(`${RECEIPTS}/${failed.id}/retry`)
      .set(...auth("other-token"));
    expect(foreign.status).toBe(404);

    const [first, second] = await Promise.all([
      request(app).post(`${RECEIPTS}/${failed.id}/retry`).set(...auth("owner-token")),
      request(app).post(`${RECEIPTS}/${failed.id}/retry`).set(...auth("owner-token")),
    ]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);

    const stored = await prisma.receiptScan.findUniqueOrThrow({
      where: { id: failed.id },
      include: { pages: true },
    });
    expect(stored).toMatchObject({
      id: failed.id,
      processingStatus: "Processing",
      processingAttemptCount: 0,
      processingError: null,
      processingErrorCode: null,
    });
    expect(stored.pages).toHaveLength(1);
    expect(stored.pages[0]).toMatchObject({
      imageFile: `${owner.profile.id}/failed-source.jpg`,
      processedImageFile: `${owner.profile.id}/editable-derived.jpg`,
    });
    expect(storage.uploadReceiptImage).not.toHaveBeenCalled();
    expect(storage.deleteReceiptImage).not.toHaveBeenCalled();
    expect((await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("PROCESSING");

    const accepted = [first, second].find((response) => response.status === 202)!;
    expect(accepted.body.id).toBe(failed.id);
    expect(accepted.body).not.toHaveProperty("imageFile");
    expect(JSON.stringify(accepted.body)).not.toMatch(/failed-source|editable-derived/);
  });

  it("deletes a linked scan before the profile cascade removes its capture batch", async () => {
    const batch = await makeBatch(2);
    const scan = await makeEditableScan({
      captureBatchId: batch.id,
      receiptOrdinal: 1,
      confirmationStatus: "Confirmed",
    });
    await prisma.user.update({
      where: { id: owner.user.id },
      data: {
        status: AccountStatus.DELETION_PENDING,
        deletionRequestedAt: new Date(),
        deletionStage: AccountDeletionStage.REQUESTED,
      },
    });

    for (let pass = 0; pass < 3; pass++) {
      expect(await runAccountDeletionWorkerOnce()).toBe(true);
    }

    expect(await prisma.user.findUnique({ where: { id: owner.user.id } })).toBeNull();
    expect(await prisma.receiptScan.findUnique({ where: { id: scan.id } })).toBeNull();
    expect(await prisma.receiptCaptureBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: other.user.id } })).not.toBeNull();
  });

  it("refreshes a completed batch when orphan cleanup removes one linked scan", async () => {
    const finishedAt = new Date();
    const batch = await prisma.receiptCaptureBatch.create({
      data: {
        businessProfileId: owner.profile.id,
        clientBatchKey: "completed-batch-cleanup",
        expectedReceiptCount: 2,
        status: "COMPLETE",
        createdAt: new Date(finishedAt.getTime() - 1_000),
        finishedAt,
      },
    });
    const removed = await makeEditableScan({
      captureBatchId: batch.id,
      receiptOrdinal: 1,
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/cleanup-source.jpg`,
    });
    const retained = await makeEditableScan({
      captureBatchId: batch.id,
      receiptOrdinal: 2,
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/retained-source.jpg`,
    });

    await cleanUpReceiptScanIfOrphaned(removed.id);

    expect(await prisma.receiptScan.findUnique({ where: { id: removed.id } })).toMatchObject({
      confirmationStatus: "Deletion Pending",
    });
    expect(await prisma.receiptPurgeJob.findFirst({ where: { receiptScanId: removed.id } })).toMatchObject({
      mode: "DELETE_SCAN",
      status: "PENDING",
      stage: "STORAGE",
    });
    expect(storage.deleteReceiptImage).not.toHaveBeenCalled();
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);

    expect(await prisma.receiptScan.findUnique({ where: { id: removed.id } })).toBeNull();
    expect(await prisma.receiptScan.findUnique({ where: { id: retained.id } })).not.toBeNull();
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "CANCELLED",
      finishedAt: expect.any(Date),
    });
    expect(storage.deleteReceiptImage).toHaveBeenCalledWith(`${owner.profile.id}/cleanup-source.jpg`);
    expect(storage.deleteReceiptImage).toHaveBeenCalledWith(`${owner.profile.id}/editable-derived.jpg`);
  });
});

describe("Phase 2 durable receipt purge", () => {
  it("cancels a linked capture batch before deleting a child and rejects new slots", async () => {
    const batch = await makeBatch(2);
    const scan = await makeEditableScan({ captureBatchId: batch.id, receiptOrdinal: 1 });

    const accepted = await request(app)
      .delete(`${RECEIPTS}/${scan.id}`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "cancel-linked-batch");
    expect(accepted.status).toBe(202);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "CANCELLED",
      finishedAt: expect.any(Date),
    });

    const batchResult = await request(app)
      .get(`${BATCHES}/${batch.id}`)
      .set(...auth("owner-token"));
    expect(batchResult.status).toBe(200);
    expect(batchResult.body).toMatchObject({ status: "CANCELLED", finishedAt: expect.any(String) });

    const uploadsBefore = storage.uploadReceiptImage.mock.calls.length;
    await expect(uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "cancelled-batch-new-slot",
      receiptBatchId: batch.id,
      receiptOrdinal: 2,
      pages: [page("cancelled")],
    })).rejects.toMatchObject({ status: 409 });
    expect(storage.uploadReceiptImage).toHaveBeenCalledTimes(uploadsBefore);

    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "CANCELLED",
      finishedAt: expect.any(Date),
    });
    const afterPurge = await request(app)
      .get(`${BATCHES}/${batch.id}`)
      .set(...auth("owner-token"));
    expect(afterPurge.status).toBe(200);
    expect(afterPurge.body).toMatchObject({ status: "CANCELLED", finishedAt: expect.any(String) });
  });

  it("tombstones an unconfirmed scan, retries Storage safely, and preserves exact replay after deletion", async () => {
    const scan = await makeEditableScan({ path: `${owner.profile.id}/purge-source.jpg` });
    const another = await makeEditableScan({ path: `${owner.profile.id}/another-source.jpg` });

    const foreign = await request(app)
      .delete(`${RECEIPTS}/${scan.id}`)
      .set(...auth("other-token"))
      .set("Idempotency-Key", "foreign-delete-key");
    expect(foreign.status).toBe(404);

    const missingKey = await request(app)
      .delete(`${RECEIPTS}/${scan.id}`)
      .set(...auth("owner-token"));
    expect(missingKey.status).toBe(400);

    const [accepted, concurrentReplay] = await Promise.all([
      request(app)
        .delete(`${RECEIPTS}/${scan.id}`)
        .set(...auth("owner-token"))
        .set("Idempotency-Key", "delete-unconfirmed-scan"),
      request(app)
        .delete(`${RECEIPTS}/${scan.id}`)
        .set(...auth("owner-token"))
        .set("Idempotency-Key", "delete-unconfirmed-scan"),
    ]);
    expect(accepted.status).toBe(202);
    expect(concurrentReplay.status).toBe(202);
    expect(concurrentReplay.body.id).toBe(accepted.body.id);
    expect(accepted.body).toMatchObject({
      receiptScanId: scan.id,
      mode: "DELETE_SCAN",
      status: "PENDING",
      stage: "STORAGE",
      storageObjectsExpected: 2,
      storageObjectsDeleted: 0,
    });
    expect(JSON.stringify(accepted.body)).not.toMatch(/purge-source|editable-derived|imageFile|rawText/);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Deletion Pending",
      processingStatus: "Failed",
      scanRevision: 1,
    });

    const hidden = await request(app)
      .get(`${RECEIPTS}/${scan.id}`)
      .set(...auth("owner-token"));
    expect(hidden.status).toBe(404);

    storage.deleteReceiptImage.mockResolvedValueOnce(false);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    const retrying = await prisma.receiptPurgeJob.findUniqueOrThrow({ where: { id: accepted.body.id } });
    expect(retrying).toMatchObject({
      status: "RETRY",
      stage: "STORAGE",
      storageObjectsDeleted: 0,
      lastErrorCode: "PURGE_STORAGE_DELETE_FAILED",
    });
    expect(await prisma.receiptScan.findUnique({ where: { id: scan.id } })).not.toBeNull();

    await prisma.receiptPurgeJob.update({
      where: { id: retrying.id },
      data: { nextAttemptAt: new Date(0) },
    });
    storage.deleteReceiptImage.mockResolvedValue(true);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await prisma.receiptPurgeJob.findUniqueOrThrow({ where: { id: retrying.id } })).toMatchObject({
      status: "PENDING",
      stage: "DATABASE",
      storageObjectsDeleted: 2,
    });
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await prisma.receiptScan.findUnique({ where: { id: scan.id } })).toBeNull();

    const replay = await request(app)
      .delete(`${RECEIPTS}/${scan.id}`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "delete-unconfirmed-scan");
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      id: accepted.body.id,
      receiptScanId: scan.id,
      mode: "DELETE_SCAN",
      status: "COMPLETE",
      stage: "COMPLETE",
    });

    const reusedKey = await request(app)
      .delete(`${RECEIPTS}/${another.id}`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "delete-unconfirmed-scan");
    expect(reusedKey.status).toBe(409);
  });

  it("detaches confirmed evidence while retaining the receipt audit and financial records", async () => {
    const scan = await makeEditableScan({
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/confirmed-source.jpg`,
    });
    const record = await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        receiptScanId: scan.id,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: "Owner-confirmed rice",
        vendor: "Confirmed Merchant",
        amount: 100,
        source: "RECEIPT_SCAN",
      },
    });
    await prisma.receiptScanItem.update({
      where: { id: scan.items[0]!.id },
      data: { expenseRecordId: record.id, categoryId: owner.categories.Inventory },
    });
    await prisma.receiptFieldCorrection.create({
      data: {
        receiptScanId: scan.id,
        field: "vendor",
        source: "ocr",
        originalValue: "OCR Merchant",
        finalValue: "Confirmed Merchant",
        wasEdited: true,
      },
    });
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: {
        rawText: "PRIVATE RAW OCR",
        fieldEvidence: { vendor: { pageNumber: 1, text: "PRIVATE OCR MERCHANT" } },
        warnings: [{
          code: "AMBIGUOUS_DATE",
          field: "date",
          detail: "PRIVATE DATE SOURCE 09/10/26",
        }],
        receiptLikelihood: {
          version: "receipt-likelihood-v1",
          score: 75,
          outcome: "likely-receipt",
          signals: { textLines: 4, moneyPatterns: 2 },
        },
      },
    });

    const wholeScan = await request(app)
      .delete(`${RECEIPTS}/${scan.id}`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "wrong-confirmed-delete");
    expect(wholeScan.status).toBe(409);

    const accepted = await request(app)
      .delete(`${RECEIPTS}/${scan.id}/images`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "detach-confirmed-evidence");
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({
      receiptScanId: scan.id,
      mode: "DETACH_EVIDENCE",
      status: "PENDING",
      stage: "STORAGE",
    });
    expect(JSON.stringify(accepted.body)).not.toMatch(/confirmed-source|editable-derived|PRIVATE/);

    const pageDuringDeletion = await request(app)
      .get(`${RECEIPTS}/${scan.id}/pages/1/image/source`)
      .set(...auth("owner-token"));
    expect(pageDuringDeletion.status).toBe(404);
    const recordDuringDeletion = await request(app)
      .get(`/api/v1/records/expenses/${record.id}`)
      .set(...auth("owner-token"));
    expect(recordDuringDeletion.status).toBe(200);
    expect(recordDuringDeletion.body.origin).toMatchObject({
      kind: "receipt_scan",
      scanId: scan.id,
      imageUrl: null,
    });
    expect(storage.signedReceiptImageUrl).not.toHaveBeenCalled();

    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);

    const retained = await prisma.receiptScan.findUniqueOrThrow({
      where: { id: scan.id },
      include: { pages: true, items: true, corrections: true, expenseRecords: true },
    });
    expect(retained).toMatchObject({
      id: scan.id,
      imageFile: null,
      rawText: null,
      fieldEvidence: null,
      warnings: null,
      extractedDate: new Date("2026-09-13T00:00:00.000Z"),
      extractedVendor: "Owner Store",
      extractedDescription: "Rice purchase",
      confirmationStatus: "Confirmed",
      scanRevision: 2,
    });
    expect(retained.evidenceDeletionRequestedAt).not.toBeNull();
    expect(retained.evidenceDeletedAt).not.toBeNull();
    expect(retained.receiptLikelihood).toMatchObject({
      version: "receipt-likelihood-v1",
      score: 75,
      outcome: "likely-receipt",
    });
    expect(retained.pages).toHaveLength(0);
    expect(retained.items).toHaveLength(0);
    expect(retained.corrections).toHaveLength(0);
    expect(retained.expenseRecords.map((expense) => expense.id)).toEqual([record.id]);

    const replay = await request(app)
      .delete(`${RECEIPTS}/${scan.id}/images`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "detach-confirmed-evidence");
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      id: accepted.body.id,
      receiptScanId: scan.id,
      mode: "DETACH_EVIDENCE",
      status: "COMPLETE",
    });

    const safeResult = await request(app)
      .get(`${RECEIPTS}/${scan.id}`)
      .set(...auth("owner-token"));
    expect(safeResult.status).toBe(200);
    expect(safeResult.body).toMatchObject({ id: scan.id, evidenceDeletedAt: expect.any(String) });
    expect(JSON.stringify(safeResult.body)).not.toMatch(/imageFile|rawText|PRIVATE|confirmed-source/);
  });

  it("expires only terminal purge results and preserves expired active work", async () => {
    const now = new Date();
    const requestedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000);
    const completedAt = new Date(now.getTime() - 36 * 60 * 60 * 1_000);
    const expiredAt = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const futureAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const [pendingScan, retryScan, processingScan] = await Promise.all([
      makeEditableScan({ path: `${owner.profile.id}/ttl-pending.jpg` }),
      makeEditableScan({ path: `${owner.profile.id}/ttl-retry.jpg` }),
      makeEditableScan({ path: `${owner.profile.id}/ttl-processing.jpg` }),
    ]);
    const common = {
      businessProfileId: owner.profile.id,
      reason: "OWNER_REQUEST" as const,
      mode: "DELETE_SCAN" as const,
      requestedAt,
      expiresAt: expiredAt,
    };

    const [complete, failed, freshComplete, pending, retry, processing] = await Promise.all([
      prisma.receiptPurgeJob.create({
        data: {
          ...common,
          requestKeyHash: "1".repeat(64),
          targetReferenceHash: "a".repeat(64),
          status: "COMPLETE",
          stage: "COMPLETE",
          completedAt,
        },
      }),
      prisma.receiptPurgeJob.create({
        data: {
          ...common,
          requestKeyHash: "2".repeat(64),
          targetReferenceHash: "b".repeat(64),
          status: "FAILED",
          stage: "STORAGE",
          lastErrorCode: "PURGE_STORAGE_FAILED",
        },
      }),
      prisma.receiptPurgeJob.create({
        data: {
          ...common,
          requestKeyHash: "3".repeat(64),
          targetReferenceHash: "c".repeat(64),
          status: "COMPLETE",
          stage: "COMPLETE",
          completedAt,
          expiresAt: futureAt,
        },
      }),
      prisma.receiptPurgeJob.create({
        data: {
          ...common,
          receiptScanId: pendingScan.id,
          receiptScanBusinessProfileId: owner.profile.id,
          requestKeyHash: "4".repeat(64),
          targetReferenceHash: "d".repeat(64),
          status: "PENDING",
          stage: "STORAGE",
          nextAttemptAt: futureAt,
        },
      }),
      prisma.receiptPurgeJob.create({
        data: {
          ...common,
          receiptScanId: retryScan.id,
          receiptScanBusinessProfileId: owner.profile.id,
          requestKeyHash: "5".repeat(64),
          targetReferenceHash: "e".repeat(64),
          status: "RETRY",
          stage: "STORAGE",
          nextAttemptAt: futureAt,
        },
      }),
      prisma.receiptPurgeJob.create({
        data: {
          ...common,
          receiptScanId: processingScan.id,
          receiptScanBusinessProfileId: owner.profile.id,
          requestKeyHash: "6".repeat(64),
          targetReferenceHash: "f".repeat(64),
          status: "PROCESSING",
          stage: "STORAGE",
          nextAttemptAt: futureAt,
          leaseStartedAt: now,
          heartbeatAt: now,
          workerId: "ttl-active-worker",
        },
      }),
    ]);

    expect(await runReceiptPurgeWorkerOnce()).toBe(false);

    const retainedIds = (await prisma.receiptPurgeJob.findMany({
      where: { id: { in: [complete.id, failed.id, freshComplete.id, pending.id, retry.id, processing.id] } },
      select: { id: true },
    })).map((job) => job.id);
    expect(retainedIds).not.toContain(complete.id);
    expect(retainedIds).not.toContain(failed.id);
    expect(retainedIds).toEqual(expect.arrayContaining([
      freshComplete.id,
      pending.id,
      retry.id,
      processing.id,
    ]));
    expect(storage.deleteReceiptImage).not.toHaveBeenCalled();
  });
});

describe("Phase 2 pre-save duplicate review", () => {
  function confirmBody(description = "Corrected receipt description") {
    return {
      expectedScanRevision: 0,
      date: "2026-09-13",
      vendor: "Final Merchant",
      description,
      amount: 100,
      splits: [{ categoryId: owner.categories.Inventory, amount: 100 }],
    };
  }

  it("returns profile-scoped final-value candidates and requires a current Save anyway decision", async () => {
    const prior = await makeEditableScan({
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/prior-source.jpg`,
    });
    await prisma.receiptScan.update({
      where: { id: prior.id },
      data: {
        extractedDate: new Date("2026-09-10T00:00:00.000Z"),
        extractedVendor: "OCR Merchant",
        extractedDescription: "Uncorrected OCR text",
        extractedAmount: 999,
      },
    });
    for (const [description, amount] of [["Rice", 60], ["Cooking oil", 40]] as const) {
      await prisma.expenseRecord.create({
        data: {
          businessProfileId: owner.profile.id,
          categoryId: owner.categories.Inventory,
          receiptScanId: prior.id,
          date: new Date("2026-09-13T00:00:00.000Z"),
          description,
          vendor: "Final Merchant",
          amount,
          source: "RECEIPT_SCAN",
        },
      });
    }

    const foreignPrior = await makeEditableScan({
      businessProfileId: other.profile.id,
      confirmationStatus: "Confirmed",
      path: `${other.profile.id}/foreign-prior.jpg`,
    });
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: other.profile.id,
        categoryId: other.categories.Inventory,
        receiptScanId: foreignPrior.id,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: "Foreign record",
        vendor: "Final Merchant",
        amount: 100,
        source: "RECEIPT_SCAN",
      },
    });

    const source = await makeEditableScan({ path: `${owner.profile.id}/source-review.jpg` });
    await prisma.receiptScan.update({
      where: { id: source.id },
      data: { extractedVendor: "Final Merchant", extractedDescription: "OCR source", extractedAmount: 100 },
    });
    await prisma.$transaction((tx) =>
      refreshReceiptDuplicateCandidatesForScan(tx, source.id, owner.profile.id),
    );

    const countBeforeRead = await prisma.receiptDuplicateCandidate.count();
    const candidates = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .set(...auth("owner-token"));
    expect(candidates.status).toBe(200);
    expect(candidates.body).toMatchObject({
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidateSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidateCount: 1,
      candidatesTruncated: false,
      nextCursor: null,
      candidates: [{
        target: { kind: "receipt", id: prior.id },
        vendor: "Final Merchant",
        date: "2026-09-13T00:00:00.000Z",
        total: 100,
        scoreBand: "EXACT",
        reasons: expect.arrayContaining(["SAME_VENDOR", "SAME_DATE", "SAME_TOTAL"]),
      }],
    });
    expect(await prisma.receiptDuplicateCandidate.count()).toBe(countBeforeRead);
    expect(candidates.body.candidates[0].reasons).not.toContain("SAME_DESCRIPTION");

    const foreignRead = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .set(...auth("other-token"));
    expect(foreignRead.status).toBe(404);

    const firstConfirm = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send(confirmBody());
    expect(firstConfirm.status).toBe(409);
    expect(firstConfirm.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidateSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidates: [{ target: { kind: "receipt", id: prior.id }, total: 100 }],
    });
    expect(await prisma.expenseRecord.count({ where: { receiptScanId: source.id } })).toBe(0);
    expect(await prisma.receiptDuplicateCandidate.count({
      where: { sourceReceiptScanId: source.id, reviewStatus: "PENDING" },
    })).toBe(1);

    const manual = await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: "Manual duplicate",
        vendor: "Final Merchant",
        amount: 100,
        source: "MANUAL_ENTRY",
      },
    });
    const changed = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        ...confirmBody(),
        duplicateDecision: {
          action: "SAVE_ANYWAY",
          candidateSetHash: firstConfirm.body.candidateSetHash,
        },
      });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({
      code: "DUPLICATE_REVIEW_CHANGED",
      candidateSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(changed.body.candidateSetHash).not.toBe(firstConfirm.body.candidateSetHash);
    expect(new Set(changed.body.candidates.map((candidate: { target: { id: number } }) => candidate.target.id))).toEqual(
      new Set([prior.id, manual.id]),
    );
    expect(await prisma.expenseRecord.count({ where: { receiptScanId: source.id } })).toBe(0);

    const saved = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        ...confirmBody(),
        duplicateDecision: {
          action: "SAVE_ANYWAY",
          candidateSetHash: changed.body.candidateSetHash,
        },
      });
    expect(saved.status).toBe(201);
    expect(saved.body).toHaveLength(1);
    expect(await prisma.receiptDuplicateCandidate.count({
      where: {
        sourceReceiptScanId: source.id,
        reviewStatus: "SAVED_ANYWAY",
        decisionSetHash: changed.body.candidateSetHash,
        decidedByUserId: owner.user.id,
      },
    })).toBe(2);
    const storedSource = await prisma.receiptScan.findUniqueOrThrow({ where: { id: source.id } });
    expect(storedSource).toMatchObject({
      confirmationStatus: "Confirmed",
      extractedVendor: "Final Merchant",
      extractedDescription: "Corrected receipt description",
      semanticFingerprint: changed.body.sourceFingerprint,
    });
    expect(Number(storedSource.extractedAmount)).toBe(100);
  });

  it("caps a confirm response while its hash and Save anyway decision cover the full candidate set", async () => {
    await prisma.expenseRecord.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: `Prior manual expense ${index + 1}`,
        vendor: "Cap Merchant",
        amount: 333,
        source: "MANUAL_ENTRY" as const,
      })),
    });
    const source = await makeEditableScan({ path: `${owner.profile.id}/capped-source.jpg` });
    const body = {
      expectedScanRevision: 0,
      date: "2026-09-13",
      vendor: "Cap Merchant",
      description: "Capped duplicate review",
      amount: 333,
      splits: [{ categoryId: owner.categories.Inventory, amount: 333 }],
    };

    const review = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send(body);
    expect(review.status).toBe(409);
    expect(review.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      candidateCount: 25,
      candidatesTruncated: true,
      nextCursor: expect.any(String),
      candidateSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(review.body.candidates).toHaveLength(20);

    const firstPage = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .query({ take: 20 })
      .set(...auth("owner-token"));
    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toMatchObject({
      candidateSetHash: review.body.candidateSetHash,
      candidateCount: 25,
      candidatesTruncated: true,
      nextCursor: expect.any(String),
    });
    expect(firstPage.body.candidates).toHaveLength(20);

    const remainder = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .query({ cursor: firstPage.body.nextCursor, take: 20 })
      .set(...auth("owner-token"));
    expect(remainder.status).toBe(200);
    expect(remainder.body).toMatchObject({
      candidateSetHash: review.body.candidateSetHash,
      candidateCount: 25,
      candidatesTruncated: false,
      nextCursor: null,
    });
    expect(remainder.body.candidates).toHaveLength(5);

    const saved = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        ...body,
        duplicateDecision: {
          action: "SAVE_ANYWAY",
          candidateSetHash: review.body.candidateSetHash,
        },
      });
    expect(saved.status).toBe(201);
    expect(await prisma.receiptDuplicateCandidate.count({
      where: { sourceReceiptScanId: source.id, reviewStatus: "SAVED_ANYWAY" },
    })).toBe(25);
  });

  it("serializes matching confirmations so the second request reviews the first", async () => {
    const first = await makeEditableScan({ path: `${owner.profile.id}/race-first.jpg` });
    const second = await makeEditableScan({ path: `${owner.profile.id}/race-second.jpg` });
    const base = {
      expectedScanRevision: 0,
      date: "2026-09-13",
      vendor: "Race Merchant",
      amount: 100,
      splits: [{ categoryId: owner.categories.Inventory, amount: 100 }],
    };

    const [left, right] = await Promise.all([
      request(app)
        .post(`${RECEIPTS}/${first.id}/confirm`)
        .set(...auth("owner-token"))
        .send({ ...base, description: "First corrected description" }),
      request(app)
        .post(`${RECEIPTS}/${second.id}/confirm`)
        .set(...auth("owner-token"))
        .send({ ...base, description: "Second corrected description" }),
    ]);

    const statuses = [left.status, right.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const review = [left, right].find((response) => response.status === 409)!;
    expect(review.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      candidateSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidates: [{
        target: { kind: "receipt" },
        vendor: "Race Merchant",
        total: 100,
        reasons: expect.arrayContaining(["SAME_VENDOR", "SAME_DATE", "SAME_TOTAL"]),
      }],
    });
    expect(await prisma.expenseRecord.count({
      where: { receiptScanId: { in: [first.id, second.id] } },
    })).toBe(1);
    expect(await prisma.receiptScan.count({
      where: { id: { in: [first.id, second.id] }, confirmationStatus: "Confirmed" },
    })).toBe(1);
  });

  it("rechecks manual and CSV expenses only after their shared write gate commits", async () => {
    async function holdWriterUntilReceiptWaits(
      write: (tx: Prisma.TransactionClient) => Promise<{ id: number }>,
      source: Awaited<ReturnType<typeof makeEditableScan>>,
      body: ReturnType<typeof confirmBody>,
    ) {
      let inserted!: (record: { id: number }) => void;
      const insertedRecord = new Promise<{ id: number }>((resolve) => {
        inserted = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = prisma.$transaction(async (tx) => {
        const record = await write(tx);
        inserted(record);
        await held;
        return record;
      }, { timeout: 10_000, maxWait: 5_000 });

      const pendingRecord = await insertedRecord;
      const confirmation = request(app)
        .post(`${RECEIPTS}/${source.id}/confirm`)
        .set(...auth("owner-token"))
        .send(body)
        .then((response) => response);
      await waitForProfileAdvisoryWaiter(owner.profile.id);
      release();
      const [record, response] = await Promise.all([writer, confirmation]);
      expect(record.id).toBe(pendingRecord.id);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: "DUPLICATE_REVIEW_REQUIRED",
        candidates: [{ target: { kind: "expense", id: record.id } }],
      });
    }

    const manualSource = await makeEditableScan({ path: `${owner.profile.id}/manual-race-source.jpg` });
    const manualBody = {
      ...confirmBody("Manual race expense"),
      vendor: "Manual Race Merchant",
      amount: 451,
      splits: [{ categoryId: owner.categories.Inventory, amount: 451 }],
    };
    await holdWriterUntilReceiptWaits(
      async (tx) => {
        const { record } = await createExpenseRecordWithin(
          owner.user.id,
          {
            businessProfileId: owner.profile.id,
            categoryId: owner.categories.Inventory,
            date: manualBody.date,
            description: manualBody.description,
            vendor: manualBody.vendor,
            amount: manualBody.amount,
          },
          tx,
          { serializeDuplicateCheck: true },
        );
        return record;
      },
      manualSource,
      manualBody,
    );

    const importBatch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: owner.profile.id,
        title: "Duplicate gate race.csv",
        uploadDate: new Date("2026-09-13T00:00:00.000Z"),
      },
    });
    const csvSource = await makeEditableScan({ path: `${owner.profile.id}/csv-race-source.jpg` });
    const csvBody = {
      ...confirmBody("CSV race expense"),
      vendor: "CSV Race Merchant",
      amount: 452,
      splits: [{ categoryId: owner.categories.Inventory, amount: 452 }],
    };
    await holdWriterUntilReceiptWaits(
      async (tx) => {
        const [record] = await bulkCreateExpenseRecords(
          owner.user.id,
          owner.profile,
          importBatch.id,
          [{
            categoryId: owner.categories.Inventory,
            date: csvBody.date,
            description: csvBody.description,
            vendor: csvBody.vendor,
            amount: csvBody.amount,
          }],
          tx,
        );
        return record!;
      },
      csvSource,
      csvBody,
    );

    expect(await prisma.expenseRecord.count({
      where: { receiptScanId: { in: [manualSource.id, csvSource.id] } },
    })).toBe(0);
  });

  it("flags vendor-only manual, CSV, and value-edit followers after a concurrent receipt commits first", async () => {
    async function runReceiptFirst(
      source: Awaited<ReturnType<typeof makeEditableScan>>,
      body: ReturnType<typeof confirmBody>,
      writeFollower: () => Promise<{
        id: number;
        duplicateStatus: string;
        duplicateOfRecordId: number | null;
      }>,
    ) {
      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      let releaseLock!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = prisma.$transaction(async (tx) => {
        await lockDuplicateKey(tx, owner.profile.id, `receipt-source:${source.id}`);
        lockReady();
        await held;
      }, { timeout: 10_000, maxWait: 5_000 });
      await ready;

      const confirmation = request(app)
        .post(`${RECEIPTS}/${source.id}/confirm`)
        .set(...auth("owner-token"))
        .send(body)
        .then((response) => response);
      await waitForProfileAdvisoryWaiter(owner.profile.id);
      const follower = writeFollower();
      await waitForProfileAdvisoryWaiter(owner.profile.id, 2);
      releaseLock();

      const [confirmed, followed] = await Promise.all([confirmation, follower]);
      await blocker;
      expect(confirmed.status).toBe(201);
      expect(confirmed.body).toHaveLength(1);
      expect(followed).toMatchObject({
        duplicateStatus: "Flagged",
        duplicateOfRecordId: confirmed.body[0].id,
      });
    }

    const manualSource = await makeEditableScan({ path: `${owner.profile.id}/receipt-first-manual.jpg` });
    const manualReceipt = {
      ...confirmBody("Receipt-side description"),
      vendor: "Shared Manual Vendor",
      amount: 611,
      splits: [{ categoryId: owner.categories.Inventory, amount: 611 }],
    };
    await runReceiptFirst(
      manualSource,
      manualReceipt,
      () => createExpenseRecord(owner.user.id, {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        date: manualReceipt.date,
        description: "Different manual description",
        vendor: manualReceipt.vendor,
        amount: manualReceipt.amount,
      }),
    );

    const importBatch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: owner.profile.id,
        title: "Receipt-first duplicate.csv",
        uploadDate: new Date("2026-09-13T00:00:00.000Z"),
      },
    });
    const csvSource = await makeEditableScan({ path: `${owner.profile.id}/receipt-first-csv.jpg` });
    const csvReceipt = {
      ...confirmBody("Receipt-side CSV description"),
      vendor: "Shared CSV Vendor",
      amount: 612,
      splits: [{ categoryId: owner.categories.Inventory, amount: 612 }],
    };
    await runReceiptFirst(
      csvSource,
      csvReceipt,
      () => prisma.$transaction(async (tx) => {
        const [record] = await bulkCreateExpenseRecords(
          owner.user.id,
          owner.profile,
          importBatch.id,
          [{
            categoryId: owner.categories.Inventory,
            date: csvReceipt.date,
            description: "Different CSV description",
            vendor: csvReceipt.vendor,
            amount: csvReceipt.amount,
          }],
          tx,
        );
        return record!;
      }, { timeout: 10_000, maxWait: 5_000 }),
    );

    const editedRecord = await createExpenseRecord(owner.user.id, {
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Inventory,
      date: "2026-09-12",
      description: "Original edit description",
      vendor: "Original edit vendor",
      amount: 613,
    });
    const editSource = await makeEditableScan({ path: `${owner.profile.id}/receipt-first-edit.jpg` });
    const editReceipt = {
      ...confirmBody("Receipt-side edit description"),
      vendor: "Shared Edit Vendor",
      amount: 613,
      splits: [{ categoryId: owner.categories.Inventory, amount: 613 }],
    };
    await runReceiptFirst(
      editSource,
      editReceipt,
      () => updateExpenseRecord(owner.user.id, editedRecord.id, {
        date: editReceipt.date,
        description: "Different edited description",
        vendor: editReceipt.vendor,
        amount: editReceipt.amount,
      }),
    );
  });

  it("matches vendor/description identities symmetrically in either source order", async () => {
    const candidateWithoutVendor = await makeEditableScan({
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/blank-vendor-candidate.jpg`,
    });
    await prisma.receiptScan.update({
      where: { id: candidateWithoutVendor.id },
      data: { extractedDescription: "Shared identity one", extractedAmount: 111 },
    });
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        receiptScanId: candidateWithoutVendor.id,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: "Shared identity one",
        vendor: null,
        amount: 111,
        source: "RECEIPT_SCAN",
      },
    });
    const sourceWithVendor = await makeEditableScan({ path: `${owner.profile.id}/present-vendor-source.jpg` });
    const presentToBlank = await request(app)
      .post(`${RECEIPTS}/${sourceWithVendor.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        expectedScanRevision: 0,
        date: "2026-09-13",
        vendor: "Present Merchant",
        description: "Shared identity one",
        amount: 111,
        splits: [{ categoryId: owner.categories.Inventory, amount: 111 }],
      });
    expect(presentToBlank.status).toBe(409);
    expect(presentToBlank.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      candidates: [{
        target: { kind: "receipt", id: candidateWithoutVendor.id },
        scoreBand: "LIKELY",
      }],
    });

    const candidateWithVendor = await makeEditableScan({
      confirmationStatus: "Confirmed",
      path: `${owner.profile.id}/present-vendor-candidate.jpg`,
    });
    await prisma.receiptScan.update({
      where: { id: candidateWithVendor.id },
      data: { extractedDescription: "Shared identity two", extractedAmount: 222 },
    });
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        receiptScanId: candidateWithVendor.id,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: "Shared identity two",
        vendor: "Present Merchant",
        amount: 222,
        source: "RECEIPT_SCAN",
      },
    });
    const sourceWithoutVendor = await makeEditableScan({ path: `${owner.profile.id}/blank-vendor-source.jpg` });
    const blankToPresent = await request(app)
      .post(`${RECEIPTS}/${sourceWithoutVendor.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        expectedScanRevision: 0,
        date: "2026-09-13",
        description: "Shared identity two",
        amount: 222,
        splits: [{ categoryId: owner.categories.Inventory, amount: 222 }],
      });
    expect(blankToPresent.status).toBe(409);
    expect(blankToPresent.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      candidates: [{
        target: { kind: "receipt", id: candidateWithVendor.id },
        scoreBand: "LIKELY",
      }],
    });
  });

  it("detects identical source bytes across standalone and batch uploads with different request metadata", async () => {
    const sourceBytes = Buffer.from("same original receipt pixels");
    const first = await uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "same-image-standalone",
      pages: [{
        ...page("standalone-name"),
        buffer: sourceBytes,
        metadata: { source: "gallery", processingMode: "original" },
      }],
    });
    const batch = await makeBatch(2);
    const second = await uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "same-image-batch",
      receiptBatchId: batch.id,
      receiptOrdinal: 1,
      pages: [{
        ...page("batch-name"),
        buffer: sourceBytes,
        metadata: { source: "manual-camera", processingMode: "manual-crop" },
        processed: page("different-derived-bytes"),
      }],
    });
    await prisma.receiptScan.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { processingStatus: "Complete" },
    });
    const persisted = await prisma.receiptScan.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { uploadHash: true, sourceImageHash: true },
      orderBy: { id: "asc" },
    });
    expect(persisted[0]!.sourceImageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted[1]!.sourceImageHash).toBe(persisted[0]!.sourceImageHash);
    expect(persisted[1]!.uploadHash).not.toBe(persisted[0]!.uploadHash);

    const [left, right] = await Promise.all([
      request(app)
        .post(`${RECEIPTS}/${first.id}/confirm`)
        .set(...auth("owner-token"))
        .send({
          expectedScanRevision: 0,
          date: "2026-09-12",
          vendor: "Alpha Merchant",
          description: "Alpha purchase",
          amount: 100,
          splits: [{ categoryId: owner.categories.Inventory, amount: 100 }],
        }),
      request(app)
        .post(`${RECEIPTS}/${second.id}/confirm`)
        .set(...auth("owner-token"))
        .send({
          expectedScanRevision: 0,
          date: "2026-09-13",
          vendor: "Beta Merchant",
          description: "Beta purchase",
          amount: 200,
          splits: [{ categoryId: owner.categories.Inventory, amount: 200 }],
        }),
    ]);

    expect([left.status, right.status].sort((a, b) => a - b)).toEqual([201, 409]);
    const review = [left, right].find((response) => response.status === 409)!;
    expect(review.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      candidates: [{
        target: { kind: "receipt" },
        reasons: expect.arrayContaining(["EXACT_IMAGE"]),
      }],
    });
    expect(await prisma.expenseRecord.count({
      where: { receiptScanId: { in: [first.id, second.id] } },
    })).toBe(1);
  });
});

describe("Phase 2 upload evidence dimensions", () => {
  it("uses display-oriented dimensions and rejects forged raw-axis metadata before storage", async () => {
    const rotated = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const accepted = await request(app)
      .post(RECEIPTS)
      .set(...auth("owner-token"))
      .field("businessProfileId", String(owner.profile.id))
      .field("captureMetadata", JSON.stringify([{
        processingMode: "original",
        originalWidth: 80,
        originalHeight: 120,
      }]))
      .attach("files", rotated, { filename: "rotated.jpg", contentType: "image/jpeg" });
    expect(accepted.status).toBe(202);

    const pageRow = await prisma.receiptScanPage.findFirstOrThrow({
      where: { receiptScanId: accepted.body.id },
    });
    expect(pageRow.captureMetadata).toMatchObject({ originalWidth: 80, originalHeight: 120 });
    expect(storage.uploadReceiptImage).toHaveBeenCalledTimes(1);

    const forged = await request(app)
      .post(RECEIPTS)
      .set(...auth("owner-token"))
      .field("businessProfileId", String(owner.profile.id))
      .field("captureMetadata", JSON.stringify([{
        processingMode: "original",
        originalWidth: 120,
        originalHeight: 80,
      }]))
      .attach("files", rotated, { filename: "forged-rotated.jpg", contentType: "image/jpeg" });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toMatch(/dimensions do not match/i);
    expect(storage.uploadReceiptImage).toHaveBeenCalledTimes(1);
    expect(await prisma.receiptScan.count()).toBe(1);
  });
});
