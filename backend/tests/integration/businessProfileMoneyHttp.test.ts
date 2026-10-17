import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const authUserId = vi.hoisted(() => ({ value: "" }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async () => ({ data: { user: { id: authUserId.value } }, error: null }) } } };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer synthetic-token"] as const;
const BASE = "/api/v1/business-profiles";
const body = { name: "Money boundary store", type: "Store", operatingDays: 20, availableFunds: 0, expectedMonthlyExpenses: 0 };
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

describe("business profile money over HTTP", () => {
  it.each(["availableFunds", "expectedMonthlyExpenses"] as const)("rejects rounding and overflow for %s on create and update", async (field) => {
    const initial = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    const count = await prisma.businessProfile.count();
    for (const value of [0.001, 10_000_000_000]) {
      const created = await request(app).post(BASE).set(...AUTH).send({ ...body, [field]: value });
      expect(created.status).toBe(400);
      expect(created.body.details.fieldErrors[field]).toBeTruthy();
      expect(await prisma.businessProfile.count()).toBe(count);
      const updated = await request(app).patch(`${BASE}/${ctx.profile.id}`).set(...AUTH).send({ [field]: value });
      expect(updated.status).toBe(400);
      expect(updated.body.details.fieldErrors[field]).toBeTruthy();
      const stored = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
      expect(stored[field].toString()).toBe(initial[field].toString());
    }
  });

  it.each([0, 0.01, 9_999_999_999.99])("persists the exact accepted amount %s on create and update", async (amount) => {
    const created = await request(app).post(BASE).set(...AUTH).send({ ...body, availableFunds: amount, expectedMonthlyExpenses: amount });
    expect(created.status).toBe(201);
    const newProfile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(newProfile.availableFunds.toString()).toBe(String(amount));
    expect(newProfile.expectedMonthlyExpenses.toString()).toBe(String(amount));
    const updated = await request(app).patch(`${BASE}/${ctx.profile.id}`).set(...AUTH)
      .send({ availableFunds: amount, expectedMonthlyExpenses: amount });
    expect(updated.status).toBe(200);
    const stored = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    expect(stored.availableFunds.toString()).toBe(String(amount));
    expect(stored.expectedMonthlyExpenses.toString()).toBe(String(amount));
  });

  it("rejects threshold rounding and preserves the existing stored percentage", async () => {
    const initial = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    const updated = await request(app).patch(`${BASE}/${ctx.profile.id}`).set(...AUTH).send({ largeExpenseThresholdPercent: 25.001 });
    expect(updated.status).toBe(400);
    expect(updated.body.details.fieldErrors.largeExpenseThresholdPercent).toBeTruthy();
    expect((await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } })).largeExpenseThresholdPercent.toString())
      .toBe(initial.largeExpenseThresholdPercent.toString());
  });
});
