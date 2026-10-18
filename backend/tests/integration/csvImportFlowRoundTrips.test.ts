import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authUserId = vi.hoisted(() => ({ value: "" }));
const storageCalls = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async () => ({ data: { user: { id: authUserId.value } }, error: null }) } } };
});
vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  const stored = new Map<string, Buffer>();
  return {
    ...actual,
    uploadCsvFile: vi.fn(async (_profile: number, buffer: Buffer) => { storageCalls.value.push("upload"); stored.set("csv", buffer); return "test/flow.csv"; }),
    uploadCsvFileAtReference: vi.fn(async (ref: string, buffer: Buffer) => { storageCalls.value.push("upload"); stored.set(ref, buffer); return ref; }),
    downloadCsvFile: vi.fn(async (ref: string) => { storageCalls.value.push("download"); return stored.get(ref) ?? stored.get("csv")!; }),
    deleteCsvFile: vi.fn(async () => { storageCalls.value.push("delete"); return true; }),
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { observeRequestTiming, type CompletedRequestTiming } from "../../src/lib/requestTiming";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * Round trips and storage calls for a CSV import the way the apps make one:
 * stage the file, review it with a mapping, confirm.
 */
const AUTH = ["Authorization", "Bearer synthetic-token"] as const;
/** Counts measured on 2026-10-18. At 60 ms per round trip: stage 0.93 s, review 0.48 s, confirm 1.65 s. */
const BUDGET = { stage: 11, review: 8, confirm: 22 } as const;
const MAPPING = { date: "Date", description: "Description", amount: "Amount", category: "Category" };
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let finished: CompletedRequestTiming[] = [];
let stop: () => void = () => {};
const measured: string[] = [];

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
  storageCalls.value = [];
  finished = [];
  stop = observeRequestTiming((timing) => finished.push(timing));
});
afterEach(() => stop());
afterAll(async () => {
  console.log(`\ncsv import flow\n${measured.join("\n")}`);
  await disconnectDb();
});

function csvOf(rows: number): Buffer {
  const lines = ["Date,Description,Amount,Category"];
  for (let index = 0; index < rows; index += 1) lines.push(`${utcDayString(-(index % 200))},Item ${index},${100 + index},Inventory`);
  return Buffer.from(lines.join("\n"));
}

async function step(label: keyof typeof BUDGET, send: () => request.Test) {
  finished = [];
  const before = storageCalls.value.length;
  const response = await send();
  expect(response.status, `${label}: ${JSON.stringify(response.body).slice(0, 300)}`).toBeLessThan(300);
  const timing = finished[0]!;
  const storage = storageCalls.value.slice(before);
  measured.push(`  ${label.padEnd(22)} ${String(timing.dbOperations).padStart(3)} ops  ${storage.length} storage [${storage.join(",")}]  ${Math.round(timing.totalMs)} ms`);
  expect(timing.dbOperations, `${label} made ${timing.dbOperations} round trips`).toBeLessThanOrEqual(BUDGET[label]);
  return { response, dbOperations: timing.dbOperations, storage: storage.length };
}

describe("CSV import flow as the apps make it", () => {
  it("stages, reviews and confirms 200 rows", async () => {
    const file = csvOf(200);
    const staged = await step("stage", () => request(app).post("/api/v1/records/csv-imports/preview").set(...AUTH)
      .field("businessProfileId", String(ctx.profile.id)).field("idempotencyKey", "flow-stage-key-1")
      .attach("file", file, { filename: "books.csv", contentType: "text/csv" }));
    const stagedUploadId = staged.response.body.stagedUploadId as string;
    expect(stagedUploadId).toBeTruthy();

    await step("review", () => request(app).post("/api/v1/records/csv-imports/preview").set(...AUTH)
      .send({ stagedUploadId, businessProfileId: ctx.profile.id, recordType: "expense", columnMapping: MAPPING }));

    await step("confirm", () => request(app).post("/api/v1/records/csv-imports/confirm").set(...AUTH)
      .send({ stagedUploadId, businessProfileId: ctx.profile.id, recordType: "expense", columnMapping: MAPPING, title: "Flow import", idempotencyKey: "flow-confirm-key-1" }));
  });
});
