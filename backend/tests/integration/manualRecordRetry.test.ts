import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const state = vi.hoisted(() => ({ authId: "", notifications: vi.fn(), analysis: vi.fn() }));
vi.mock("../../src/config/supabase", async (original) => ({
  ...await original<typeof import("../../src/config/supabase")>(),
  supabaseAdmin: { auth: { getUser: async (token: string) => ({
    data: { user: token === "valid-token" ? { id: state.authId } : null },
    error: token === "valid-token" ? null : new Error("Invalid synthetic token"),
  }) } },
}));
vi.mock("../../src/services/notification.service", async (original) => ({
  ...await original<typeof import("../../src/services/notification.service")>(),
  createNotification: state.notifications,
}));
vi.mock("../../src/services/anomalyDetection/job.service", async (original) => ({
  ...await original<typeof import("../../src/services/anomalyDetection/job.service")>(),
  enqueueExpenseAnalysis: state.analysis,
}));

import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeCategory, makeOwnerWithProfile, makeProfile, resetDb, utcDayString } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const kinds = ["expense", "sales"] as const;
type Kind = typeof kinds[number];
const endpoint = (kind: Kind) => `/api/v1/records/${kind === "expense" ? "expenses" : "sales"}`;
function body(kind: Kind, key = "synthetic-save-0001") {
  return { businessProfileId: ctx.profile.id, date: utcDayString(-1), description: "Synthetic stock purchase", amount: 1234.56,
    ...(kind === "expense" ? { categoryId: ctx.categories.Inventory, vendor: "Synthetic supplier" } : {}), idempotencyKey: key };
}
function post(kind: Kind, payload: ReturnType<typeof body>) {
  return request(app).post(endpoint(kind)).set(...AUTH).send(payload);
}
async function count(kind: Kind): Promise<number> {
  return kind === "expense" ? prisma.expenseRecord.count() : prisma.salesReferenceRecord.count();
}

beforeEach(async () => {
  await resetDb(); resetRateLimits();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]); state.authId = ctx.user.authId;
  state.notifications.mockReset().mockResolvedValue(undefined);
  state.analysis.mockReset().mockResolvedValue(undefined);
});
afterAll(disconnectDb);

describe.each(kinds)("durable manual %s create", (kind) => {
  it("replays a committed save after its response was lost without creating a second financial row", async () => {
    const payload = body(kind);
    // The first response is deliberately unavailable to the simulated caller.
    await post(kind, payload);
    expect(await count(kind)).toBe(1);
    const committed = kind === "expense" ? await prisma.expenseRecord.findFirstOrThrow() : await prisma.salesReferenceRecord.findFirstOrThrow();
    const retry = await post(kind, payload);
    expect(retry.status).toBe(201);
    expect(await count(kind)).toBe(1);
    const stored = kind === "expense" ? await prisma.expenseRecord.findFirstOrThrow() : await prisma.salesReferenceRecord.findFirstOrThrow();
    expect(retry.body.id).toBe(stored.id);
    expect(retry.body.id).toBe(committed.id);
    expect(retry.body.amount).toBe(1234.56);
    expect(Number(stored.amount)).toBe(1234.56);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(1);
    expect(state.analysis).toHaveBeenCalledTimes(kind === "expense" ? 1 : 0);
  });

  it("serializes concurrent same-key requests into one record and one identity", async () => {
    const payload = body(kind);
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(kind, payload)));
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    expect(await count(kind)).toBe(1);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(1);
    expect(state.analysis).toHaveBeenCalledTimes(kind === "expense" ? 1 : 0);
  });

  it.each(["amount", "description", "date", "includedInAvailableFundsBaseline"])("rejects changed %s under a committed key", async (field) => {
    const payload = body(kind); expect((await post(kind, payload)).status).toBe(201);
    const changes = { amount: 3456.78, description: "Different synthetic details", date: utcDayString(-2), includedInAvailableFundsBaseline: false };
    const conflict = await post(kind, { ...payload, [field]: changes[field as keyof typeof changes] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("MANUAL_CREATE_KEY_CONFLICT");
    expect(await count(kind)).toBe(1);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(1);
  });

  it("preserves legitimate identical transactions using different keys and emits duplicate side effects once", async () => {
    const first = await post(kind, body(kind));
    const payload = body(kind, "synthetic-save-0002");
    const second = await post(kind, payload);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: first.body.id, amount: 1234.56 });
    const calls = state.notifications.mock.calls.length;
    const analysisCalls = state.analysis.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const replay = await post(kind, payload);
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(second.body.id);
    expect(await count(kind)).toBe(2);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(2);
    expect(state.notifications).toHaveBeenCalledTimes(calls);
    expect(state.analysis).toHaveBeenCalledTimes(analysisCalls);
  });

  it("keeps a tombstone after deletion and refuses to recreate the deleted save", async () => {
    const payload = body(kind); const first = await post(kind, payload);
    expect(first.status).toBe(201);
    expect((await request(app).delete(`${endpoint(kind)}/${first.body.id}`).set(...AUTH)).status).toBe(204);
    const replay = await post(kind, payload);
    expect(replay.status).toBe(409); expect(replay.body.code).toBe("MANUAL_CREATE_RECORD_DELETED");
    expect(await count(kind)).toBe(0);
    const tombstone = await prisma.manualRecordCreateRequest.findFirstOrThrow();
    expect(tombstone.expenseRecordId).toBeNull(); expect(tombstone.salesRecordId).toBeNull();
    expect(tombstone.expenseRecordBusinessProfileId).toBeNull(); expect(tombstone.salesRecordBusinessProfileId).toBeNull();
  });

  it("replays the original identity after its record is edited and the balance baseline advances", async () => {
    const payload = body(kind); const first = await post(kind, payload);
    expect(first.status).toBe(201);
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: {
      availableFundsBaselineAt: new Date(), availableFundsBaselineDate: new Date(`${utcDayString()}T00:00:00.000Z`),
    } });
    if (kind === "expense") await prisma.expenseRecord.update({ where: { id: first.body.id }, data: { amount: 3456.78 } });
    else await prisma.salesReferenceRecord.update({ where: { id: first.body.id }, data: { amount: 3456.78 } });
    const replay = await post(kind, payload);
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.amount).toBe(3456.78); expect(await count(kind)).toBe(1);
    expect(replay.body.includedInAvailableFundsBaseline).toBe(first.body.includedInAvailableFundsBaseline);
    expect(replay.body.availableFundsDeltaBaselineAt).toBe(first.body.availableFundsDeltaBaselineAt);
  });

  it("rolls back the record when durable identity persistence fails and permits a clean same-key retry", async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION public.qa_fail_manual_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic request persistence failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER qa_fail_manual_request BEFORE INSERT ON "ManualRecordCreateRequest" FOR EACH ROW EXECUTE FUNCTION public.qa_fail_manual_request()`);
    try {
      expect((await post(kind, body(kind))).status).toBe(500);
      expect(await count(kind)).toBe(0); expect(await prisma.manualRecordCreateRequest.count()).toBe(0);
      expect(state.analysis).not.toHaveBeenCalled(); expect(state.notifications).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER qa_fail_manual_request ON "ManualRecordCreateRequest"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION public.qa_fail_manual_request()`);
    }
    expect((await post(kind, body(kind))).status).toBe(201);
    expect(await count(kind)).toBe(1); expect(await prisma.manualRecordCreateRequest.count()).toBe(1);
  });

  it("rejects another owner's replay and lets that owner use the same client key in their own business", async () => {
    const payload = body(kind); const first = await post(kind, payload);
    const other = await makeOwnerWithProfile({}, ["Inventory"]); state.authId = other.user.authId;
    const forbidden = await post(kind, payload);
    expect(forbidden.status).toBe(404); expect(forbidden.body).not.toHaveProperty("id");
    const own = await post(kind, { ...payload, businessProfileId: other.profile.id, ...(kind === "expense" ? { categoryId: other.categories.Inventory } : {}) });
    expect(own.status).toBe(201); expect(own.body.id).not.toBe(first.body.id);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(2);
  });

  it("scopes the same key separately to two businesses owned by one user", async () => {
    const payload = body(kind); const first = await post(kind, payload);
    const profile = await makeProfile(ctx.user.id); const category = await makeCategory(profile.id, "Inventory");
    const second = await post(kind, { ...payload, businessProfileId: profile.id, ...(kind === "expense" ? { categoryId: category.id } : {}) });
    expect(first.status).toBe(201); expect(second.status).toBe(201); expect(second.body.id).not.toBe(first.body.id);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(2);
  });

  it.each(["", "short", "contains spaces", "key/with/slash", "x".repeat(101), 12345678, null])("rejects invalid request key %j before writing", async (key) => {
    const response = await request(app).post(endpoint(kind)).set(...AUTH).send({ ...body(kind), idempotencyKey: key });
    expect(response.status).toBe(400); expect(await count(kind)).toBe(0); expect(await prisma.manualRecordCreateRequest.count()).toBe(0);
  });

  it("retains the legacy unkeyed create contract", async () => {
    const { idempotencyKey: _key, ...payload } = body(kind);
    const responses = await Promise.all([request(app).post(endpoint(kind)).set(...AUTH).send(payload), request(app).post(endpoint(kind)).set(...AUTH).send(payload)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await count(kind)).toBe(2); expect(await prisma.manualRecordCreateRequest.count()).toBe(0);
  });
});

describe("manual create identity boundaries", () => {
  it("keeps request metadata protected by deny-all RLS and zero anonymous/authenticated table privileges", async () => {
    const [table] = await prisma.$queryRaw<Array<{ enabled: boolean; policies: number }>>`
      SELECT c.relrowsecurity AS enabled, (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public."ManualRecordCreateRequest"'::regclass
    `;
    expect(table).toEqual({ enabled: true, policies: 0 });
    const privileges = await prisma.$queryRaw<Array<{ role: string; allowed: boolean }>>`
      SELECT r.rolname AS role, has_table_privilege(r.oid, 'public."ManualRecordCreateRequest"', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed
      FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') ORDER BY r.rolname
    `;
    expect(privileges).toEqual([{ role: "anon", allowed: false }, { role: "authenticated", allowed: false }]);
  });

  it("scopes an identical key separately to expense and sales", async () => {
    expect((await post("expense", body("expense"))).status).toBe(201);
    expect((await post("sales", body("sales"))).status).toBe(201);
    expect(await prisma.expenseRecord.count()).toBe(1); expect(await prisma.salesReferenceRecord.count()).toBe(1);
    expect(await prisma.manualRecordCreateRequest.count()).toBe(2);
  });

  it("replays an expense after its original category is removed following recategorization", async () => {
    const payload = body("expense"); const first = await post("expense", payload);
    const replacement = await makeCategory(ctx.profile.id, "Replacement");
    await prisma.expenseRecord.update({ where: { id: first.body.id }, data: { categoryId: replacement.id } });
    await prisma.expenseCategory.delete({ where: { id: ctx.categories.Inventory } });
    const replay = await post("expense", payload);
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(first.body.id); expect(replay.body.categoryId).toBe(replacement.id);
    expect(await prisma.expenseRecord.count()).toBe(1);
  });

  it.each(["categoryId", "vendor"])("rejects changed expense %s under the original key", async (field) => {
    const payload = body("expense"); expect((await post("expense", payload)).status).toBe(201);
    const category = await makeCategory(ctx.profile.id, "Other");
    const response = await post("expense", { ...payload, [field]: field === "vendor" ? "Different supplier" : category.id });
    expect(response.status).toBe(409); expect(response.body.code).toBe("MANUAL_CREATE_KEY_CONFLICT"); expect(await prisma.expenseRecord.count()).toBe(1);
  });

  it("cascades recovery metadata when the owning business is deleted", async () => {
    await post("expense", body("expense")); await post("sales", body("sales"));
    await prisma.businessProfile.delete({ where: { id: ctx.profile.id } });
    expect(await prisma.manualRecordCreateRequest.count()).toBe(0);
  });
});
