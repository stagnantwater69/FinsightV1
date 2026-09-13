import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/services/storage.service", () => ({
  uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
  downloadCsvFile: vi.fn(async () => uploadedBuffer),
  deleteCsvFile: vi.fn(async () => true),
  uploadReceiptImage: vi.fn(async () => "test/mock-receipt.jpg"),
}));

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { runCsvImportWorkerOnce, SYNC_ROW_LIMIT } from "../../src/services/csvImport.service";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let uploadedBuffer = Buffer.from("");
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const BASE = "/api/v1/records/csv-imports";

const MAPPING = JSON.stringify({
  date: "Date",
  description: "Description",
  amount: "Amount",
  category: "Category",
});

beforeEach(async () => {
  await resetDb();
  // Under NODE_ENV=test the limiter is the in-memory backend, which resetDb
  // cannot truncate — without this, confirms accumulate across cases in this
  // file and later tests answer 429 for reasons that have nothing to do with
  // what they assert. (That the counter accumulates at all is the limiter
  // working; the per-minute confirm cap is asserted directly below.)
  resetRateLimits();
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

describe("CSV import over HTTP", () => {
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
