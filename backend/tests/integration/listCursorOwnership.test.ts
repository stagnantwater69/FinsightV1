import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const authUserId = vi.hoisted(() => ({ value: "" }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async () => ({ data: { user: { id: authUserId.value } }, error: null }) } } };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { createBusinessProfile } from "../../src/services/businessProfile.service";
import { resolveOperatingCalendar } from "../../src/services/operatingCalendar.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer synthetic-token"] as const;
const CSV = "/api/v1/records/csv-imports/batches";
const CHAT = "/api/v1/ai/conversations";
const tiedAt = new Date("2026-01-01T00:00:00.000Z");
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const overrides = () => `/api/v1/business-profiles/${ctx.profile.id}/operating-overrides`;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

async function seedCsv(count = 105) {
  await prisma.cSVImportBatch.createMany({ data: Array.from({ length: count }, (_, index) => ({
    id: index + 1, businessProfileId: ctx.profile.id, title: index % 2 ? "Other source" : "Inventory archive",
    uploadDate: tiedAt, processingStatus: "COMPLETE" as const, status: "Completed",
  })).reverse() });
}

async function seedThreads(count = 105) {
  await prisma.conversation.createMany({ data: Array.from({ length: count }, (_, index) => ({
    id: index + 1, userId: ctx.user.id, businessProfileId: ctx.profile.id,
    title: `Thread ${index + 1}`, originModule: "Dashboard", lastMessageAt: tiedAt,
  })).reverse() });
}

async function seedOverrides(count = 105) {
  await prisma.businessOperatingDayOverride.createMany({ data: Array.from({ length: count }, (_, index) => ({
    businessProfileId: ctx.profile.id, date: new Date(tiedAt.getTime() + index * 86_400_000), type: "CLOSED" as const,
  })) });
}

async function allPages(path: string, query: Record<string, string | number>, firstCursor?: string) {
  const ids: number[] = [];
  let cursor: string | null | undefined = firstCursor;
  for (let page = 0; page < 12; page += 1) {
    const response = await request(app).get(path).set(...AUTH).query({ ...query, ...(cursor ? { cursor } : {}) });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("items");
    expect(response.body.items.length).toBeLessThanOrEqual(Number(query.pageSize ?? 50));
    ids.push(...response.body.items.map((row: { id: number }) => row.id));
    cursor = response.body.nextCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

describe("bounded owned history pages", () => {
  it("continues a bounded legacy CSV page without dropping equal-date rows", async () => {
    await seedCsv();
    const first = await request(app).get(CSV).set(...AUTH).set("Origin", "http://localhost:5173")
      .query({ businessProfileId: ctx.profile.id });
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(100);
    expect(first.headers["x-next-cursor"]).toBeTruthy();
    expect(first.headers["access-control-expose-headers"]).toContain("X-Next-Cursor");
    const older = await allPages(CSV, { businessProfileId: ctx.profile.id, pageSize: 25 }, first.headers["x-next-cursor"]);
    expect([...first.body.map((row: { id: number }) => row.id), ...older]).toEqual(Array.from({ length: 105 }, (_, index) => 105 - index));
  });

  it("searches all CSV history before pagination and binds the cursor to the search", async () => {
    await seedCsv();
    const matching = await allPages(CSV, { businessProfileId: ctx.profile.id, pageSize: 13, search: "  INVENTORY  " });
    expect(matching).toEqual(Array.from({ length: 53 }, (_, index) => 105 - index * 2));
    const first = await request(app).get(CSV).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize: 1, search: "Inventory" });
    const changed = await request(app).get(CSV).set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, pageSize: 1, search: "Other", cursor: first.body.nextCursor });
    expect(changed.status).toBe(400);
    expect(changed.body.code).toBe("INVALID_PAGINATION_CURSOR");
  });

  it("continues the legacy conversation sidebar through every tied timestamp", async () => {
    await seedThreads();
    const first = await request(app).get(CHAT).set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(50);
    expect(first.headers["x-next-cursor"]).toBeTruthy();
    const older = await allPages(CHAT, { businessProfileId: ctx.profile.id, pageSize: 20 }, first.headers["x-next-cursor"]);
    expect([...first.body.map((row: { id: number }) => row.id), ...older]).toEqual(Array.from({ length: 105 }, (_, index) => 105 - index));
  });

  it("bounds the latest message window and makes every older message reachable in order", async () => {
    await seedThreads(1);
    await prisma.chatMessage.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
      id: index + 1, conversationId: 1, role: index % 2 ? "assistant" : "user", content: `Message ${index + 1}`, createdAt: tiedAt,
    })).reverse() });
    const latest = await request(app).get(`${CHAT}/1`).set(...AUTH);
    expect(latest.status).toBe(200);
    expect(latest.body.messages.map((message: { id: number }) => message.id)).toEqual(Array.from({ length: 100 }, (_, index) => index + 6));
    expect(latest.body.nextCursor).toBeTruthy();
    const older = await request(app).get(`${CHAT}/1`).set(...AUTH).query({ pageSize: 100, cursor: latest.body.nextCursor });
    expect(older.status).toBe(200);
    expect(older.body.messages.map((message: { id: number }) => message.id)).toEqual([1, 2, 3, 4, 5]);
    expect(older.body.nextCursor).toBeNull();
  });

  it("rejects cursors transplanted between owned businesses, owners and list types", async () => {
    await seedCsv(3);
    const first = await request(app).get(CSV).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize: 1 });
    const cursor = first.body.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await createBusinessProfile(ctx.user.id, { name: "Second store", type: "Store", availableFunds: 0, expectedMonthlyExpenses: 0, operatingDays: 20 });
    for (const [path, businessProfileId] of [[CSV, second.id], [CHAT, ctx.profile.id]] as const) {
      const response = await request(app).get(path).set(...AUTH).query({ businessProfileId, pageSize: 1, cursor });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_PAGINATION_CURSOR");
    }
    const other = await makeOwnerWithProfile();
    authUserId.value = other.user.authId;
    const hidden = await request(app).get(CSV).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize: 1, cursor });
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain("Inventory archive");
  });

  it("rejects a deleted cursor position rather than silently advancing", async () => {
    await seedCsv(3);
    const first = await request(app).get(CSV).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize: 1 });
    await prisma.cSVImportBatch.delete({ where: { id: first.body.items[0].id } });
    const response = await request(app).get(CSV).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize: 1, cursor: first.body.nextCursor });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_PAGINATION_CURSOR");
  });

  it("bounds schedule management history while the calendar still resolves overrides beyond page one", async () => {
    await seedOverrides();
    const first = await request(app).get(overrides()).set(...AUTH);
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(100);
    const remaining = await allPages(overrides(), { pageSize: 25 }, first.headers["x-next-cursor"]);
    expect([...first.body.map((row: { id: number }) => row.id), ...remaining]).toHaveLength(105);
    await prisma.businessOperatingDay.createMany({ data: Array.from({ length: 7 }, (_, index) => ({ businessProfileId: ctx.profile.id, weekday: index + 1, isOpen: true })) });
    const calendar = await resolveOperatingCalendar(ctx.profile.id, tiedAt, new Date(tiedAt.getTime() + 104 * 86_400_000));
    expect(calendar?.size).toBe(105);
    expect([...calendar!.values()].every((isOpen) => !isOpen)).toBe(true);
  });

  it("binds override continuation to its date filters", async () => {
    await seedOverrides(3);
    const first = await request(app).get(overrides()).set(...AUTH).query({ from: "2026-01-01", to: "2026-01-03", pageSize: 1 });
    expect(first.body.nextCursor).toBeTruthy();
    const changed = await request(app).get(overrides()).set(...AUTH)
      .query({ from: "2026-01-02", to: "2026-01-03", pageSize: 1, cursor: first.body.nextCursor });
    expect(changed.status).toBe(400);
    expect(changed.body.code).toBe("INVALID_PAGINATION_CURSOR");
  });

  it("rejects invalid limits and malformed cursors on every paginated list", async () => {
    for (const path of [CSV, CHAT, overrides()]) {
      for (const pageSize of [0, 101, 1.5]) {
        const response = await request(app).get(path).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize });
        expect(response.status).toBe(400);
      }
      const response = await request(app).get(path).set(...AUTH).query({ businessProfileId: ctx.profile.id, pageSize: 1, cursor: "malformed?" });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_PAGINATION_CURSOR");
    }
  });
});
