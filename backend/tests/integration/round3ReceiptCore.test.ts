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
        admin: { deleteUser: async () => ({ data: {}, error: null }) },
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

// The batch receipt limit and the per-scan page limit are both 8 today, which
// is the coincidence that hid the wrong constant. Lowering the batch limit
// below the page limit makes the two boundaries observable without exceeding
// the database's own 1..8 checks on batch size and ordinal.
vi.mock("../../src/services/receiptCaptureBatch.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/receiptCaptureBatch.service")>();
  return { ...actual, RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS: 4 };
});

import request from "supertest";
import sharp from "sharp";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { LIMITS, resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { uploadAndScan } from "../../src/services/receiptScan/queue";
import {
  RECEIPT_DUPLICATE_DETECTOR_VERSION,
  refreshReceiptDuplicateCandidatesForScan,
} from "../../src/services/receiptDuplicate.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const RECEIPTS = "/api/v1/records/receipts";
const auth = (token: string) => ["Authorization", `Bearer ${token}`] as const;

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  owner = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
  authByToken.clear();
  authByToken.set("owner-token", owner.user.authId);
  authByToken.set("other-token", other.user.authId);

  storage.sequence = 0;
  storage.uploadReceiptImage.mockReset().mockImplementation(async (businessProfileId: number) => (
    `${businessProfileId}/round3-${++storage.sequence}.jpg`
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

async function makeScan(input: {
  businessProfileId?: number;
  confirmationStatus?: "Pending" | "Confirmed";
  items?: { name: string; amount: number }[];
  extractedDate?: Date | null;
  extractedAmount?: number | null;
  semanticFingerprint?: string;
  path?: string;
}) {
  const businessProfileId = input.businessProfileId ?? owner.profile.id;
  const path = input.path ?? `${businessProfileId}/round3-source.jpg`;
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: path,
      extractedDate: input.extractedDate === undefined ? new Date("2026-09-13T00:00:00.000Z") : input.extractedDate,
      extractedVendor: "Owner Store",
      extractedDescription: "Rice purchase",
      extractedAmount: input.extractedAmount === undefined ? 100 : input.extractedAmount,
      semanticFingerprint: input.semanticFingerprint,
      processingStatus: "Complete",
      confirmationStatus: input.confirmationStatus ?? "Pending",
      pages: { create: [{ pageNumber: 1, imageFile: path }] },
      items: {
        create: (input.items ?? [{ name: "Rice", amount: 100 }]).map((item, index) => ({
          lineNumber: index + 1,
          name: item.name,
          amount: item.amount,
          amountConfidence: 82,
        })),
      },
    },
    include: { items: true, pages: true },
  });
}

describe("Round 3: receipt ordinal is bounded by the batch limit", () => {
  it("bounds the receipt position by the batch limit at both the controller and the service", async () => {
    // Created directly: the row is within the database's range, and the
    // batch controller's own limit is not what this test is about.
    const batch = await prisma.receiptCaptureBatch.create({
      data: {
        businessProfileId: owner.profile.id,
        clientBatchKey: "round3-five-receipts",
        expectedReceiptCount: 5,
        status: "COLLECTING",
      },
    });
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).jpeg().toBuffer();
    const upload = (ordinal: number) => request(app)
      .post(RECEIPTS)
      .set(...auth("owner-token"))
      .field("businessProfileId", String(owner.profile.id))
      .field("receiptBatchId", String(batch.id))
      .field("receiptOrdinal", String(ordinal))
      .attach("files", image, { filename: `receipt-${ordinal}.jpg`, contentType: "image/jpeg" });

    const withinBatchLimit = await upload(4);
    expect(withinBatchLimit.status).toBe(202);
    expect(withinBatchLimit.body).toMatchObject({ receiptOrdinal: 4 });

    // 5 is within the page limit (8) and within this batch's expected count,
    // so only the batch constant refuses it.
    const beyondBatchLimit = await upload(5);
    expect(beyondBatchLimit.status).toBe(400);
    await expect(uploadAndScan(owner.user.id, {
      businessProfileId: owner.profile.id,
      idempotencyKey: "round3-fifth-receipt",
      receiptBatchId: batch.id,
      receiptOrdinal: 5,
      pages: [page("fifth")],
    })).rejects.toMatchObject({ status: 400, message: "Invalid receipt position" });
    expect(await prisma.receiptScan.count({ where: { captureBatchId: batch.id } })).toBe(1);
  });
});

describe("Round 3: itemised confirmation with nothing itemised", () => {
  it("refuses to book the whole total as charges when no item is assigned", async () => {
    const scan = await makeScan({ items: [] });
    const response = await request(app)
      .post(`${RECEIPTS}/${scan.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        expectedScanRevision: 0,
        date: "2026-09-13",
        vendor: "Owner Store",
        description: "Rice purchase",
        amount: 1250,
        itemAssignments: [],
        reconciliation: { mode: "category", categoryId: owner.categories.Utilities },
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/at least one/i);
    expect(await prisma.expenseRecord.count()).toBe(0);
    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).confirmationStatus).toBe("Pending");
  });

  it("refuses the same body under proportional reconciliation", async () => {
    const scan = await makeScan({ items: [] });
    const response = await request(app)
      .post(`${RECEIPTS}/${scan.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        expectedScanRevision: 0,
        date: "2026-09-13",
        vendor: "Owner Store",
        description: "Rice purchase",
        amount: 1250,
        itemAssignments: [],
        reconciliation: { mode: "proportional" },
      });
    expect(response.status).toBe(400);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

describe("Round 3: duplicate candidates whose target lost its values", () => {
  it("omits a receipt-target candidate with no confirmed values instead of failing the list", async () => {
    const fingerprint = "f".repeat(64);
    const legacy = await makeScan({
      confirmationStatus: "Confirmed",
      extractedDate: null,
      extractedAmount: null,
      items: [],
      path: `${owner.profile.id}/legacy-confirmed.jpg`,
    });
    const source = await makeScan({ semanticFingerprint: fingerprint, path: `${owner.profile.id}/source.jpg` });
    await prisma.receiptDuplicateCandidate.create({
      data: {
        businessProfileId: owner.profile.id,
        sourceReceiptScanId: source.id,
        candidateReceiptScanId: legacy.id,
        detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
        sourceFingerprint: fingerprint,
        reasonCodes: ["SAME_DATE", "SAME_TOTAL"],
        scoreBand: "LIKELY",
        reviewStatus: "PENDING",
      },
    });

    const response = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .set(...auth("owner-token"));
    expect(response.status).toBe(200);
    expect(response.body.candidates).toEqual([]);
  });
});

describe("Round 3: candidate persistence racing an owner delete", () => {
  it("treats a target deleted mid-discovery as not a candidate rather than failing", async () => {
    const expense = await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory,
        date: new Date("2026-09-13T00:00:00.000Z"),
        description: "Rice purchase",
        vendor: "Owner Store",
        amount: 100,
        source: "MANUAL_ENTRY",
      },
    });
    const source = await makeScan({});

    let deleteStarted!: () => void;
    const started = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const deletion = prisma.$transaction(async (tx) => {
      await tx.expenseRecord.delete({ where: { id: expense.id } });
      deleteStarted();
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await started;

    const refresh = prisma.$transaction((tx) => refreshReceiptDuplicateCandidatesForScan(tx, source.id, owner.profile.id));
    await expect(Promise.all([deletion, refresh])).resolves.toBeDefined();

    expect(await prisma.receiptDuplicateCandidate.count({ where: { sourceReceiptScanId: source.id } })).toBe(0);
    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: source.id } })).semanticFingerprint)
      .toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Round 3: confirm and duplicate-candidate limiters", () => {
  it("answers 429 once the confirm limit is spent", async () => {
    const scan = await makeScan({});
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= LIMITS.RECEIPT_CONFIRM_WRITE.limit; attempt++) {
      const response = await request(app)
        .post(`${RECEIPTS}/${scan.id}/confirm`)
        .set(...auth("owner-token"))
        .send({});
      statuses.push(response.status);
    }
    expect(statuses.slice(0, -1)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });

  it("answers 429 once the duplicate-candidate read limit is spent", async () => {
    const scan = await makeScan({});
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= LIMITS.RECEIPT_DUPLICATE_READ.limit; attempt++) {
      const response = await request(app)
        .get(`${RECEIPTS}/${scan.id}/duplicate-candidates`)
        .set(...auth("owner-token"));
      statuses.push(response.status);
    }
    expect(statuses.slice(0, -1)).toEqual(Array(LIMITS.RECEIPT_DUPLICATE_READ.limit).fill(200));
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("Round 3: confirmed-evidence deletion route", () => {
  it("answers 404 to another owner and queues nothing", async () => {
    const scan = await makeScan({ confirmationStatus: "Confirmed" });
    const foreign = await request(app)
      .delete(`${RECEIPTS}/${scan.id}/images`)
      .set(...auth("other-token"))
      .set("Idempotency-Key", "foreign-detach-evidence");
    expect(foreign.status).toBe(404);
    expect(await prisma.receiptPurgeJob.count()).toBe(0);
    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).evidenceDeletionRequestedAt).toBeNull();
  });

  it("answers 429 once the receipt delete limit is spent", async () => {
    const scan = await makeScan({ confirmationStatus: "Confirmed" });
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= LIMITS.RECEIPT_DELETE_WRITE.limit; attempt++) {
      const response = await request(app)
        .delete(`${RECEIPTS}/${scan.id}/images`)
        .set(...auth("owner-token"))
        .set("Idempotency-Key", "repeat-detach-evidence");
      statuses.push(response.status);
    }
    expect(statuses.slice(0, -1)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });
});
