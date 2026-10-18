import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

let uploadedBuffer: Buffer = Buffer.from("");
vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
    uploadCsvFileAtReference: vi.fn(async () => "test/mock-csv-path.csv"),
    downloadCsvFile: vi.fn(async () => uploadedBuffer),
    deleteCsvFile: vi.fn(async () => true),
  };
});

import { countDbOperations } from "../../src/lib/requestTiming";
import { confirmImport, runCsvImportWorkerOnce } from "../../src/services/csvImport.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * Database round trips for a whole CSV import, the in-request path and the
 * worker path. Same reasoning as roundTripBudget.test.ts: the count is what a
 * remote database multiplies.
 */
/** Counts measured on 2026-10-18: flat in the row count, which is what a remote database rewards. */
const BUDGET: Record<string, number> = { "100 rows (in request)": 26, "1,000 rows (in request)": 26, "3,000 rows (worker)": 45 };
const measured: { action: string; dbOperations: number; ms: number }[] = [];
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
});

afterAll(async () => {
  console.log(`\ncsv import round trips\n${measured.map((m) => `  ${m.action.padEnd(24)} ${String(m.dbOperations).padStart(5)} ops  ${Math.round(m.ms)} ms`).join("\n")}`);
  await disconnectDb();
});

function csvOf(rows: number): Buffer {
  const lines = ["Date,Description,Amount,Category"];
  for (let index = 0; index < rows; index += 1) lines.push(`${utcDayString(-(index % 300))},Item ${index},${100 + index},Inventory`);
  return Buffer.from(lines.join("\n"));
}

async function importRows(action: string, rows: number) {
  uploadedBuffer = csvOf(rows);
  const started = performance.now();
  const { result, dbOperations } = await countDbOperations(async () => {
    const confirmed = await confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: action,
      buffer: uploadedBuffer,
      originalname: "books.csv",
      columnMapping: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
    });
    for (let pass = 0; pass < 200 && (await runCsvImportWorkerOnce()); pass += 1) { /* drain */ }
    return confirmed;
  });
  measured.push({ action, dbOperations, ms: performance.now() - started });
  return { result, dbOperations };
}

describe("database round trips per CSV import", () => {
  it.each([
    ["100 rows (in request)", 100],
    ["1,000 rows (in request)", 1_000],
    ["3,000 rows (worker)", 3_000],
  ] as const)("%s", async (action, rows) => {
    const { dbOperations } = await importRows(action, rows);
    expect(dbOperations, `${action} made ${dbOperations} round trips`).toBeLessThanOrEqual(BUDGET[action]!);
  });
});
