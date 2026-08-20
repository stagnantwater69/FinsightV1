import { Prisma, RecurringPatternStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async (token: string) => token === "valid-token"
    ? { data: { user: { id: authUserId.value } }, error: null }
    : { data: { user: null }, error: new Error("bad token") } } } };
});

/*
 * The recurring feature flag, as the running server sees it.
 *
 * RUNTIME_DETECTION_CONFIG is a frozen constant built from env at module load,
 * so it cannot be toggled between tests and .env.test leaves
 * ANOMALY_RECURRING_ENABLED unset (i.e. false, as production ships it). Rather
 * than export a mutable global from production code just to be testable, the
 * flag is re-read here through a getter on the mocked module — the guard reads
 * the config at call time, so each request sees whatever `recurringFlag` says.
 * Production keeps exactly one source of truth and no injection seam.
 */
const { recurringFlag } = vi.hoisted(() => ({ recurringFlag: { enabled: true } }));
vi.mock("../../src/services/anomalyDetection/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/anomalyDetection/config")>();
  return {
    ...actual,
    get RUNTIME_DETECTION_CONFIG() {
      return actual.detectionConfig({ featureFlags: { recurring: recurringFlag.enabled } });
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
  recurringFlag.enabled = true;
});
afterAll(disconnectDb);

const BASE = "/api/v1/insights";

function declaration(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories.Utilities!,
    label: "Monthly electricity",
    vendor: "Power Co.",
    intervalDays: 30,
    expectedAmount: 9500,
    nextDueDate: utcDayString(10),
    ...overrides,
  };
}

/**
 * A detector candidate, written straight to Prisma so a test can set states the
 * detector would not normally produce (a zero amount, a tolerance above 1).
 * The three DB-level CHECKs still apply: observationCount >= 3, intervalDays > 0,
 * confidence in 0..1.
 */
async function makePattern(overrides: Partial<Prisma.RecurringPatternUncheckedCreateInput> = {}) {
  return prisma.recurringPattern.create({
    data: {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Utilities!,
      normalizedKey: `key-${Math.random().toString(36).slice(2)}`,
      vendor: "Power Co.",
      description: "Monthly electricity",
      intervalDays: 30,
      expectedAmount: new Prisma.Decimal(9500),
      amountTolerance: new Prisma.Decimal(0.15),
      confidence: new Prisma.Decimal(0.9),
      observationCount: 3,
      lastOccurrence: new Date("2026-01-31T00:00:00Z"),
      nextExpectedDate: new Date("2026-03-02T00:00:00Z"),
      ...overrides,
    },
  });
}

describe("recurring schedule HTTP API", () => {
  it("creates, lists, edits and deletes an owner-declared schedule", async () => {
    const created = await request(app).post(`${BASE}/recurring-schedules`).set(...AUTH).send(declaration());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ label: "Monthly electricity", intervalDays: 30, isActive: true });
    // Decimal columns must arrive as numbers, not as `{ s, e, d }` objects.
    expect(created.body.expectedAmount).toBe(9500);
    expect(created.body.amountTolerance).toBe(0.15);
    expect(created.body.dueState).toBe("SCHEDULED");
    expect(created.body.categoryName).toBe("Utilities");

    const list = await request(app).get(`${BASE}/recurring-schedules`)
      .set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(created.body.id);

    const patched = await request(app).patch(`${BASE}/recurring-schedules/${created.body.id}`)
      .set(...AUTH).send({ label: "Electricity bill", expectedAmount: 10250.5, isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ label: "Electricity bill", expectedAmount: 10250.5, isActive: false });

    const removed = await request(app).delete(`${BASE}/recurring-schedules/${created.body.id}`).set(...AUTH);
    expect(removed.status).toBe(204);
    expect(await prisma.recurringSchedule.count()).toBe(0);
  });

  it("computes dueState server-side, using the detector's 3-day lead", async () => {
    for (const [offset, expected] of [[-1, "OVERDUE"], [0, "DUE_SOON"], [3, "DUE_SOON"], [4, "SCHEDULED"]] as const) {
      const created = await request(app).post(`${BASE}/recurring-schedules`)
        .set(...AUTH).send(declaration({ nextDueDate: utcDayString(offset) }));
      expect(created.status).toBe(201);
      expect([offset, created.body.dueState]).toEqual([offset, expected]);
    }
  });

  it("rejects a category from another business profile with 400, not 404", async () => {
    const other = await makeOwnerWithProfile({ name: "Other" });
    const response = await request(app).post(`${BASE}/recurring-schedules`)
      .set(...AUTH).send(declaration({ categoryId: other.categories.Utilities! }));
    expect(response.status).toBe(400);

    // Same rule on the edit path, which is the one an owner can reach after the
    // schedule already exists: a foreign categoryId must be refused outright,
    // not written through onto a row this owner does own. 400 rather than 404
    // because the schedule itself is theirs — only the category is not.
    const created = await request(app).post(`${BASE}/recurring-schedules`).set(...AUTH).send(declaration());
    expect(created.status).toBe(201);
    const patched = await request(app).patch(`${BASE}/recurring-schedules/${created.body.id}`)
      .set(...AUTH).send({ categoryId: other.categories.Utilities!, label: "Retargeted" });
    expect(patched.status).toBe(400);

    // Nothing from the rejected patch may have landed: neither the foreign
    // category nor the label that rode along with it.
    const stored = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.categoryId).toBe(ctx.categories.Utilities!);
    expect(stored.label).toBe("Monthly electricity");
  });
});

describe("confirming a detector candidate", () => {
  it("creates a linked schedule and flips the pattern to CONFIRMED in one step", async () => {
    const pattern = await makePattern();

    const response = await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`).set(...AUTH).send({});
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      // Seeded from the pattern's description so the watchdog's
      // categoryId + vendor + label match works by construction.
      label: "Monthly electricity",
      vendor: "Power Co.",
      intervalDays: 30,
      expectedAmount: 9500,
      sourcePatternId: pattern.id,
      isActive: true,
    });
    expect(response.body.nextDueDate.slice(0, 10)).toBe("2026-03-02");

    const reloaded = await prisma.recurringPattern.findUniqueOrThrow({ where: { id: pattern.id } });
    expect(reloaded.status).toBe(RecurringPatternStatus.CONFIRMED);
  });

  it("clamps a tolerance the pattern table has no CHECK against", async () => {
    // inferRecurringPattern computes max(0.15, median(deviations) * 2), which is
    // unbounded above; RecurringSchedule's CHECK caps it at 1.
    const pattern = await makePattern({ amountTolerance: new Prisma.Decimal(2.5) });
    const response = await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`).set(...AUTH).send({});
    expect(response.status).toBe(201);
    expect(response.body.amountTolerance).toBe(1);
  });

  it("refuses a non-positive expected amount with 400 rather than a constraint 500", async () => {
    const pattern = await makePattern({ expectedAmount: new Prisma.Decimal(0) });
    const response = await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`).set(...AUTH).send({});
    expect(response.status).toBe(400);
    expect(await prisma.recurringSchedule.count()).toBe(0);
    // The pattern must not have been flipped either — both writes are one unit.
    const reloaded = await prisma.recurringPattern.findUniqueOrThrow({ where: { id: pattern.id } });
    expect(reloaded.status).toBe(RecurringPatternStatus.CANDIDATE);
  });

  it("refuses to spawn a second schedule from the same pattern", async () => {
    const pattern = await makePattern();
    await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`).set(...AUTH).send({});
    const second = await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`).set(...AUTH).send({});
    expect(second.status).toBe(409);
    expect(await prisma.recurringSchedule.count()).toBe(1);
  });

  it("rejects DISABLED on the review endpoint and coerces the Decimals it returns", async () => {
    const pattern = await makePattern();
    const disabled = await request(app).patch(`${BASE}/recurring-patterns/${pattern.id}`)
      .set(...AUTH).send({ status: "DISABLED" });
    expect(disabled.status).toBe(400);

    const dismissed = await request(app).patch(`${BASE}/recurring-patterns/${pattern.id}`)
      .set(...AUTH).send({ status: RecurringPatternStatus.DISMISSED });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.expectedAmount).toBe(9500);
    expect(dismissed.body.amountTolerance).toBe(0.15);
    expect(dismissed.body.confidence).toBe(0.9);
  });
});

/*
 * 404 on every one of these, never 403: a 403 would confirm the row exists,
 * which lets another owner's schedule ids be probed one by one.
 */
describe("ownership isolation", () => {
  it("hides schedules and patterns belonging to another owner", async () => {
    const other = await makeOwnerWithProfile({ name: "Other" });
    const foreignSchedule = await prisma.recurringSchedule.create({
      data: {
        businessProfileId: other.profile.id,
        categoryId: other.categories.Utilities!,
        label: "Their rent",
        intervalDays: 30,
        expectedAmount: new Prisma.Decimal(15000),
        nextDueDate: new Date("2026-03-02T00:00:00Z"),
      },
    });
    const foreignPattern = await prisma.recurringPattern.create({
      data: {
        businessProfileId: other.profile.id,
        categoryId: other.categories.Utilities!,
        normalizedKey: "their-key",
        description: "Their electricity",
        intervalDays: 30,
        expectedAmount: new Prisma.Decimal(9500),
        amountTolerance: new Prisma.Decimal(0.15),
        confidence: new Prisma.Decimal(0.9),
        observationCount: 3,
        lastOccurrence: new Date("2026-01-31T00:00:00Z"),
        nextExpectedDate: new Date("2026-03-02T00:00:00Z"),
      },
    });

    const list = await request(app).get(`${BASE}/recurring-schedules`)
      .set(...AUTH).query({ businessProfileId: other.profile.id });
    expect(list.status).toBe(404);

    const created = await request(app).post(`${BASE}/recurring-schedules`)
      .set(...AUTH).send(declaration({ businessProfileId: other.profile.id, categoryId: other.categories.Utilities! }));
    expect(created.status).toBe(404);

    const patched = await request(app).patch(`${BASE}/recurring-schedules/${foreignSchedule.id}`)
      .set(...AUTH).send({ expectedAmount: 1 });
    expect(patched.status).toBe(404);

    const removed = await request(app).delete(`${BASE}/recurring-schedules/${foreignSchedule.id}`).set(...AUTH);
    expect(removed.status).toBe(404);

    const confirmed = await request(app).post(`${BASE}/recurring-patterns/${foreignPattern.id}/confirm`)
      .set(...AUTH).send({});
    expect(confirmed.status).toBe(404);

    // Nothing was read, written or deleted through any of those.
    expect(await prisma.recurringSchedule.count()).toBe(1);
    expect(Number((await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: foreignSchedule.id } })).expectedAmount)).toBe(15000);
    expect((await prisma.recurringPattern.findUniqueOrThrow({ where: { id: foreignPattern.id } })).status)
      .toBe(RecurringPatternStatus.CANDIDATE);
  });

  it("requires authentication on every recurring-schedule route", async () => {
    // Auth is checked before the feature gate in both flag states: an
    // unauthenticated caller must never learn which features are switched on.
    recurringFlag.enabled = false;
    expect((await request(app).get(`${BASE}/recurring-schedules`).query({ businessProfileId: ctx.profile.id })).status).toBe(401);
    recurringFlag.enabled = true;
    expect((await request(app).get(`${BASE}/recurring-schedules`).query({ businessProfileId: ctx.profile.id })).status).toBe(401);
    expect((await request(app).post(`${BASE}/recurring-schedules`).send(declaration())).status).toBe(401);
    expect((await request(app).patch(`${BASE}/recurring-schedules/1`).send({ isActive: false })).status).toBe(401);
    expect((await request(app).delete(`${BASE}/recurring-schedules/1`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/recurring-patterns/1/confirm`).send({})).status).toBe(401);
  });
});

/*
 * ANOMALY_RECURRING_ENABLED must decide the WHOLE feature, not half of it.
 *
 * refreshRecurringPatterns returns early on this flag, and it is the only thing
 * that ever advances a schedule's nextDueDate. Leaving the CRUD live while the
 * detector is dark gives an owner a working UI whose due dates never move: every
 * schedule they declare goes permanently OVERDUE however faithfully they pay,
 * and the agenda becomes a wall of red for a shop doing everything right. So all
 * five endpoints refuse together.
 *
 * They refuse with 404 rather than 503 or a named feature-flag error, for the
 * reason lib/ownership.ts answers 404 instead of 403: a thing you may not have
 * must be indistinguishable from a thing that is not there. GET refuses too,
 * instead of returning [] — an empty agenda would read as "you have no
 * schedules", which is a different lie.
 */
describe("feature flag gating", () => {
  async function seedOwnSchedule() {
    return prisma.recurringSchedule.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Utilities!,
        label: "Monthly electricity",
        intervalDays: 30,
        expectedAmount: new Prisma.Decimal(9500),
        nextDueDate: new Date("2026-03-02T00:00:00Z"),
      },
    });
  }

  it("refuses all five endpoints with 404 while the flag is off, and writes nothing", async () => {
    // Seeded through Prisma, so every 404 below is the gate refusing — not the
    // absence of data. A row the owner really does own is right there.
    const schedule = await seedOwnSchedule();
    const pattern = await makePattern();
    recurringFlag.enabled = false;

    const list = await request(app).get(`${BASE}/recurring-schedules`)
      .set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(list.status).toBe(404);
    expect(list.body).not.toHaveProperty("length");

    const created = await request(app).post(`${BASE}/recurring-schedules`).set(...AUTH).send(declaration());
    expect(created.status).toBe(404);

    const patched = await request(app).patch(`${BASE}/recurring-schedules/${schedule.id}`)
      .set(...AUTH).send({ label: "Renamed", expectedAmount: 1 });
    expect(patched.status).toBe(404);

    const removed = await request(app).delete(`${BASE}/recurring-schedules/${schedule.id}`).set(...AUTH);
    expect(removed.status).toBe(404);

    const confirmed = await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`).set(...AUTH).send({});
    expect(confirmed.status).toBe(404);

    // No create, no edit, no delete, no promotion got through.
    const rows = await prisma.recurringSchedule.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: schedule.id, label: "Monthly electricity" });
    expect(Number(rows[0]!.expectedAmount)).toBe(9500);
    expect((await prisma.recurringPattern.findUniqueOrThrow({ where: { id: pattern.id } })).status)
      .toBe(RecurringPatternStatus.CANDIDATE);
  });

  it("does not advertise the feature in the refusal", async () => {
    recurringFlag.enabled = false;
    const list = await request(app).get(`${BASE}/recurring-schedules`)
      .set(...AUTH).query({ businessProfileId: ctx.profile.id });
    // Nothing that names the flag, the feature or its disabled state: a probe
    // must not be able to tell a dark endpoint from one that was never shipped.
    expect(list.body).toEqual({ error: "Not found" });
    expect(JSON.stringify(list.body)).not.toMatch(/recurring|flag|disabled|enabled|unavailable/i);
  });

  it("refuses before validating the body, so a bad request cannot smoke out the route", async () => {
    recurringFlag.enabled = false;
    // With the gate only in the service, this would parse first and answer
    // `400 Validation failed` — which tells the prober the endpoint is there.
    const bad = await request(app).post(`${BASE}/recurring-schedules`).set(...AUTH).send({ nonsense: true });
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ error: "Not found" });
  });

  it("serves all five endpoints once the flag is on", async () => {
    const pattern = await makePattern();
    recurringFlag.enabled = true;

    const created = await request(app).post(`${BASE}/recurring-schedules`).set(...AUTH).send(declaration());
    expect(created.status).toBe(201);
    expect((await request(app).get(`${BASE}/recurring-schedules`)
      .set(...AUTH).query({ businessProfileId: ctx.profile.id })).status).toBe(200);
    expect((await request(app).patch(`${BASE}/recurring-schedules/${created.body.id}`)
      .set(...AUTH).send({ label: "Renamed" })).status).toBe(200);
    expect((await request(app).post(`${BASE}/recurring-patterns/${pattern.id}/confirm`)
      .set(...AUTH).send({})).status).toBe(201);
    expect((await request(app).delete(`${BASE}/recurring-schedules/${created.body.id}`).set(...AUTH)).status).toBe(204);
  });
});
