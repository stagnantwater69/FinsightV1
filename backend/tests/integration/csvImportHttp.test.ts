import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
const { uploadCsvFileAtReferenceMock, downloadCsvFileMock } = vi.hoisted(() => ({
  uploadCsvFileAtReferenceMock: vi.fn(async () => undefined),
  downloadCsvFileMock: vi.fn(async (): Promise<Buffer> => Buffer.from("")),
}));
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

vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
    uploadCsvFileAtReference: uploadCsvFileAtReferenceMock,
    downloadCsvFile: downloadCsvFileMock,
    deleteCsvFile: vi.fn(async () => true),
    uploadReceiptImage: vi.fn(async () => "test/mock-receipt.jpg"),
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { runCsvImportWorkerOnce, SYNC_ROW_LIMIT } from "../../src/services/csvImport.service";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import {
  CSV_HTTP_WORK_CONCURRENCY_LIMIT,
  CSV_HTTP_WORK_PER_USER_LIMIT,
  CSV_HTTP_WORK_RETRY_SECONDS,
} from "../../src/middleware/csvHttpWorkLimit.middleware";
import {
  CSV_UPLOAD_MAX_FIELD_BYTES,
  CSV_UPLOAD_MAX_FIELD_NAME_BYTES,
  CSV_UPLOAD_MAX_FIELDS,
  CSV_UPLOAD_MAX_PARTS,
} from "../../src/middleware/upload.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let uploadedBuffer: Buffer = Buffer.from("");
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const BASE = "/api/v1/records/csv-imports";

const MAPPING_OBJECT = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  category: "Category",
};
const MAPPING = JSON.stringify(MAPPING_OBJECT);

beforeEach(async () => {
  await resetDb();
  // Under NODE_ENV=test the limiter is the in-memory backend, which resetDb
  // cannot truncate — without this, confirms accumulate across cases in this
  // file and later tests answer 429 for reasons that have nothing to do with
  // what they assert. (That the counter accumulates at all is the limiter
  // working; the per-minute confirm cap is asserted directly below.)
  resetRateLimits();
  uploadCsvFileAtReferenceMock.mockReset();
  uploadCsvFileAtReferenceMock.mockResolvedValue(undefined);
  downloadCsvFileMock.mockReset();
  downloadCsvFileMock.mockImplementation(async () => uploadedBuffer);
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

function csvOf(rows: number): Buffer {
  const lines = ["Date,Description,Amount,Category"];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`${utcDayString(-index)},Item ${index},${100 + index},Inventory`);
  }
  uploadedBuffer = Buffer.from(lines.join("\n"));
  return uploadedBuffer;
}

/** A confirm as the browser actually sends it: multipart, fields + file part. */
function confirmRequest(buffer: Buffer, fields: Record<string, string> = {}) {
  const req = request(app)
    .post(`${BASE}/confirm`)
    .set(...AUTH)
    .field("businessProfileId", String(ctx.profile.id))
    .field("recordType", "expense")
    .field("title", "HTTP import")
    .field("columnMapping", MAPPING);
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  return req.attach("file", buffer, "books.csv");
}

function stageRequest(buffer: Buffer, fields: Record<string, string> = {}) {
  const {
    idempotencyKey = "stage-http-key-1",
    businessProfileId = String(ctx.profile.id),
    ...extraFields
  } = fields;
  const req = request(app)
    .post(`${BASE}/preview`)
    .set(...AUTH)
    .field("businessProfileId", businessProfileId)
    .field("idempotencyKey", idempotencyKey);
  for (const [key, value] of Object.entries(extraFields)) req.field(key, value);
  return req.attach("file", buffer, "books.csv");
}

function stagedPreviewRequest(stagedUploadId: string, businessProfileId = ctx.profile.id) {
  return request(app)
    .post(`${BASE}/preview`)
    .set(...AUTH)
    .send({
      stagedUploadId,
      businessProfileId,
      recordType: "expense",
      columnMapping: MAPPING_OBJECT,
    });
}

function stagedConfirmRequest(
  stagedUploadId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(app)
    .post(`${BASE}/confirm`)
    .set(...AUTH)
    .send({
      stagedUploadId,
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Staged HTTP import",
      columnMapping: MAPPING_OBJECT,
      idempotencyKey: "confirm-http-key-1",
      ...overrides,
    });
}

describe("CSV import over HTTP", () => {
  it("uploads once, then previews and confirms the staged CSV with JSON", async () => {
    const staged = await stageRequest(csvOf(2));
    expect(staged.status).toBe(200);
    expect(staged.body.stagedUploadId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(staged.headers["server-timing"]).toContain("total");
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(1);

    const checked = await stagedPreviewRequest(staged.body.stagedUploadId);
    expect(checked.status).toBe(200);
    expect(checked.body.validation).toMatchObject({ validRows: 2, invalidRows: 0 });
    expect(checked.body.stagedUploadId).toBe(staged.body.stagedUploadId);
    expect(checked.headers["server-timing"]).toContain("total");

    const confirmed = await stagedConfirmRequest(staged.body.stagedUploadId);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({
      processingStatus: "COMPLETE",
      imported: 2,
    });
    expect(confirmed.headers["server-timing"]).toContain("total");
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(1);
    expect(downloadCsvFileMock).not.toHaveBeenCalled();
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("applies the multipart upload limit before file parsing while JSON review bypasses it", async () => {
    const staged = await stageRequest(csvOf(1), { idempotencyKey: "pre-multer-limit-baseline" });
    expect(staged.status).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const missingFile = await request(app)
        .post(`${BASE}/preview`)
        .set(...AUTH)
        .field("businessProfileId", String(ctx.profile.id))
        .field("idempotencyKey", `pre-multer-limit-${attempt}`);
      expect(missingFile.status).toBe(400);
    }

    const rejectedBeforeMulter = await request(app)
      .post(`${BASE}/preview`)
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("idempotencyKey", "pre-multer-limit-overflow")
      .attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), "oversized.csv");
    expect(rejectedBeforeMulter.status).toBe(429);
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(1);
    expect(await prisma.cSVImportBatch.count()).toBe(1);
    expect(await prisma.cSVImportStageChunk.count()).toBe(1);

    const jsonReview = await stagedPreviewRequest(staged.body.stagedUploadId);
    expect(jsonReview.status).toBe(200);
    expect(jsonReview.body.stagedUploadId).toBe(staged.body.stagedUploadId);
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized multipart structure before the CSV controller or Storage", async () => {
    expect(CSV_UPLOAD_MAX_FIELD_NAME_BYTES).toBe(100);
    expect(CSV_UPLOAD_MAX_FIELD_BYTES).toBe(1024 * 1024);
    expect(CSV_UPLOAD_MAX_PARTS).toBe(CSV_UPLOAD_MAX_FIELDS + 1);
    const buffer = csvOf(1);
    const baseConfirm = () => request(app)
      .post(`${BASE}/confirm`)
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("recordType", "expense")
      .field("title", "Multipart bounds")
      .field("columnMapping", MAPPING);

    const tooManyFiles = await baseConfirm()
      .attach("file", buffer, "first.csv")
      .attach("file", buffer, "second.csv");

    let tooManyFieldsRequest = baseConfirm();
    for (let index = 0; index <= CSV_UPLOAD_MAX_FIELDS; index += 1) {
      tooManyFieldsRequest = tooManyFieldsRequest.field(`extra-${index}`, "value");
    }
    const tooManyFields = await tooManyFieldsRequest.attach("file", buffer, "fields.csv");

    let tooManyPartsRequest = baseConfirm();
    for (let index = 0; index < CSV_UPLOAD_MAX_FIELDS - 4; index += 1) {
      tooManyPartsRequest = tooManyPartsRequest.field(`part-${index}`, "value");
    }
    const tooManyParts = await tooManyPartsRequest
      .attach("file", buffer, "part-one.csv")
      .attach("file", buffer, "part-two.csv");

    const longFieldName = await baseConfirm()
      .field("x".repeat(CSV_UPLOAD_MAX_FIELD_NAME_BYTES + 1), "value")
      .attach("file", buffer, "long-field-name.csv");
    const largeTextField = await baseConfirm()
      .field("oversized", "x".repeat(CSV_UPLOAD_MAX_FIELD_BYTES + 1))
      .attach("file", buffer, "large-text-field.csv");

    const rejected = [
      [tooManyFiles, 400, ["UPLOAD_TOO_MANY_FILES", "UPLOAD_UNEXPECTED_FILE"]],
      [tooManyFields, 400, ["UPLOAD_TOO_MANY_FIELDS", "UPLOAD_TOO_MANY_PARTS"]],
      [tooManyParts, 400, ["UPLOAD_TOO_MANY_PARTS", "UPLOAD_TOO_MANY_FILES", "UPLOAD_UNEXPECTED_FILE"]],
      [longFieldName, 400, ["UPLOAD_FIELD_NAME_TOO_LONG"]],
      [largeTextField, 413, ["UPLOAD_FIELD_TOO_LARGE"]],
    ] as const;
    for (const [response, status, codes] of rejected) {
      expect(response.status).toBe(status);
      expect(codes).toContain(response.body.code);
      expect(response.body.error).toEqual(expect.any(String));
      expect(response.body.error).not.toContain("x".repeat(50));
    }
    expect(uploadCsvFileAtReferenceMock).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.count()).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);

    const validCompleteShape = await request(app)
      .post(`${BASE}/confirm`)
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("recordType", "expense")
      .field("mixedStrategy", "sign")
      .field("title", "Complete legacy shape")
      .field("columnMapping", MAPPING)
      .field("corrections", JSON.stringify({}))
      .field("idempotencyKey", "multipart-valid-complete-shape")
      .field("dateFormat", "iso")
      .attach("file", buffer, "valid-complete-shape.csv");
    expect(validCompleteShape.status).toBe(201);
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(1);
    expect(await prisma.cSVImportBatch.count()).toBe(1);
    expect(await prisma.expenseRecord.count()).toBe(1);
  }, 60_000);

  it("bounds every request-side CSV parse or decode while workers remain independent", async () => {
    const workerBuffer = csvOf(SYNC_ROW_LIMIT + 1);
    const workerBatch = await confirmRequest(workerBuffer, { idempotencyKey: "http-gate-worker" });
    expect(workerBatch.status).toBe(202);
    const baselineBuffer = csvOf(1);
    const baseline = await stageRequest(baselineBuffer, { idempotencyKey: "http-gate-baseline" });
    expect(baseline.status).toBe(200);

    uploadCsvFileAtReferenceMock.mockClear();
    let started = 0;
    let signalFirstStarted!: () => void;
    let signalSecondStarted!: () => void;
    let releaseUploads!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });
    const uploadsReleased = new Promise<void>((resolve) => { releaseUploads = resolve; });
    uploadCsvFileAtReferenceMock.mockImplementation(async () => {
      started += 1;
      if (started === 1) signalFirstStarted();
      if (started === CSV_HTTP_WORK_CONCURRENCY_LIMIT) signalSecondStarted();
      await uploadsReleased;
    });
    const firstHeld = stageRequest(csvOf(1), { idempotencyKey: "http-gate-held-primary" })
      .then((response) => response);
    await firstStarted;

    expect(CSV_HTTP_WORK_PER_USER_LIMIT).toBe(1);
    const sameUserBusy = await stageRequest(csvOf(1), { idempotencyKey: "http-gate-same-user" });
    expect(sameUserBusy.status).toBe(429);
    expect(sameUserBusy.body.code).toBe("CSV_STAGE_BUSY");
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(1);

    const secondOwner = await makeOwnerWithProfile({ name: "Second gate owner" }, ["Inventory"]);
    authUserId.value = secondOwner.user.authId;
    const secondHeld = stageRequest(csvOf(1), {
      businessProfileId: String(secondOwner.profile.id),
      idempotencyKey: "http-gate-held-secondary",
    }).then((response) => response);
    await secondStarted;

    const thirdOwner = await makeOwnerWithProfile({ name: "Third gate owner" }, ["Inventory"]);
    authUserId.value = thirdOwner.user.authId;
    const globalBusy = await stageRequest(csvOf(1), {
      businessProfileId: String(thirdOwner.profile.id),
      idempotencyKey: "http-gate-global-overflow",
    });
    expect(globalBusy.status).toBe(429);
    expect(globalBusy.body.code).toBe("CSV_STAGE_BUSY");
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(CSV_HTTP_WORK_CONCURRENCY_LIMIT);
    authUserId.value = ctx.user.authId;

    uploadedBuffer = workerBuffer;
    for (let pass = 0; pass < 10; pass += 1) {
      const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: workerBatch.body.batchId } });
      if (batch.processingStatus === "COMPLETE") break;
      expect(await runCsvImportWorkerOnce()).toBe(true);
    }
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({
      where: { id: workerBatch.body.batchId },
    })).toMatchObject({ processingStatus: "COMPLETE" });
    const statusWhileBusy = await request(app)
      .get(`${BASE}/batches/${workerBatch.body.batchId}/status`)
      .set(...AUTH);
    expect(statusWhileBusy.status).toBe(200);
    expect(statusWhileBusy.body.processingStatus).toBe("COMPLETE");

    const batchesBeforeBusyRequests = await prisma.cSVImportBatch.count();
    const chunksBeforeBusyRequests = await prisma.cSVImportStageChunk.count();
    const malformed = Buffer.from(`Date,Description\n${utcDayString(0)},"unterminated`);
    const busyResponses = [
      await stageRequest(baselineBuffer, { idempotencyKey: "http-gate-baseline" }),
      await stagedPreviewRequest(baseline.body.stagedUploadId),
      await stagedConfirmRequest(baseline.body.stagedUploadId),
      await request(app)
        .post(`${BASE}/preview`)
        .set(...AUTH)
        .field("businessProfileId", String(ctx.profile.id))
        .field("recordType", "expense")
        .field("columnMapping", MAPPING)
        .attach("file", malformed, "malformed-preview.csv"),
      await confirmRequest(malformed, { idempotencyKey: "http-gate-legacy-confirm" }),
      await request(app)
        .get(`${BASE}/batches/${workerBatch.body.batchId}/preview`)
        .set(...AUTH),
    ];
    for (const response of busyResponses) {
      expect(response.status).toBe(429);
      expect(response.body).toMatchObject({
        code: "CSV_STAGE_BUSY",
        retryAfterSeconds: CSV_HTTP_WORK_RETRY_SECONDS,
      });
      expect(response.headers["retry-after"]).toBe(String(CSV_HTTP_WORK_RETRY_SECONDS));
    }
    expect(uploadCsvFileAtReferenceMock).toHaveBeenCalledTimes(CSV_HTTP_WORK_CONCURRENCY_LIMIT);
    expect(await prisma.cSVImportBatch.count()).toBe(batchesBeforeBusyRequests);
    expect(await prisma.cSVImportStageChunk.count()).toBe(chunksBeforeBusyRequests);

    releaseUploads();
    const completedUploads = await Promise.all([firstHeld, secondHeld]);
    expect(completedUploads.map((response) => response.status)).toEqual(
      Array(CSV_HTTP_WORK_CONCURRENCY_LIMIT).fill(200),
    );

    const parseError = await request(app)
      .post(`${BASE}/preview`)
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("recordType", "expense")
      .field("columnMapping", MAPPING)
      .attach("file", malformed, "malformed-after-release.csv");
    expect(parseError.status).toBe(400);
    const afterError = await stagedPreviewRequest(baseline.body.stagedUploadId);
    expect(afterError.status).toBe(200);
  }, 120_000);

  it("rate limits saved-batch preview before the work permit and leaves status polling open", async () => {
    const imported = await confirmRequest(csvOf(1), { idempotencyKey: "batch-preview-rate-baseline" });
    expect(imported.status).toBe(201);

    let signalUploadStarted!: () => void;
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
    const uploadReleased = new Promise<void>((resolve) => { releaseUpload = resolve; });
    uploadCsvFileAtReferenceMock.mockImplementationOnce(async () => {
      signalUploadStarted();
      await uploadReleased;
    });
    const held = stageRequest(csvOf(1), { idempotencyKey: "batch-preview-rate-held" })
      .then((response) => response);
    await uploadStarted;
    resetRateLimits();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(app)
        .get(`${BASE}/batches/${imported.body.batchId}/preview`)
        .set(...AUTH);
      expect(response.status).toBe(429);
      expect(response.body.code).toBe("CSV_STAGE_BUSY");
      expect(response.headers["ratelimit-limit"]).toBe("20");
    }
    const rateLimited = await request(app)
      .get(`${BASE}/batches/${imported.body.batchId}/preview`)
      .set(...AUTH);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body).not.toHaveProperty("code");
    expect(rateLimited.headers["ratelimit-remaining"]).toBe("0");

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const status = await request(app)
        .get(`${BASE}/batches/${imported.body.batchId}/status`)
        .set(...AUTH);
      expect(status.status).toBe(200);
    }

    releaseUpload();
    expect((await held).status).toBe(200);
  }, 60_000);

  it("scopes staged preview and confirm to the requested profile, not only the owner", async () => {
    const staged = await stageRequest(csvOf(1), { idempotencyKey: "stage-profile-scope" });
    const second = await prisma.businessProfile.create({
      data: {
        userId: ctx.user.id,
        name: "Second shop",
        type: "Retail",
        availableFunds: 10_000,
        expectedMonthlyExpenses: 5_000,
        operatingDays: 25,
        largeExpenseThresholdPercent: 25,
      },
    });

    const preview = await stagedPreviewRequest(staged.body.stagedUploadId, second.id);
    expect(preview.status).toBe(404);
    expect(preview.body.code).toBe("CSV_STAGE_NOT_FOUND");
    const confirm = await stagedConfirmRequest(staged.body.stagedUploadId, {
      businessProfileId: second.id,
    });
    expect(confirm.status).toBe(404);
    expect(confirm.body.code).toBe("CSV_STAGE_NOT_FOUND");
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("makes missing and wrong-owner stage deletion nondisclosing and idempotent", async () => {
    const missingId = "11111111-2222-4333-8444-555555555555";
    expect((await request(app).delete(`${BASE}/stages/${missingId}`).set(...AUTH)).status).toBe(204);

    const staged = await stageRequest(csvOf(1), { idempotencyKey: "stage-delete-idempotent" });
    const other = await makeOwnerWithProfile({ name: "Other owner" }, ["Inventory"]);
    authUserId.value = other.user.authId;
    expect((await request(app).delete(`${BASE}/stages/${staged.body.stagedUploadId}`).set(...AUTH)).status).toBe(204);
    expect(await prisma.cSVImportBatch.count({ where: { stageId: staged.body.stagedUploadId } })).toBe(1);

    authUserId.value = ctx.user.authId;
    expect((await request(app).delete(`${BASE}/stages/${staged.body.stagedUploadId}`).set(...AUTH)).status).toBe(204);
    expect((await request(app).delete(`${BASE}/stages/${staged.body.stagedUploadId}`).set(...AUTH)).status).toBe(204);
    expect(await prisma.cSVImportBatch.count({ where: { stageId: staged.body.stagedUploadId } })).toBe(0);
  });

  it.each([
    ["expired", new Date(Date.now() - 1_000), null, 410, "CSV_STAGE_EXPIRED"],
    ["stale upload", new Date(Date.now() + 60_000), new Date(Date.now() - 10 * 60_000), 410, "CSV_STAGE_STALE"],
    ["fresh upload", new Date(Date.now() + 60_000), new Date(), 409, "CSV_STAGE_UPLOADING"],
  ] as const)("reports a %s stage with a stable recovery code", async (_label, expiresAt, heartbeatAt, status, code) => {
    const staged = await stageRequest(csvOf(1), { idempotencyKey: `stage-${code}` });
    await prisma.cSVImportBatch.update({
      where: { stageId: staged.body.stagedUploadId },
      data: heartbeatAt === null
        ? { stageExpiresAt: expiresAt }
        : {
            processingStatus: "STAGING",
            stagedAt: null,
            stageExpiresAt: expiresAt,
            heartbeatAt,
            workerId: "stage:test",
          },
    });

    const response = await stagedPreviewRequest(staged.body.stagedUploadId);
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    if (code === "CSV_STAGE_UPLOADING") {
      const removal = await request(app)
        .delete(`${BASE}/stages/${staged.body.stagedUploadId}`)
        .set(...AUTH);
      expect(removal.status).toBe(409);
      expect(removal.body.code).toBe("CSV_STAGE_UPLOADING");
    }
  });

  it("replays one staged confirmation and rejects conflicting details", async () => {
    const staged = await stageRequest(csvOf(2), { idempotencyKey: "stage-confirm-replay" });
    const first = await stagedConfirmRequest(staged.body.stagedUploadId);
    const replay = await stagedConfirmRequest(staged.body.stagedUploadId);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.batchId).toBe(first.body.batchId);
    expect(await prisma.expenseRecord.count()).toBe(2);

    const conflict = await stagedConfirmRequest(staged.body.stagedUploadId, { title: "Different title" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("CSV_STAGE_CONFIRM_CONFLICT");
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("deduplicates identical retries from legacy clients without an explicit key", async () => {
    const buffer = csvOf(2);
    const first = await confirmRequest(buffer);
    const second = await confirmRequest(buffer);
    expect(first.status).toBe(201);
    expect(second.body.batchId).toBe(first.body.batchId);
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("returns a mapped preflight before saving and rejects malformed files as client errors", async () => {
    const response = await request(app).post(`${BASE}/preview`).set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id)).field("recordType", "expense")
      .field("columnMapping", MAPPING).attach("file", csvOf(2), "books.csv");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.validation).toMatchObject({ validRows: 2, invalidRows: 0, possibleDuplicateRows: 0 });
    expect(await prisma.expenseRecord.count()).toBe(0);
    const malformed = await request(app).post(`${BASE}/preview`).set(...AUTH)
      .attach("file", Buffer.from('Date,Description\n2026-09-01,"broken'), "books.csv");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).not.toContain("broken");
  });

  it("keeps mapped preview suggestions owner-scoped and requires an explicit category correction", async () => {
    await prisma.expenseRecord.create({ data: {
      businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
      date: new Date("2026-09-01"), description: "Rice", vendor: "Store A", amount: 100, source: "MANUAL_ENTRY",
    } });
    const buffer = Buffer.from("Date,Description,Amount,Vendor\n2026-09-01,Rice,100,Store A");
    const mapping = JSON.stringify({ date: "Date", description: "Description", amount: "Amount", vendor: "Vendor" });
    const preview = (businessProfileId: number, corrections?: string) => {
      const req = request(app).post(`${BASE}/preview`).set(...AUTH)
        .field("businessProfileId", String(businessProfileId)).field("recordType", "expense").field("columnMapping", mapping);
      if (corrections) req.field("corrections", corrections);
      return req.attach("file", buffer, "books.csv");
    };
    const first = await preview(ctx.profile.id);
    expect(first.status).toBe(200);
    expect(first.body.validation).toMatchObject({ validRows: 0, invalidRows: 1 });
    expect(first.body.categorySuggestions).toEqual([{ row: 2, categoryId: ctx.categories.Inventory, categoryName: "Inventory", source: "history" }]);
    const corrected = await preview(ctx.profile.id, JSON.stringify({ "2": { category: "Inventory" } }));
    expect(corrected.body.validation).toMatchObject({ validRows: 1, invalidRows: 0, possibleDuplicateRows: 1, duplicateRows: [2] });
    expect(corrected.body.categorySuggestions).toEqual([]);
    expect(await prisma.expenseRecord.count()).toBe(1);
    const other = await makeOwnerWithProfile();
    authUserId.value = other.user.authId;
    expect((await preview(ctx.profile.id)).status).toBe(404);
    const otherPreview = await preview(other.profile.id);
    expect(otherPreview.status).toBe(200);
    expect(otherPreview.body.categorySuggestions).toEqual([]);
  });

  it("validates preview request mappings and corrections at the HTTP boundary", async () => {
    for (const fields of [
      { recordType: "expense" },
      { recordType: "expense", columnMapping: "{broken" },
      { recordType: "expense", columnMapping: MAPPING, corrections: "{broken" },
      { recordType: "expense", columnMapping: MAPPING, corrections: JSON.stringify({ invalid: { amount: "100" } }) },
      { recordType: "expense", columnMapping: MAPPING, dateFormat: "guess" },
    ]) {
      const req = request(app).post(`${BASE}/preview`).set(...AUTH);
      for (const [key, value] of Object.entries(fields)) req.field(key, value);
      const response = await req.attach("file", csvOf(1), "books.csv");
      expect(response.status).toBe(400);
    }
    expect(await prisma.cSVImportBatch.count()).toBe(0);
  });

  it("imports a small file synchronously and reports 201 with final counts", async () => {
    const response = await confirmRequest(csvOf(3), { idempotencyKey: "http-sync-1" });

    expect(response.status).toBe(201);
    expect(response.body.processingStatus).toBe("COMPLETE");
    expect(response.body.imported).toBe(3);
    expect(response.body.batchId).toBeGreaterThan(0);
  });

  it("deduplicates a replayed confirm at the HTTP boundary", async () => {
    const buffer = csvOf(3);
    const first = await confirmRequest(buffer, { idempotencyKey: "http-replay-1" });
    const second = await confirmRequest(buffer, { idempotencyKey: "http-replay-1" });

    expect(second.body.batchId).toBe(first.body.batchId);
    expect(await prisma.expenseRecord.count()).toBe(3);
  });

  it("accepts a large file with 202 and completes it through the worker", async () => {
    const rows = SYNC_ROW_LIMIT + 5;
    const accepted = await confirmRequest(csvOf(rows), { idempotencyKey: "http-async-1" });

    expect(accepted.status).toBe(202);
    expect(accepted.body.processingStatus).toBe("PENDING");

    for (let pass = 0; pass < 60 && (await runCsvImportWorkerOnce()); pass += 1);

    const status = await request(app)
      .get(`${BASE}/batches/${accepted.body.batchId}/status`)
      .set(...AUTH);
    expect(status.status).toBe(200);
    expect(status.body.processingStatus).toBe("COMPLETE");
    expect(status.body.importedRows).toBe(rows);
  }, 120_000);

  it("rejects an ambiguous-date file, and imports it once the owner states the format", async () => {
    const buffer = Buffer.from(
      ["Date,Description,Amount,Category", "05/01/2026,Rice,1200,Inventory", "03/02/2026,Oil,300,Inventory"].join("\n"),
    );
    uploadedBuffer = buffer;

    const refused = await confirmRequest(buffer, { idempotencyKey: "http-ambiguous-1" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);

    const accepted = await confirmRequest(buffer, { idempotencyKey: "http-ambiguous-2", dateFormat: "dmy" });
    expect(accepted.status).toBe(201);
    const first = await prisma.expenseRecord.findFirstOrThrow({ orderBy: { date: "asc" } });
    expect(first.date.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("requires authentication on every route", async () => {
    const unauth = await request(app).get(`${BASE}/batches`).query({ businessProfileId: ctx.profile.id });
    expect(unauth.status).toBe(401);
    const badToken = await request(app)
      .get(`${BASE}/batches/1/status`)
      .set("Authorization", "Bearer nope");
    expect(badToken.status).toBe(401);
  });

  it("does not expose another owner's batch status", async () => {
    const mine = await confirmRequest(csvOf(2), { idempotencyKey: "http-scope-1" });
    const mallory = await makeOwnerWithProfile({ name: "Mallory" }, ["Inventory"]);
    authUserId.value = mallory.user.authId;

    const probe = await request(app)
      .get(`${BASE}/batches/${mine.body.batchId}/status`)
      .set(...AUTH);
    expect(probe.status).toBe(404);
  });

  it("refuses a confirm with no file part", async () => {
    const response = await request(app)
      .post(`${BASE}/confirm`)
      .set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id))
      .field("recordType", "expense")
      .field("title", "No file")
      .field("columnMapping", MAPPING);
    expect(response.status).toBe(400);
  });

  it("refuses malformed multipart field payloads", async () => {
    const response = await confirmRequest(csvOf(2), { columnMapping: "{not json", idempotencyKey: "http-bad-json" });
    expect(response.status).toBe(400);
  });

  it("refuses an over-long idempotency key rather than truncating it", async () => {
    const response = await confirmRequest(csvOf(2), { idempotencyKey: "x".repeat(200) });
    expect(response.status).toBe(400);
  });

  it("rate limits repeated confirms, which were previously unlimited", async () => {
    // The burst cap is 10/minute. Eleven confirms must not all be served —
    // this endpoint parses a file and can enqueue tens of thousands of rows.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await confirmRequest(csvOf(1), { idempotencyKey: `burst-${attempt}` });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  }, 60_000);

  it("still imports for a client that sends no idempotency key (Phase 4 shim)", async () => {
    // The web client does not send one until the UI work lands; a 400 here
    // would break importing entirely in between. It imports, unprotected.
    const response = await confirmRequest(csvOf(2));
    expect(response.status).toBe(201);
    expect(response.body.imported).toBe(2);
  });
});
