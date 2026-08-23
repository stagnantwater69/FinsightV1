import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The auth middleware is the thing under test as much as the handler is, so the
 * token is mocked rather than requireAuth: every case below goes through the
 * real middleware, the real ownership scoping and the real router. `authUserId`
 * is what "who is holding the token" means here — pointing it at the second
 * user is how the isolation cases switch identity.
 */
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

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { MAX_TOUR_STEP, TOUR_STATUSES } from "../../src/controllers/auth.controller";
import { disconnectDb, makeUser, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ME = "/api/v1/auth/me";
const PREFS = "/api/v1/auth/me/preferences";

/**
 * Every key GET /auth/me returned BEFORE preferences existed.
 *
 * Restated here on purpose, which is the one place in this suite a copy is the
 * right thing: this list is the shipped contract that web and mobile are built
 * against today, and its whole job is to fail if the server's idea of the
 * profile shape drifts away from it. Derived from the response it would agree
 * with whatever the server had become.
 */
const LEGACY_PROFILE_KEYS = [
  "id",
  "firstName",
  "middleName",
  "lastName",
  "email",
  "phoneNumber",
  "status",
  "avatarUrl",
  "createdAt",
] as const;

let owner: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDb();
  owner = await makeUser({ email: "owner@example.com" });
  other = await makeUser({ email: "other@example.com" });
  authUserId.value = owner.authId;
});

afterAll(disconnectDb);

/** The stored preferences, read straight from the row rather than the API. */
async function storedPreferences(userId: number) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      showDashboardMascotMessage: true,
      tourStatus: true,
      tourStep: true,
      tourAlwaysShow: true,
    },
  });
}

describe("preference defaults", () => {
  it("gives a brand-new account today's behaviour: mascot on, tour never told", async () => {
    // The point of the defaults. An existing owner must not notice the
    // migration: the mascot message they see now keeps showing, and nobody
    // finds the tour suddenly pinned open on every sign-in.
    const res = await request(app).get(ME).set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({
      showDashboardMascotMessage: true,
      // Null, not "not_started" — "the server has never been told about the
      // tour" is what lets a client migrate its locally stored progress up
      // exactly once instead of overwriting it with a server default.
      tourStatus: null,
      tourStep: null,
      tourAlwaysShow: false,
    });
  });

  it("defaults the row itself, not just the response", async () => {
    // makeUser writes through Prisma without mentioning any preference, which
    // is the same path registration takes — so this is the real default.
    expect(await storedPreferences(owner.id)).toEqual({
      showDashboardMascotMessage: true,
      tourStatus: null,
      tourStep: null,
      tourAlwaysShow: false,
    });
  });
});

describe("GET /auth/me stays backwards compatible", () => {
  it("still returns every field it returned before preferences existed", async () => {
    // THE GUARD FOR TWO SHIPPED CLIENTS. Mobile is built against the old shape
    // and keeps working only for as long as this passes; a rename here is not a
    // failing test somewhere else, it is a blank profile screen on a phone.
    const res = await request(app).get(ME).set(...AUTH);

    expect(res.status).toBe(200);
    for (const key of LEGACY_PROFILE_KEYS) {
      expect(res.body, `GET /auth/me dropped or renamed "${key}"`).toHaveProperty(key);
    }
    expect(res.body.email).toBe("owner@example.com");
    // Additive: the old keys plus exactly one new one.
    expect(Object.keys(res.body).sort()).toEqual([...LEGACY_PROFILE_KEYS, "preferences"].sort());
  });

  it("leaves PATCH /auth/me's own shape alone", async () => {
    // The identity endpoint was deliberately not widened — preferences have
    // their own route — so its response must be exactly what it always was.
    const res = await request(app).patch(ME).set(...AUTH).send({ firstName: "Renamed" });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...LEGACY_PROFILE_KEYS].sort());
    expect(res.body.firstName).toBe("Renamed");
  });

  it("does not let PATCH /auth/me smuggle a preference through", async () => {
    await request(app).patch(ME).set(...AUTH).send({ showDashboardMascotMessage: false });

    // updateProfileSchema ignores the unknown key rather than writing it, which
    // is the behaviour that must not change: one endpoint, one concern.
    expect((await storedPreferences(owner.id)).showDashboardMascotMessage).toBe(true);
  });
});

describe("PATCH /auth/me/preferences", () => {
  it("returns the full preferences object, not just what was sent", async () => {
    const res = await request(app).patch(PREFS).set(...AUTH).send({ showDashboardMascotMessage: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      showDashboardMascotMessage: false,
      tourStatus: null,
      tourStep: null,
      tourAlwaysShow: false,
    });
  });

  it("leaves the fields a partial update did not mention alone", async () => {
    // The case the whole design turns on: the settings toggle and the tour
    // overlay write independently and neither knows what the other stored. A
    // whole-object write from either would clobber the other's field.
    await request(app).patch(PREFS).set(...AUTH).send({ tourStatus: "in_progress", tourStep: 4 });
    await request(app).patch(PREFS).set(...AUTH).send({ showDashboardMascotMessage: false });

    expect(await storedPreferences(owner.id)).toEqual({
      showDashboardMascotMessage: false,
      tourStatus: "in_progress",
      tourStep: 4,
      tourAlwaysShow: false,
    });

    // ...and the same in the other direction: advancing the tour must not
    // un-dismiss the mascot message the owner just turned off.
    const res = await request(app).patch(PREFS).set(...AUTH).send({ tourStep: 5 });
    expect(res.body).toEqual({
      showDashboardMascotMessage: false,
      tourStatus: "in_progress",
      tourStep: 5,
      tourAlwaysShow: false,
    });
  });

  it("accepts every status the clients actually use", async () => {
    for (const status of TOUR_STATUSES) {
      const res = await request(app).patch(PREFS).set(...AUTH).send({ tourStatus: status });
      expect(res.status, `rejected "${status}", which a client does send`).toBe(200);
      expect(res.body.tourStatus).toBe(status);
    }
  });

  it("lets a client clear the tour back to never-told", async () => {
    await request(app).patch(PREFS).set(...AUTH).send({ tourStatus: "completed", tourStep: 9 });

    const res = await request(app).patch(PREFS).set(...AUTH).send({ tourStatus: null, tourStep: null });

    // Explicit null is a reset and is not the same as omitting the key — the
    // previous case proves omitting leaves the value in place.
    expect(res.status).toBe(200);
    expect(res.body.tourStatus).toBeNull();
    expect(res.body.tourStep).toBeNull();
  });

  it("survives the tour saving progress on every advance", async () => {
    // Eleven steps, eleven writes, back to back — the shape of a real tour run
    // and the reason no borrowed re-auth limiter belongs on this route.
    for (let step = 0; step <= 10; step += 1) {
      const res = await request(app).patch(PREFS).set(...AUTH).send({ tourStatus: "in_progress", tourStep: step });
      expect(res.status, `advance to step ${step} was refused`).toBe(200);
    }
    expect((await storedPreferences(owner.id)).tourStep).toBe(10);
  });
});

describe("preference validation", () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["a status no client uses", { tourStatus: "finished" }],
    ["a status with the wrong casing", { tourStatus: "In_Progress" }],
    ["an empty status", { tourStatus: "" }],
    ["a negative step", { tourStep: -1 }],
    ["a step past the ceiling", { tourStep: MAX_TOUR_STEP + 1 }],
    ["a fractional step", { tourStep: 2.5 }],
    ["a step sent as a string", { tourStep: "3" }],
    ["a boolean sent as a string", { showDashboardMascotMessage: "false" }],
    // Silently ignoring these is how a preference comes to look like it will
    // not save, with nothing anywhere saying why.
    ["an unknown key", { theme: "dark" }],
    ["a misspelled key", { tourAlwaysshow: true }],
    ["an empty body", {}],
  ];

  it.each(rejected)("rejects %s with a 400", async (_label, body) => {
    const res = await request(app).patch(PREFS).set(...AUTH).send(body);
    expect(res.status).toBe(400);
  });

  it("writes nothing at all when the body is rejected", async () => {
    await request(app).patch(PREFS).set(...AUTH).send({ showDashboardMascotMessage: false, tourStatus: "finished" });

    // The valid half of a rejected body must not land either — validation runs
    // before the update, so the row is untouched.
    expect(await storedPreferences(owner.id)).toEqual({
      showDashboardMascotMessage: true,
      tourStatus: null,
      tourStep: null,
      tourAlwaysShow: false,
    });
  });

  it("stores a status no wider than the column can hold", () => {
    // User_TourStatus is VARCHAR(20). A status longer than that would be a
    // 500 from Postgres rather than a validation error, so the union and the
    // column width have to be checked against each other somewhere.
    for (const status of TOUR_STATUSES) {
      expect(status.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("ownership isolation", () => {
  it("refuses an unauthenticated write", async () => {
    const res = await request(app).patch(PREFS).send({ showDashboardMascotMessage: false });
    expect(res.status).toBe(401);
  });

  it("changes only the token holder's row", async () => {
    // There is no id parameter on this surface, so the check is not "was the
    // wrong id refused" but "could the write reach any row but mine at all".
    await request(app).patch(PREFS).set(...AUTH).send({
      showDashboardMascotMessage: false,
      tourStatus: "completed",
      tourStep: 10,
      tourAlwaysShow: true,
    });

    expect(await storedPreferences(other.id)).toEqual({
      showDashboardMascotMessage: true,
      tourStatus: null,
      tourStep: null,
      tourAlwaysShow: false,
    });
  });

  it("ignores an id in the body that names someone else", async () => {
    const res = await request(app).patch(PREFS).set(...AUTH).send({
      id: other.id,
      userId: other.id,
      showDashboardMascotMessage: false,
    });

    // `.strict()` refuses the smuggled ids outright rather than quietly
    // dropping them, so neither row moves.
    expect(res.status).toBe(400);
    expect((await storedPreferences(other.id)).showDashboardMascotMessage).toBe(true);
    expect((await storedPreferences(owner.id)).showDashboardMascotMessage).toBe(true);
  });

  it("shows each owner only their own preferences", async () => {
    await request(app).patch(PREFS).set(...AUTH).send({ tourStatus: "skipped", tourStep: 2 });

    authUserId.value = other.authId;
    const res = await request(app).get(ME).set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("other@example.com");
    expect(res.body.preferences).toEqual({
      showDashboardMascotMessage: true,
      tourStatus: null,
      tourStep: null,
      tourAlwaysShow: false,
    });
  });
});
