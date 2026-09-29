import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const parser = vi.hoisted(() => ({ calls: 0 }));
const storage = vi.hoisted(() => ({
  uploadAt: vi.fn(async (
    _businessProfileId: number,
    _fileReference: string,
    _buffer: Buffer,
  ) => undefined),
  uploadLegacy: vi.fn(async () => "1/legacy.csv"),
  download: vi.fn(async (_reference: string): Promise<Buffer> => Buffer.from("")),
  remove: vi.fn(async (_reference: string) => true),
}));

vi.mock("csv-parse/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("csv-parse/sync")>();
  const realParse = actual.parse as unknown as (...args: unknown[]) => unknown;
  return {
    ...actual,
    parse: (...args: unknown[]) => {
      parser.calls += 1;
      return realParse(...args);
    },
  };
});

vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadCsvFileAtReference: storage.uploadAt,
    uploadCsvFile: storage.uploadLegacy,
    downloadCsvFile: storage.download,
    deleteCsvFile: storage.remove,
  };
});

import {
  AccountDeletionStage,
  AccountStatus,
  CsvImportProcessingStatus,
} from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import {
  CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS,
  CSV_STAGE_CREATION_HOURLY_LIMIT,
  CSV_STAGE_OUTSTANDING_BYTES_LIMIT,
  CSV_STAGE_OUTSTANDING_LIMIT,
  confirmStagedImport,
  confirmImport,
  deleteStagedCsvUpload,
  previewStagedCsv,
  runCsvImportWorkerOnce,
  stageCsvUpload,
  sweepExpiredCsvStages,
  sweepStalledCsvImports,
  SYNC_ROW_LIMIT,
  type PreviewOptions,
  type StagedConfirmInput,
} from "../../src/services/csvImport.service";
import { runAccountDeletionWorkerOnce } from "../../src/services/accountDeletion.service";
import { runCsvSourcePurgeWorkerOnce } from "../../src/services/csvSourcePurge.service";
import {
  disconnectDb,
  makeOwnerWithProfile,
  makeProfile,
  resetDb,
  utcDayString,
} from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let downloadedCsv: Buffer = Buffer.from("");

const MAPPING = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  category: "Category",
};

const PREVIEW_OPTIONS: PreviewOptions = {
  recordType: "expense",
  columnMapping: MAPPING,
};

function csvOf(rows: number): Buffer {
  const lines = ["Date,Description,Amount,Category"];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`${utcDayString(-index)},Item ${index},${100 + index},Inventory`);
  }
  downloadedCsv = Buffer.from(lines.join("\n"));
  return downloadedCsv;
}

function confirmInput(title = "Staged import"): StagedConfirmInput {
  return {
    title,
    recordType: "expense",
    columnMapping: MAPPING,
  };
}

async function createStage(buffer = csvOf(2), key = "stage-key-1") {
  return createStageForProfile(ctx.profile.id, buffer, key);
}

async function createStageForProfile(
  businessProfileId: number,
  buffer = csvOf(2),
  key = "stage-key-1",
) {
  return stageCsvUpload(ctx.user.id, {
    businessProfileId,
    buffer,
    originalname: "books.csv",
    idempotencyKey: key,
  });
}

async function makeCsvPurgesDue(fileReference: string | null): Promise<void> {
  if (!fileReference) throw new Error("expected a reserved CSV file reference");
  await prisma.cSVSourcePurgeJob.updateMany({
    where: { fileReference },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  });
}

beforeEach(async () => {
  await resetDb();
  parser.calls = 0;
  storage.uploadAt.mockReset();
  storage.uploadAt.mockResolvedValue(undefined);
  storage.uploadLegacy.mockClear();
  storage.download.mockReset();
  storage.download.mockImplementation(async () => downloadedCsv);
  storage.remove.mockReset();
  storage.remove.mockResolvedValue(true);
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
});

afterAll(disconnectDb);

describe("single-upload CSV staging", () => {
  it("uploads and parses once, then reuses the same verified chunks for preview and confirm", async () => {
    const buffer = csvOf(2);
    const first = await createStage(buffer, "single-upload");
    const replay = await createStage(buffer, "single-upload");

    expect(first.result.stagedUploadId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(replay.result.stagedUploadId).toBe(first.result.stagedUploadId);
    expect(parser.calls).toBe(1);
    expect(storage.uploadAt).toHaveBeenCalledTimes(1);
    expect(storage.download).not.toHaveBeenCalled();
    expect(await prisma.cSVImportStageChunk.count()).toBe(1);

    const checked = await previewStagedCsv(
      ctx.user.id,
      ctx.profile.id,
      first.result.stagedUploadId,
      PREVIEW_OPTIONS,
    );
    expect(checked.result.validation).toMatchObject({ validRows: 2, invalidRows: 0 });

    const confirmed = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      first.result.stagedUploadId,
      confirmInput(),
    );
    expect(confirmed.result).toMatchObject({
      processingStatus: CsvImportProcessingStatus.COMPLETE,
      imported: 2,
    });
    expect(parser.calls).toBe(1);
    expect(storage.uploadAt).toHaveBeenCalledTimes(1);
    expect(storage.download).not.toHaveBeenCalled();
    expect(await prisma.cSVImportStageChunk.count()).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("returns a stable conflict when concurrent uploads reuse a key for different bytes", async () => {
    const firstBuffer = Buffer.from(
      `Date,Description,Amount,Category\n${utcDayString(0)},Alpha,100,Inventory`,
    );
    const secondBuffer = Buffer.from(
      `Date,Description,Amount,Category\n${utcDayString(0)},Beta,200,Inventory`,
    );
    const outcomes = await Promise.allSettled([
      createStage(firstBuffer, "concurrent-key-conflict"),
      createStage(secondBuffer, "concurrent-key-conflict"),
    ]);
    const success = outcomes.find((outcome) => outcome.status === "fulfilled");
    const conflict = outcomes.find((outcome) => outcome.status === "rejected");
    if (!success || success.status !== "fulfilled" || !conflict || conflict.status !== "rejected") {
      throw new Error("expected one staged upload and one idempotency conflict");
    }

    expect(conflict.reason).toMatchObject({ status: 409, code: "CSV_STAGE_KEY_CONFLICT" });
    expect(storage.uploadAt).toHaveBeenCalledTimes(1);
    expect(await prisma.cSVImportBatch.count()).toBe(1);
    expect(await prisma.cSVImportStageChunk.count()).toBe(1);
    const uploaded = storage.uploadAt.mock.calls[0]?.[2];
    const expectedDescription = uploaded?.equals(firstBuffer) ? "Alpha" : "Beta";
    expect(success.value.result.previewRows[0]?.Description).toBe(expectedDescription);

    const replay = await previewStagedCsv(
      ctx.user.id,
      ctx.profile.id,
      success.value.result.stagedUploadId,
      PREVIEW_OPTIONS,
    );
    expect(replay.result.previewRows[0]?.Description).toBe(expectedDescription);
  });

  it("serializes the outstanding-stage quota across one user's profiles and states", async () => {
    const secondProfile = await makeProfile(ctx.user.id, { name: "Second store" });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const states = [
      CsvImportProcessingStatus.STAGING,
      CsvImportProcessingStatus.STAGED,
      CsvImportProcessingStatus.PENDING,
      CsvImportProcessingStatus.PROCESSING,
    ];
    await prisma.cSVImportBatch.createMany({
      data: states.map((processingStatus, index) => ({
        businessProfileId: index % 2 === 0 ? ctx.profile.id : secondProfile.id,
        title: `Quota state ${processingStatus}`,
        uploadDate: now,
        status: "Needs Review",
        processingStatus,
        fileReference: `${index % 2 === 0 ? ctx.profile.id : secondProfile.id}/quota-${index}.csv`,
        fileSizeBytes: 1,
        totalRows: 1,
        stageId: index < 2 ? randomUUID() : null,
        stageExpiresAt: index < 2 ? expiresAt : null,
        stagedAt: processingStatus === CsvImportProcessingStatus.STAGED ? now : null,
        heartbeatAt: (
          processingStatus === CsvImportProcessingStatus.STAGING ||
          processingStatus === CsvImportProcessingStatus.PROCESSING
        ) ? now : null,
        workerId: processingStatus === CsvImportProcessingStatus.STAGING
          ? "stage:test"
          : processingStatus === CsvImportProcessingStatus.PROCESSING
            ? "legacy:test"
            : null,
      })),
    });

    const outcomes = await Promise.allSettled([
      createStageForProfile(ctx.profile.id, csvOf(1), "quota-race-primary"),
      createStageForProfile(secondProfile.id, csvOf(1), "quota-race-secondary"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (!rejected || rejected.status !== "rejected") throw new Error("expected a quota rejection");
    expect(rejected.reason).toMatchObject({ status: 429, code: "CSV_STAGE_OUTSTANDING_LIMIT" });
    expect(storage.uploadAt).toHaveBeenCalledTimes(1);
    expect(await prisma.cSVImportBatch.count({
      where: {
        processingStatus: {
          in: [
            CsvImportProcessingStatus.STAGING,
            CsvImportProcessingStatus.STAGED,
            CsvImportProcessingStatus.PENDING,
            CsvImportProcessingStatus.PROCESSING,
          ],
        },
      },
    })).toBe(CSV_STAGE_OUTSTANDING_LIMIT);
    expect(await prisma.cSVImportStageChunk.count()).toBe(1);
  });

  it("holds quota through async confirmation and releases it on delete or terminal outcomes", async () => {
    const stages = [
      await createStage(csvOf(1), "quota-lifecycle-small-complete"),
      await createStage(csvOf(SYNC_ROW_LIMIT + 1), "quota-lifecycle-async-fail"),
      await createStage(csvOf(1), "quota-lifecycle-small-2"),
      await createStage(csvOf(1), "quota-lifecycle-small-3"),
      await createStage(csvOf(1), "quota-lifecycle-small-4"),
    ];
    const uploadCallsAtCapacity = storage.uploadAt.mock.calls.length;
    const replayAtCapacity = await createStage(csvOf(1), "quota-lifecycle-small-complete");
    expect(replayAtCapacity.result.stagedUploadId).toBe(stages[0]!.result.stagedUploadId);
    expect(storage.uploadAt).toHaveBeenCalledTimes(uploadCallsAtCapacity);
    await expect(createStage(csvOf(1), "quota-lifecycle-full"))
      .rejects.toMatchObject({ status: 429, code: "CSV_STAGE_OUTSTANDING_LIMIT" });

    const completed = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      stages[0]!.result.stagedUploadId,
      confirmInput("Quota sync complete"),
    );
    expect(completed.result.processingStatus).toBe(CsvImportProcessingStatus.COMPLETE);
    await expect(createStage(csvOf(1), "quota-after-complete")).resolves.toBeDefined();

    const pending = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      stages[1]!.result.stagedUploadId,
      confirmInput("Quota async pending"),
    );
    expect(pending.result.processingStatus).toBe(CsvImportProcessingStatus.PENDING);
    await expect(createStage(csvOf(1), "quota-while-pending"))
      .rejects.toMatchObject({ status: 429, code: "CSV_STAGE_OUTSTANDING_LIMIT" });

    const chunk = await prisma.cSVImportStageChunk.findFirstOrThrow({
      where: { importBatchId: pending.result.batchId },
    });
    await prisma.$transaction([
      prisma.cSVImportStageChunk.update({
        where: {
          importBatchId_chunkIndex: {
            importBatchId: chunk.importBatchId,
            chunkIndex: chunk.chunkIndex,
          },
        },
        data: { payloadHash: "0".repeat(64) },
      }),
      prisma.cSVImportBatch.update({
        where: { id: pending.result.batchId },
        data: { attemptCount: 4, nextAttemptAt: new Date(Date.now() - 1_000) },
      }),
    ]);
    expect(await runCsvImportWorkerOnce()).toBe(true);
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({
      where: { id: pending.result.batchId },
    })).toMatchObject({ processingStatus: CsvImportProcessingStatus.FAILED });
    await expect(createStage(csvOf(1), "quota-after-failure")).resolves.toBeDefined();

    await deleteStagedCsvUpload(ctx.user.id, stages[2]!.result.stagedUploadId);
    await expect(createStage(csvOf(1), "quota-after-delete")).resolves.toBeDefined();
  }, 120_000);

  it("shares capacity between staged uploads and legacy confirmation backlog", async () => {
    const now = new Date();
    await prisma.cSVImportBatch.createMany({
      data: Array.from({ length: CSV_STAGE_OUTSTANDING_LIMIT - 1 }, (_, index) => ({
        businessProfileId: ctx.profile.id,
        title: `Staged capacity ${index}`,
        uploadDate: now,
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.STAGED,
        fileReference: `${ctx.profile.id}/staged-capacity-${index}.csv`,
        fileSizeBytes: 1,
        totalRows: 1,
        stageId: randomUUID(),
        stageExpiresAt: new Date(now.getTime() + 60 * 60_000),
        stagedAt: now,
      })),
    });
    const largeBuffer = csvOf(SYNC_ROW_LIMIT + 1);
    const accepted = await confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Legacy capacity holder",
      buffer: largeBuffer,
      originalname: "legacy-capacity.csv",
      columnMapping: MAPPING,
      idempotencyKey: "legacy-capacity-holder",
    });
    expect(accepted.processingStatus).toBe(CsvImportProcessingStatus.PENDING);
    const replay = await confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Legacy capacity holder",
      buffer: largeBuffer,
      originalname: "legacy-capacity.csv",
      columnMapping: MAPPING,
      idempotencyKey: "legacy-capacity-holder",
    });
    expect(replay.batchId).toBe(accepted.batchId);

    const storageCallsAtCapacity = storage.uploadAt.mock.calls.length;
    await expect(confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Legacy over capacity",
      buffer: csvOf(1),
      originalname: "legacy-over-capacity.csv",
      columnMapping: MAPPING,
      idempotencyKey: "legacy-over-capacity",
    })).rejects.toMatchObject({ status: 429, code: "CSV_STAGE_OUTSTANDING_LIMIT" });
    expect(storage.uploadAt).toHaveBeenCalledTimes(storageCallsAtCapacity);

    downloadedCsv = largeBuffer;
    for (let pass = 0; pass < 10; pass += 1) {
      const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: accepted.batchId } });
      if (batch.processingStatus === CsvImportProcessingStatus.COMPLETE) break;
      expect(await runCsvImportWorkerOnce()).toBe(true);
    }
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: accepted.batchId } })).toMatchObject({
      processingStatus: CsvImportProcessingStatus.COMPLETE,
    });

    await expect(confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Legacy after capacity release",
      buffer: csvOf(1),
      originalname: "legacy-after-release.csv",
      columnMapping: MAPPING,
      idempotencyKey: "legacy-after-release",
    })).resolves.toMatchObject({ processingStatus: CsvImportProcessingStatus.COMPLETE });
  }, 120_000);

  it("rejects the staged-byte quota before Storage or chunk persistence", async () => {
    const now = new Date();
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Byte quota holder",
        uploadDate: now,
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.PENDING,
        fileReference: `${ctx.profile.id}/byte-quota.csv`,
        fileSizeBytes: CSV_STAGE_OUTSTANDING_BYTES_LIMIT,
        totalRows: 1,
      },
    });

    await expect(createStage(csvOf(1), "byte-quota-overflow")).rejects.toMatchObject({
      status: 413,
      code: "CSV_STAGE_STORAGE_LIMIT",
    });
    expect(storage.uploadAt).not.toHaveBeenCalled();
    expect(await prisma.cSVImportStageChunk.count()).toBe(0);
    expect(await prisma.apiRateLimit.count({
      where: { key: { startsWith: `csv-stage-create:u${ctx.user.id}:` } },
    })).toBe(0);
  });

  it("does not charge replay twice and enforces the durable rolling creation cap", async () => {
    const buffer = csvOf(1);
    const staged = await createStage(buffer, "hourly-quota-replay");
    const replay = await createStage(buffer, "hourly-quota-replay");
    expect(replay.result.stagedUploadId).toBe(staged.result.stagedUploadId);
    const keyPrefix = `csv-stage-create:u${ctx.user.id}:`;
    expect(await prisma.apiRateLimit.count({ where: { key: { startsWith: keyPrefix } } })).toBe(1);
    expect(storage.uploadAt).toHaveBeenCalledTimes(1);

    await deleteStagedCsvUpload(ctx.user.id, staged.result.stagedUploadId);
    const now = new Date();
    await prisma.apiRateLimit.createMany({
      data: Array.from({ length: CSV_STAGE_CREATION_HOURLY_LIMIT - 1 }, (_, index) => ({
        key: `${keyPrefix}seed-${index}`,
        windowStart: now,
        count: 1,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
      })),
    });
    const batchesBefore = await prisma.cSVImportBatch.count();
    const chunksBefore = await prisma.cSVImportStageChunk.count();
    await expect(createStage(csvOf(1), "hourly-quota-overflow")).rejects.toMatchObject({
      status: 429,
      code: "CSV_STAGE_HOURLY_LIMIT",
      responseDetails: { retryAfterSeconds: expect.any(Number) },
    });
    expect(storage.uploadAt).toHaveBeenCalledTimes(1);
    expect(await prisma.cSVImportBatch.count()).toBe(batchesBefore);
    expect(await prisma.cSVImportStageChunk.count()).toBe(chunksBefore);
    expect(await prisma.apiRateLimit.count({ where: { key: { startsWith: keyPrefix } } }))
      .toBe(CSV_STAGE_CREATION_HOURLY_LIMIT);
  });

  it("does not let a stage cross profiles, even when one user owns both profiles", async () => {
    const staged = await createStage();
    const secondProfile = await makeProfile(ctx.user.id, { name: "Second store" });
    const otherOwner = await makeOwnerWithProfile({ name: "Other owner" }, ["Inventory"]);

    await expect(previewStagedCsv(
      ctx.user.id,
      secondProfile.id,
      staged.result.stagedUploadId,
      PREVIEW_OPTIONS,
    )).rejects.toMatchObject({ status: 404, code: "CSV_STAGE_NOT_FOUND" });
    await expect(confirmStagedImport(
      ctx.user.id,
      secondProfile.id,
      staged.result.stagedUploadId,
      confirmInput(),
    )).rejects.toMatchObject({ status: 404, code: "CSV_STAGE_NOT_FOUND" });
    await expect(previewStagedCsv(
      otherOwner.user.id,
      otherOwner.profile.id,
      staged.result.stagedUploadId,
      PREVIEW_OPTIONS,
    )).rejects.toMatchObject({ status: 404, code: "CSV_STAGE_NOT_FOUND" });
    await expect(confirmStagedImport(
      otherOwner.user.id,
      otherOwner.profile.id,
      staged.result.stagedUploadId,
      confirmInput(),
    )).rejects.toMatchObject({ status: 404, code: "CSV_STAGE_NOT_FOUND" });

    expect(await prisma.cSVImportBatch.count({ where: { stageId: staged.result.stagedUploadId } })).toBe(1);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("does not disclose a stage ID that does not exist", async () => {
    const missingStageId = randomUUID();

    await expect(previewStagedCsv(
      ctx.user.id,
      ctx.profile.id,
      missingStageId,
      PREVIEW_OPTIONS,
    )).rejects.toMatchObject({ status: 404, code: "CSV_STAGE_NOT_FOUND" });
    await expect(confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      missingStageId,
      confirmInput(),
    )).rejects.toMatchObject({ status: 404, code: "CSV_STAGE_NOT_FOUND" });
  });

  it("rejects an extremely wide CSV before Storage or staged rows are written", async () => {
    const columnCount = 10_000;
    const headers = Array.from({ length: columnCount }, (_, index) => `h${index}`).join(",");
    const buffer = Buffer.from(`${headers}\n${",".repeat(columnCount - 1)}`);
    expect(buffer.byteLength).toBeLessThan(5 * 1024 * 1024);

    await expect(createStage(buffer, "extremely-wide-empty-csv")).rejects.toMatchObject({
      status: 400,
      code: "CSV_HEADER_LIMIT_EXCEEDED",
    });
    expect(storage.uploadAt).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.count()).toBe(0);
    expect(await prisma.cSVImportStageChunk.count()).toBe(0);
  });

  it("rejects a header longer than the mapping contract before staging", async () => {
    const overlongHeader = "h".repeat(256);
    const buffer = Buffer.from(`${overlongHeader},Amount\nvalue,100`);

    await expect(createStage(buffer, "overlong-header")).rejects.toMatchObject({
      status: 400,
      code: "CSV_HEADER_LIMIT_EXCEEDED",
    });
    expect(storage.uploadAt).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.count()).toBe(0);
    expect(await prisma.cSVImportStageChunk.count()).toBe(0);
  });

  it("caps a sub-5 MiB matrix of empty cells before staging", async () => {
    const columnCount = 256;
    const rowCount = Math.floor(1_000_000 / columnCount) + 1;
    const headers = Array.from({ length: columnCount }, (_, index) => `h${index}`).join(",");
    const emptyRow = ",".repeat(columnCount - 1);
    const buffer = Buffer.from(`${headers}\n${Array(rowCount).fill(emptyRow).join("\n")}`);
    expect(buffer.byteLength).toBeLessThan(5 * 1024 * 1024);

    await expect(createStage(buffer, "empty-cell-matrix")).rejects.toMatchObject({
      status: 413,
      code: "CSV_PARSE_LIMIT_EXCEEDED",
    });
    expect(storage.uploadAt).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.count()).toBe(0);
    expect(await prisma.cSVImportStageChunk.count()).toBe(0);
  }, 30_000);

  it("rejects an oversized record before Storage or staged rows are written", async () => {
    const buffer = Buffer.from(`Date,Description,Amount\n${utcDayString(0)},${"x".repeat(300 * 1024)},100`);
    expect(buffer.byteLength).toBeLessThan(5 * 1024 * 1024);

    await expect(createStage(buffer, "oversized-record")).rejects.toMatchObject({
      status: 413,
      code: "CSV_PARSE_LIMIT_EXCEEDED",
    });
    expect(storage.uploadAt).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.count()).toBe(0);
    expect(await prisma.cSVImportStageChunk.count()).toBe(0);
  });

  it("makes stage deletion owner-scoped and idempotent", async () => {
    const staged = await createStage();
    const other = await makeOwnerWithProfile({ name: "Other owner" }, ["Inventory"]);

    await expect(deleteStagedCsvUpload(other.user.id, staged.result.stagedUploadId)).resolves.toBeUndefined();
    expect(await prisma.cSVImportBatch.count({ where: { stageId: staged.result.stagedUploadId } })).toBe(1);

    await expect(deleteStagedCsvUpload(ctx.user.id, staged.result.stagedUploadId)).resolves.toBeUndefined();
    await expect(deleteStagedCsvUpload(ctx.user.id, staged.result.stagedUploadId)).resolves.toBeUndefined();
    expect(await prisma.cSVImportBatch.count({ where: { stageId: staged.result.stagedUploadId } })).toBe(0);
    expect(await prisma.cSVSourcePurgeJob.count()).toBe(1);
  });

  it("expires a stage without exposing or importing its data", async () => {
    const staged = await createStage();
    await prisma.cSVImportBatch.update({
      where: { stageId: staged.result.stagedUploadId },
      data: { stageExpiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(previewStagedCsv(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      PREVIEW_OPTIONS,
    )).rejects.toMatchObject({ status: 410, code: "CSV_STAGE_EXPIRED" });
    expect(await prisma.cSVImportBatch.count({ where: { stageId: staged.result.stagedUploadId } })).toBe(0);
    expect(await prisma.cSVSourcePurgeJob.count()).toBe(1);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("drains expired stages in bounded passes without touching fresh or live stages", async () => {
    const expiredAt = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);
    await prisma.cSVImportBatch.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        businessProfileId: ctx.profile.id,
        title: `Expired ${index}`,
        uploadDate: expiredAt,
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.STAGED,
        fileReference: `${ctx.profile.id}/expired-${index}.csv`,
        stageId: randomUUID(),
        stageExpiresAt: expiredAt,
        stagedAt: expiredAt,
      })),
    });
    const fresh = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Fresh review",
        uploadDate: new Date(),
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.STAGED,
        fileReference: `${ctx.profile.id}/fresh.csv`,
        stageId: randomUUID(),
        stageExpiresAt: future,
        stagedAt: new Date(),
      },
    });
    const live = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Live upload",
        uploadDate: new Date(),
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.STAGING,
        fileReference: `${ctx.profile.id}/live.csv`,
        stageId: randomUUID(),
        stageExpiresAt: future,
        heartbeatAt: new Date(),
        workerId: "stage:test-live",
      },
    });
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Stale upload",
        uploadDate: expiredAt,
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.STAGING,
        fileReference: `${ctx.profile.id}/stale.csv`,
        stageId: randomUUID(),
        stageExpiresAt: future,
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        workerId: "stage:test-stale",
      },
    });

    expect(await sweepExpiredCsvStages()).toBe(100);
    expect(await sweepExpiredCsvStages()).toBe(6);
    expect(await sweepExpiredCsvStages()).toBe(0);
    expect(await prisma.cSVImportBatch.findMany({
      where: { id: { in: [fresh.id, live.id] } },
      orderBy: { id: "asc" },
      select: { id: true },
    })).toEqual([{ id: fresh.id }, { id: live.id }]);
  }, 30_000);

  it.each([
    ["staged", CsvImportProcessingStatus.STAGING],
    ["legacy", CsvImportProcessingStatus.PROCESSING],
  ] as const)("defers cleanup for a killed %s upload until the late-commit grace expires", async (_mode, status) => {
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    const reference = `${ctx.profile.id}/killed-${status.toLowerCase()}.csv`;
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: `Killed ${status}`,
        uploadDate: old,
        createdAt: old,
        status: "Needs Review",
        processingStatus: status,
        fileReference: reference,
        fileSizeBytes: 100,
        totalRows: 1,
        stageId: status === CsvImportProcessingStatus.STAGING ? randomUUID() : null,
        stageExpiresAt: status === CsvImportProcessingStatus.STAGING
          ? new Date(Date.now() + 60 * 60_000)
          : null,
        heartbeatAt: old,
        workerId: "killed-request",
        attemptCount: status === CsvImportProcessingStatus.PROCESSING ? 5 : 0,
      },
    });
    const storedObjects = new Set<string>();
    storage.remove.mockImplementation(async (fileReference) => {
      storedObjects.delete(fileReference);
      return true;
    });

    if (status === CsvImportProcessingStatus.STAGING) {
      expect(await sweepExpiredCsvStages()).toBe(1);
      expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    } else {
      expect(await sweepStalledCsvImports()).toBe(1);
      expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        processingStatus: CsvImportProcessingStatus.FAILED,
        fileReference: null,
      });
    }

    const tombstone = await prisma.cSVSourcePurgeJob.findFirstOrThrow({
      where: { fileReference: reference },
      orderBy: { nextAttemptAt: "desc" },
    });
    expect(tombstone.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(false);
    expect(storage.remove).not.toHaveBeenCalled();

    storedObjects.add(reference);
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(false);
    expect(storedObjects.has(reference)).toBe(true);
    await prisma.cSVSourcePurgeJob.update({
      where: { id: tombstone.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(storage.remove).toHaveBeenCalledWith(reference);
    expect(storedObjects.has(reference)).toBe(false);
  });

  it.each(["missing", "hash", "row-count"] as const)(
    "fails closed when a staged chunk has a %s integrity failure",
    async (failure) => {
      const staged = await createStage();
      const batch = await prisma.cSVImportBatch.findUniqueOrThrow({
        where: { stageId: staged.result.stagedUploadId },
        include: { stageChunks: true },
      });
      const chunk = batch.stageChunks[0]!;
      if (failure === "missing") {
        await prisma.cSVImportStageChunk.delete({
          where: { importBatchId_chunkIndex: { importBatchId: batch.id, chunkIndex: chunk.chunkIndex } },
        });
      } else if (failure === "hash") {
        await prisma.cSVImportStageChunk.update({
          where: { importBatchId_chunkIndex: { importBatchId: batch.id, chunkIndex: chunk.chunkIndex } },
          data: { payloadHash: "0".repeat(64) },
        });
      } else {
        await prisma.cSVImportStageChunk.update({
          where: { importBatchId_chunkIndex: { importBatchId: batch.id, chunkIndex: chunk.chunkIndex } },
          data: { rowCount: chunk.rowCount - 1 },
        });
      }

      await expect(previewStagedCsv(
        ctx.user.id,
        ctx.profile.id,
        staged.result.stagedUploadId,
        PREVIEW_OPTIONS,
      )).rejects.toMatchObject({ status: 409, code: "CSV_STAGE_UNAVAILABLE" });
      expect(await prisma.expenseRecord.count()).toBe(0);
    },
  );

  it("reconstructs special CSV header names as own string fields", async () => {
    const buffer = Buffer.from(
      `Date,__proto__,constructor,Amount,Category\n${utcDayString(0)},own-proto,own-constructor,100,Inventory`,
    );
    const staged = await createStage(buffer, "prototype-headers");
    const initialRow = staged.result.previewRows[0]!;
    expect(Object.hasOwn(initialRow, "__proto__")).toBe(true);
    expect(initialRow["__proto__"]).toBe("own-proto");
    expect(Object.hasOwn(initialRow, "constructor")).toBe(true);
    expect(initialRow["constructor"]).toBe("own-constructor");

    const checked = await previewStagedCsv(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      {
        recordType: "expense",
        columnMapping: {
          date: "Date",
          description: "__proto__",
          amount: "Amount",
          category: "Category",
        },
      },
    );
    const reconstructed = checked.result.previewRows[0]!;
    expect(Object.hasOwn(reconstructed, "__proto__")).toBe(true);
    expect(reconstructed["__proto__"]).toBe("own-proto");
    expect(Object.hasOwn(reconstructed, "constructor")).toBe(true);
    expect(reconstructed["constructor"]).toBe("own-constructor");
    expect(checked.result.validation).toMatchObject({ validRows: 1, invalidRows: 0 });
    expect(({} as Record<string, unknown>)["own-proto"]).toBeUndefined();
  });

  it("never publishes a compressed stage that exceeds its own decode bound", async () => {
    // Backslashes are one byte in CSV but two in JSON, exercising the decoder's inflated-size bound.
    const description = "\\".repeat(4_300_000);
    const buffer = Buffer.from(`Date,Description,Amount\n${utcDayString(0)},${description},100`);
    let staged: Awaited<ReturnType<typeof createStage>>;
    try {
      staged = await createStage(buffer, "decode-bound");
    } catch (error) {
      expect(error).toMatchObject({ status: expect.any(Number) });
      expect((error as { status: number }).status).toBeGreaterThanOrEqual(400);
      expect((error as { status: number }).status).toBeLessThan(500);
      return;
    }

    await expect(previewStagedCsv(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      {
        recordType: "expense",
        columnMapping: { date: "Date", description: "Description", amount: "Amount" },
      },
    )).resolves.toMatchObject({
      result: { stagedUploadId: staged.result.stagedUploadId },
    });
  }, 30_000);

  it("replays the same confirmation but rejects different details", async () => {
    const staged = await createStage();
    const first = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      confirmInput("Original title"),
    );
    const replay = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      confirmInput("Original title"),
    );
    expect(replay.result.batchId).toBe(first.result.batchId);
    expect(await prisma.expenseRecord.count()).toBe(2);

    await expect(confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      confirmInput("Changed title"),
    )).rejects.toMatchObject({ status: 409, code: "CSV_STAGE_CONFIRM_CONFLICT" });
    await expect(deleteStagedCsvUpload(
      ctx.user.id,
      staged.result.stagedUploadId,
    )).rejects.toMatchObject({ status: 409, code: "CSV_STAGE_ALREADY_CONFIRMED" });
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("serializes confirm against delete so at most one action wins", async () => {
    const staged = await createStage();
    const outcomes = await Promise.allSettled([
      confirmStagedImport(
        ctx.user.id,
        ctx.profile.id,
        staged.result.stagedUploadId,
        confirmInput(),
      ),
      deleteStagedCsvUpload(ctx.user.id, staged.result.stagedUploadId),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect([0, 2]).toContain(await prisma.expenseRecord.count());
    expect(await prisma.cSVImportBatch.count()).toBeLessThanOrEqual(1);
  });

  it("fails closed when confirmation races expiry cleanup", async () => {
    const staged = await createStage(csvOf(2), "expiry-confirm-race");
    await prisma.cSVImportBatch.update({
      where: { stageId: staged.result.stagedUploadId },
      data: { stageExpiresAt: new Date(Date.now() - 1_000) },
    });

    const [confirmation, deletion, sweep] = await Promise.allSettled([
      confirmStagedImport(
        ctx.user.id,
        ctx.profile.id,
        staged.result.stagedUploadId,
        confirmInput(),
      ),
      deleteStagedCsvUpload(ctx.user.id, staged.result.stagedUploadId),
      sweepExpiredCsvStages(),
    ]);

    expect(confirmation.status).toBe("rejected");
    if (confirmation.status === "rejected") {
      expect(["CSV_STAGE_EXPIRED", "CSV_STAGE_NOT_FOUND"]).toContain(
        (confirmation.reason as { code?: string }).code,
      );
    }
    expect(deletion.status).toBe("fulfilled");
    expect(sweep.status).toBe("fulfilled");
    expect(await prisma.cSVImportBatch.count({
      where: { stageId: staged.result.stagedUploadId },
    })).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("retains parsed chunks across a worker retry and removes them on completion", async () => {
    const staged = await createStage(csvOf(SYNC_ROW_LIMIT + 1), "chunk-retry");
    const accepted = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      confirmInput(),
    );
    expect(accepted.result.processingStatus).toBe(CsvImportProcessingStatus.PENDING);
    const firstChunk = await prisma.cSVImportStageChunk.findFirstOrThrow({
      where: { importBatchId: accepted.result.batchId },
      orderBy: { chunkIndex: "asc" },
    });
    await prisma.cSVImportStageChunk.update({
      where: {
        importBatchId_chunkIndex: {
          importBatchId: firstChunk.importBatchId,
          chunkIndex: firstChunk.chunkIndex,
        },
      },
      data: { payloadHash: "0".repeat(64) },
    });

    expect(await runCsvImportWorkerOnce()).toBe(true);
    let batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: accepted.result.batchId } });
    expect(batch.processingStatus).toBe(CsvImportProcessingStatus.PENDING);
    expect(await prisma.cSVImportStageChunk.count({ where: { importBatchId: batch.id } })).toBeGreaterThan(0);

    await prisma.cSVImportStageChunk.update({
      where: {
        importBatchId_chunkIndex: {
          importBatchId: firstChunk.importBatchId,
          chunkIndex: firstChunk.chunkIndex,
        },
      },
      data: { payloadHash: firstChunk.payloadHash },
    });
    await prisma.cSVImportBatch.update({
      where: { id: batch.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    expect(await runCsvImportWorkerOnce()).toBe(true);

    batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: accepted.result.batchId } });
    expect(batch.processingStatus).toBe(CsvImportProcessingStatus.COMPLETE);
    expect(await prisma.cSVImportStageChunk.count({ where: { importBatchId: batch.id } })).toBe(0);
    expect(storage.download).not.toHaveBeenCalled();
    expect(await prisma.expenseRecord.count()).toBe(SYNC_ROW_LIMIT + 1);
  }, 120_000);

  it("removes parsed chunks when a worker failure exhausts its attempts", async () => {
    const staged = await createStage(csvOf(SYNC_ROW_LIMIT + 1), "chunk-terminal-failure");
    const accepted = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      confirmInput(),
    );
    const chunk = await prisma.cSVImportStageChunk.findFirstOrThrow({
      where: { importBatchId: accepted.result.batchId },
    });
    await prisma.$transaction([
      prisma.cSVImportStageChunk.update({
        where: {
          importBatchId_chunkIndex: {
            importBatchId: chunk.importBatchId,
            chunkIndex: chunk.chunkIndex,
          },
        },
        data: { payloadHash: "0".repeat(64) },
      }),
      prisma.cSVImportBatch.update({
        where: { id: accepted.result.batchId },
        data: { attemptCount: 4, nextAttemptAt: new Date(Date.now() - 1_000) },
      }),
    ]);

    expect(await runCsvImportWorkerOnce()).toBe(true);
    const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: accepted.result.batchId } });
    expect(batch.processingStatus).toBe(CsvImportProcessingStatus.FAILED);
    expect(await prisma.cSVImportStageChunk.count({ where: { importBatchId: batch.id } })).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);
  }, 60_000);

  it("removes parsed chunks when the stalled-import sweep terminalizes a batch", async () => {
    const staged = await createStage(csvOf(SYNC_ROW_LIMIT + 1), "chunk-stalled-sweep");
    const accepted = await confirmStagedImport(
      ctx.user.id,
      ctx.profile.id,
      staged.result.stagedUploadId,
      confirmInput(),
    );
    await prisma.cSVImportBatch.update({
      where: { id: accepted.result.batchId },
      data: {
        createdAt: new Date(Date.now() - 25 * 60 * 60_000),
        attemptCount: 5,
      },
    });

    expect(await sweepStalledCsvImports()).toBe(1);
    const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: accepted.result.batchId } });
    expect(batch.processingStatus).toBe(CsvImportProcessingStatus.FAILED);
    expect(await prisma.cSVImportStageChunk.count({ where: { importBatchId: batch.id } })).toBe(0);
  });

  it.each(["staged", "legacy"] as const)(
    "keeps a not-before tombstone when a rejected %s upload may commit late",
    async (mode) => {
      const lostResponse = new Error("upload response was lost before remote commit became visible");
      const storedObjects = new Set<string>();
      let reservedReference: string | null = null;
      let tombstoneExistedAtFirstDelete = false;
      let deleteCalls = 0;
      storage.uploadAt.mockImplementationOnce(async (_businessProfileId, fileReference) => {
        reservedReference = fileReference;
        throw lostResponse;
      });
      storage.remove.mockImplementation(async (fileReference) => {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          tombstoneExistedAtFirstDelete = await prisma.cSVSourcePurgeJob.count({
            where: {
              fileReference,
              nextAttemptAt: { gt: new Date(Date.now() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS / 2) },
            },
          }) > 0;
        }
        storedObjects.delete(fileReference);
        return true;
      });

      const startedAt = Date.now();
      const upload = mode === "staged"
        ? createStage(csvOf(1), "late-commit-staged")
        : confirmImport(ctx.user.id, {
            businessProfileId: ctx.profile.id,
            recordType: "expense",
            title: "Late commit legacy",
            buffer: csvOf(1),
            originalname: "late-commit.csv",
            columnMapping: MAPPING,
            idempotencyKey: "late-commit-legacy",
          });
      await expect(upload).rejects.toBe(lostResponse);
      if (!reservedReference) throw new Error("upload never reserved an exact file reference");
      expect(tombstoneExistedAtFirstDelete).toBe(true);

      const tombstone = await prisma.cSVSourcePurgeJob.findFirstOrThrow({
        where: { fileReference: reservedReference },
        orderBy: { nextAttemptAt: "desc" },
      });
      expect(tombstone.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        startedAt + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS - 1_000,
      );
      expect(tombstone.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS + 1_000,
      );

      for (let pass = 0; pass < 5 && await runCsvSourcePurgeWorkerOnce(); pass += 1);
      const deletesBeforeLateCommit = deleteCalls;
      storedObjects.add(reservedReference);
      await prisma.user.update({
        where: { id: ctx.user.id },
        data: {
          status: AccountStatus.DELETION_PENDING,
          deletionRequestedAt: new Date(),
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionNextAttemptAt: new Date(),
        },
      });

      expect(await runAccountDeletionWorkerOnce()).toBe(true);
      expect(storedObjects.has(reservedReference)).toBe(true);
      expect(deleteCalls).toBe(deletesBeforeLateCommit);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
        deletionStage: AccountDeletionStage.REQUESTED,
        deletionAttempts: 0,
        deletionWorkerId: null,
      });

      await prisma.$transaction([
        prisma.cSVSourcePurgeJob.updateMany({
          where: { fileReference: reservedReference },
          data: { nextAttemptAt: new Date(Date.now() - 1_000) },
        }),
        prisma.user.update({
          where: { id: ctx.user.id },
          data: { deletionNextAttemptAt: new Date(Date.now() - 1_000) },
        }),
      ]);
      expect(await runAccountDeletionWorkerOnce()).toBe(true);
      expect(storedObjects.has(reservedReference)).toBe(false);
      expect(deleteCalls).toBe(deletesBeforeLateCommit + 1);
      expect(await prisma.cSVSourcePurgeJob.findUniqueOrThrow({ where: { id: tombstone.id } })).toMatchObject({
        status: "COMPLETE",
        fileReference: null,
      });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
        deletionStage: AccountDeletionStage.STORAGE_CLEARED,
      });
    },
  );

  it("compensates a late upload when account deletion starts before finalization", async () => {
    let signalUploadStarted!: () => void;
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
    const uploadRelease = new Promise<void>((resolve) => { releaseUpload = resolve; });
    storage.uploadAt.mockImplementationOnce(async () => {
      signalUploadStarted();
      await uploadRelease;
    });

    const inFlight = createStage(csvOf(2), "late-account-deletion");
    await uploadStarted;
    const reservation = await prisma.cSVImportBatch.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id },
    });
    expect(reservation.processingStatus).toBe(CsvImportProcessingStatus.STAGING);
    expect(reservation.fileReference).not.toBeNull();

    await prisma.$transaction([
      prisma.cSVImportBatch.update({
        where: { id: reservation.id },
        data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
      }),
      prisma.user.update({
        where: { id: ctx.user.id },
        data: {
          status: AccountStatus.DELETION_PENDING,
          deletionRequestedAt: new Date(),
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionNextAttemptAt: new Date(),
        },
      }),
    ]);
    // The first exact-path delete is a no-op because the object has not landed yet.
    storage.remove.mockResolvedValueOnce(true);
    // Fail direct compensation once to prove the late path is queued durably.
    storage.remove.mockResolvedValueOnce(false);
    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });

    releaseUpload();
    await expect(inFlight).rejects.toMatchObject({ status: 409, code: "CSV_STAGE_NOT_FOUND" });
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: reservation.id } })).toBeNull();
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionWorkerId: null,
    });
    const queued = await prisma.cSVSourcePurgeJob.findMany({
      where: { fileReference: reservation.fileReference },
    });
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.some((job) => job.status === "PENDING")).toBe(true);
    expect(storage.remove).toHaveBeenNthCalledWith(1, reservation.fileReference);
    expect(storage.remove).toHaveBeenNthCalledWith(2, reservation.fileReference);

    await makeCsvPurgesDue(reservation.fileReference);
    for (let pass = 0; pass < 5 && await runCsvSourcePurgeWorkerOnce(); pass += 1);
    expect(await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: reservation.fileReference },
    })).toBe(0);
  });

  it("queues staged bytes when Storage writes them but loses the upload response", async () => {
    let signalUploadStarted!: () => void;
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
    const uploadRelease = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const storedObjects = new Set<string>();
    let uploadedReference: string | null = null;
    let failedStoredDelete = false;
    const lostResponse = new Error("Storage response lost after write");
    storage.uploadAt.mockImplementationOnce(async (_businessProfileId, fileReference) => {
      uploadedReference = fileReference;
      signalUploadStarted();
      await uploadRelease;
      storedObjects.add(fileReference);
      throw lostResponse;
    });
    storage.remove.mockImplementation(async (fileReference) => {
      if (!storedObjects.has(fileReference)) return true;
      if (!failedStoredDelete) {
        failedStoredDelete = true;
        return false;
      }
      storedObjects.delete(fileReference);
      return true;
    });

    const inFlight = createStage(csvOf(2), "staged-stored-response-lost");
    await uploadStarted;
    const reservation = await prisma.cSVImportBatch.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id },
    });
    await prisma.$transaction([
      prisma.cSVImportBatch.update({
        where: { id: reservation.id },
        data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
      }),
      prisma.user.update({
        where: { id: ctx.user.id },
        data: {
          status: AccountStatus.DELETION_PENDING,
          deletionRequestedAt: new Date(),
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionNextAttemptAt: new Date(),
        },
      }),
    ]);

    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });
    releaseUpload();
    await expect(inFlight).rejects.toBe(lostResponse);

    expect(uploadedReference).toBe(reservation.fileReference);
    expect(storedObjects.has(reservation.fileReference!)).toBe(true);
    expect(failedStoredDelete).toBe(true);
    expect(storage.remove).toHaveBeenNthCalledWith(1, reservation.fileReference);
    expect(storage.remove).toHaveBeenNthCalledWith(2, reservation.fileReference);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionWorkerId: null,
    });
    expect(await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: reservation.fileReference, status: "PENDING" },
    })).toBeGreaterThan(0);

    await makeCsvPurgesDue(reservation.fileReference);
    for (let pass = 0; pass < 5 && await runCsvSourcePurgeWorkerOnce(); pass += 1);
    expect(storedObjects.has(reservation.fileReference!)).toBe(false);
    expect(await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: reservation.fileReference },
    })).toBe(0);
  });

  it("pre-reserves and compensates the legacy multipart upload path", async () => {
    let signalUploadStarted!: () => void;
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
    const uploadRelease = new Promise<void>((resolve) => { releaseUpload = resolve; });
    storage.uploadAt.mockImplementationOnce(async () => {
      signalUploadStarted();
      await uploadRelease;
    });
    const buffer = csvOf(2);
    const inFlight = confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Legacy reservation",
      buffer,
      originalname: "legacy.csv",
      columnMapping: MAPPING,
      idempotencyKey: "legacy-reservation-race",
    });
    await uploadStarted;
    const reservation = await prisma.cSVImportBatch.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id },
    });
    expect(reservation.processingStatus).toBe(CsvImportProcessingStatus.PROCESSING);
    expect(reservation.fileReference).not.toBeNull();

    await prisma.$transaction([
      prisma.cSVImportBatch.update({
        where: { id: reservation.id },
        data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
      }),
      prisma.user.update({
        where: { id: ctx.user.id },
        data: {
          status: AccountStatus.DELETION_PENDING,
          deletionRequestedAt: new Date(),
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionNextAttemptAt: new Date(),
        },
      }),
    ]);
    storage.remove.mockReset();
    storage.remove.mockResolvedValue(false);
    storage.remove.mockResolvedValueOnce(true);
    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });

    releaseUpload();
    await expect(inFlight).rejects.toMatchObject({
      status: 409,
      code: "CSV_IMPORT_RESERVATION_LOST",
    });
    const failed = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(failed.processingStatus).toBe(CsvImportProcessingStatus.FAILED);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionWorkerId: null,
    });
    expect(await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: reservation.fileReference, status: "PENDING" },
    })).toBeGreaterThan(0);

    storage.remove.mockResolvedValue(true);
    await makeCsvPurgesDue(reservation.fileReference);
    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(storage.remove).toHaveBeenLastCalledWith(reservation.fileReference);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });
  });

  it("queues legacy bytes when Storage writes them but loses the upload response", async () => {
    let signalUploadStarted!: () => void;
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
    const uploadRelease = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const storedObjects = new Set<string>();
    let uploadedReference: string | null = null;
    let failedStoredDelete = false;
    const lostResponse = new Error("Storage response lost after write");
    storage.uploadAt.mockImplementationOnce(async (_businessProfileId, fileReference) => {
      uploadedReference = fileReference;
      signalUploadStarted();
      await uploadRelease;
      storedObjects.add(fileReference);
      throw lostResponse;
    });
    storage.remove.mockImplementation(async (fileReference) => {
      if (!storedObjects.has(fileReference)) return true;
      if (!failedStoredDelete) {
        failedStoredDelete = true;
        return false;
      }
      storedObjects.delete(fileReference);
      return true;
    });

    const buffer = csvOf(2);
    const inFlight = confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Legacy response lost",
      buffer,
      originalname: "legacy-lost.csv",
      columnMapping: MAPPING,
      idempotencyKey: "legacy-stored-response-lost",
    });
    await uploadStarted;
    const reservation = await prisma.cSVImportBatch.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id },
    });
    await prisma.$transaction([
      prisma.cSVImportBatch.update({
        where: { id: reservation.id },
        data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
      }),
      prisma.user.update({
        where: { id: ctx.user.id },
        data: {
          status: AccountStatus.DELETION_PENDING,
          deletionRequestedAt: new Date(),
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionNextAttemptAt: new Date(),
        },
      }),
    ]);

    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });
    releaseUpload();
    await expect(inFlight).rejects.toBe(lostResponse);

    expect(uploadedReference).toBe(reservation.fileReference);
    expect(storedObjects.has(reservation.fileReference!)).toBe(true);
    expect(failedStoredDelete).toBe(true);
    expect(storage.remove).toHaveBeenNthCalledWith(1, reservation.fileReference);
    expect(storage.remove).toHaveBeenNthCalledWith(2, reservation.fileReference);
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      processingStatus: CsvImportProcessingStatus.FAILED,
      fileReference: null,
    });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionWorkerId: null,
    });
    expect(await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: reservation.fileReference, status: "PENDING" },
    })).toBeGreaterThan(0);

    await makeCsvPurgesDue(reservation.fileReference);
    for (let pass = 0; pass < 5 && await runCsvSourcePurgeWorkerOnce(); pass += 1);
    expect(storedObjects.has(reservation.fileReference!)).toBe(false);
    expect(await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: reservation.fileReference },
    })).toBe(0);
  });
});
