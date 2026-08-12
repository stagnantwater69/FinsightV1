import { randomUUID } from "node:crypto";
import { AccountDeletionStage, AccountStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The account state machine, end to end against the real database.
 *
 * WHAT THIS SUITE IS FOR. Registration, verification, suspension and deletion
 * used to be four independent code paths with no shared notion of what state an
 * account was in — which is how a suspended account kept answering API calls,
 * how a failed registration could leave a row that blocked every retry, and how
 * a deletion could destroy a customer's receipt images and then leave the
 * account working. The tests below are written against the TRANSITIONS rather
 * than the endpoints, because the transitions are the thing that has to stay
 * consistent when the endpoints change.
 *
 * Supabase is faked rather than reached. Every call this system makes to it is
 * recorded on `supabaseCalls` so the tests can assert on the things that have
 * no database trace — that suspension actually banned the identity, that
 * changing a password revoked OTHER sessions and not this one, that a rolled
 * back registration deleted the auth user it had just created.
 */
const { authUserId, supabaseCalls, supabaseFailures, signInConfirmed } = vi.hoisted(() => ({
  authUserId: { value: "" },
  supabaseCalls: [] as { method: string; args: unknown[] }[],
  /** Set a method name here to make the next call to it fail, for the crash tests. */
  supabaseFailures: new Set<string>(),
  /**
   * Whether signInWithPassword reports the address as confirmed.
   *
   * Default false, which is what every pre-existing test assumes: it keeps the
   * status gate refusing a PENDING_VERIFICATION account. The reconciliation
   * test below turns it on to reproduce the split state — confirmed in GoTrue,
   * stale here — that a lost confirmation redirect leaves behind.
   */
  signInConfirmed: { value: false },
}));

function record(method: string, ...args: unknown[]) {
  supabaseCalls.push({ method, args });
  if (supabaseFailures.has(method)) {
    return { data: { user: null }, error: { message: `${method} failed`, status: 500 } };
  }
  return null;
}

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  const admin = {
    async getUser(token: string) {
      supabaseCalls.push({ method: "getUser", args: [token] });
      return token === "valid-token"
        ? { data: { user: { id: authUserId.value, email_confirmed_at: new Date().toISOString() } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } };
    },
    async updateUserById(id: string, attrs: unknown) {
      return record("updateUserById", id, attrs) ?? { data: { user: { id } }, error: null };
    },
    async deleteUser(id: string, soft?: boolean) {
      return record("deleteUser", id, soft) ?? { data: {}, error: null };
    },
    async signOut(token: string, scope: string) {
      return record("signOut", token, scope) ?? { data: {}, error: null };
    },
  };
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: admin.getUser,
        admin,
        async resetPasswordForEmail(email: string, opts: unknown) {
          return record("resetPasswordForEmail", email, opts) ?? { data: {}, error: null };
        },
      },
    },
    createPasswordAuthClient: () => ({
      auth: {
        async signInWithPassword({ password }: { email: string; password: string }) {
          supabaseCalls.push({ method: "signInWithPassword", args: [password] });
          return password === "correct-horse-battery"
            ? {
                data: {
                  user: {
                    id: authUserId.value,
                    email_confirmed_at: signInConfirmed.value ? new Date().toISOString() : null,
                  },
                  session: { access_token: "valid-token" },
                },
                error: null,
              }
            : { data: { user: null, session: null }, error: { message: "Invalid login credentials" } };
        },
        async signOut(opts: unknown) {
          return record("throwawaySignOut", opts) ?? { error: null };
        },
      },
    }),
    createAnonAuthClient: () => ({
      auth: {
        async signUp({ email }: { email: string }) {
          supabaseCalls.push({ method: "signUp", args: [email] });
          if (supabaseFailures.has("signUp")) {
            return { data: { user: null }, error: { message: "signup failed", code: "unexpected_failure" } };
          }
          if (email === "taken@shop.ph") {
            // How GoTrue says "already registered" without saying it.
            return { data: { user: { id: "existing-auth-id", identities: [] } }, error: null };
          }
          // A real UUID: `User_AuthID` is `@db.Uuid`, so a readable fake id
          // would fail at the database rather than in the code under test.
          return {
            data: { user: { id: randomUUID(), identities: [{ id: "i" }], email_confirmed_at: null } },
            error: null,
          };
        },
        async resend(opts: unknown) {
          return record("resend", opts) ?? { data: {}, error: null };
        },
      },
    }),
  };
});

// Storage is faked so a deletion can be made to fail on demand. `deleted`
// records what the worker asked to remove, which is how the "rows outlive the
// objects" ordering is checked.
const { storageDeleted, storageFails } = vi.hoisted(() => ({
  storageDeleted: [] as string[],
  storageFails: { value: false },
}));
/*
 * The security log is captured rather than silenced. Several controls in this
 * suite have no database trace at all — a disposable-domain signup registers
 * exactly like any other — so the event IS the observable behaviour, and a test
 * that did not look at it could not tell the control from its absence.
 */
const { loggedEvents } = vi.hoisted(() => ({ loggedEvents: [] as string[] }));
vi.mock("../../src/lib/securityLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/securityLog")>();
  return {
    ...actual,
    securityEvent: (event: string, detail?: unknown) => {
      loggedEvents.push(event);
      return actual.securityEvent(event as never, detail as never);
    },
  };
});

vi.mock("../../src/services/storage.service", () => ({
  deleteReceiptImage: async (p: string) => (storageDeleted.push(p), !storageFails.value),
  deleteCsvFile: async (p: string) => (storageDeleted.push(p), !storageFails.value),
  deletePublicImageUrl: async (p: string) => (storageDeleted.push(p), !storageFails.value),
  uploadUserAvatar: async () => "https://example.test/avatar.png",
}));

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { transition } from "../../src/services/accountLifecycle.service";
import {
  purgeUnverifiedRegistrations,
  runAccountDeletionWorkerOnce,
} from "../../src/services/accountDeletion.service";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const PASSWORD = "correct-horse-battery";

/** Registrations that would satisfy every rule, so a test can vary one thing. */
function registration(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ken",
    lastName: "Reyes",
    email: "new-owner@shop.ph",
    password: "a-long-enough-passphrase",
    ...overrides,
  };
}

const callsTo = (method: string) => supabaseCalls.filter((c) => c.method === method);

beforeEach(async () => {
  await resetDb();
  /*
   * The auth limiters are per-IP and supertest is always the same IP, so
   * without this the fifth registration in the FILE is rate-limited rather than
   * the fifth from one visitor — every later test would then assert against a
   * 429. Resetting per test is what makes each one independent; the limits
   * themselves are exercised in tests/unit/rateLimit.test.ts.
   */
  resetRateLimits();
  supabaseCalls.length = 0;
  supabaseFailures.clear();
  storageDeleted.length = 0;
  storageFails.value = false;
  loggedEvents.length = 0;
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

describe("registration proves the address before the account works", () => {
  it("creates a PENDING_VERIFICATION account and issues no session", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(registration());

    // 202, not 201: nothing usable exists yet.
    expect(res.status).toBe(202);
    expect(res.body.session).toBeUndefined();
    expect(res.body.profile).toBeUndefined();

    const created = await prisma.user.findUnique({ where: { email: "new-owner@shop.ph" } });
    expect(created?.status).toBe(AccountStatus.PENDING_VERIFICATION);
  });

  /**
   * The enumeration property. A registration for an address that already exists
   * must be indistinguishable from one for a fresh address — otherwise this
   * endpoint answers "does this person have an account here?" for anyone who
   * asks, which for a financial product is a disclosure in itself.
   */
  it("answers identically for a taken address, and creates nothing", async () => {
    const fresh = await request(app).post("/api/v1/auth/register").send(registration());
    const taken = await request(app).post("/api/v1/auth/register").send(registration({ email: "taken@shop.ph" }));

    expect(taken.status).toBe(fresh.status);
    expect(taken.body).toEqual(fresh.body);
    expect(await prisma.user.findUnique({ where: { email: "taken@shop.ph" } })).toBeNull();
  });

  it("refuses a password under the minimum", async () => {
    const short = await request(app).post("/api/v1/auth/register").send(registration({ password: "short" }));
    expect(short.status).toBe(400);
  });

  /**
   * A throwaway inbox REGISTERS NORMALLY and is merely recorded.
   *
   * Blocking it was tried and removed: a hand-kept list misses anyone actually
   * farming accounts and silently turns away the occasional real owner on a
   * small provider. Confirmation is the control that carries the weight — the
   * address still has to receive a link before the account works. The event is
   * a tripwire for the case where this stops being theoretical, so it is
   * asserted here rather than left to be discovered missing during an incident.
   */
  it("accepts a disposable address but records that it was one", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registration({ email: "someone@mailinator.com" }));

    expect(res.status).toBe(202);
    const created = await prisma.user.findUnique({ where: { email: "someone@mailinator.com" } });
    // Created, but not yet usable — exactly like any other registration.
    expect(created?.status).toBe(AccountStatus.PENDING_VERIFICATION);
    expect(loggedEvents).toContain("register.disposable_domain");

    loggedEvents.length = 0;
    await request(app).post("/api/v1/auth/register").send(registration({ email: "owner@realshop.ph" }));
    expect(loggedEvents).not.toContain("register.disposable_domain");
  });

  it("stores the address lowercased, whatever case it arrived in", async () => {
    await request(app).post("/api/v1/auth/register").send(registration({ email: "Mixed.Case@Shop.PH" }));
    expect(await prisma.user.findUnique({ where: { email: "mixed.case@shop.ph" } })).not.toBeNull();
  });

  /**
   * THE ORPHAN THAT BLOCKED EVERY RETRY. The old code deleted the Supabase user
   * on failure and left the Prisma row, whose unique email then rejected the
   * next attempt — an account that could neither be used nor recreated without
   * a database console. Compensation has to clear BOTH systems.
   */
  it("leaves nothing behind in either system when the profile insert fails", async () => {
    const create = vi.spyOn(prisma.user, "create").mockRejectedValueOnce(new Error("database went away"));

    const failed = await request(app).post("/api/v1/auth/register").send(registration());
    expect(failed.status).toBe(500);
    create.mockRestore();

    // The auth user it had just created is gone...
    expect(callsTo("deleteUser").length).toBe(1);
    // ...and no row survives to block the retry.
    expect(await prisma.user.findUnique({ where: { email: "new-owner@shop.ph" } })).toBeNull();

    const retry = await request(app).post("/api/v1/auth/register").send(registration());
    expect(retry.status).toBe(202);
  });

  it("releases the address when a registration is never confirmed", async () => {
    await request(app).post("/api/v1/auth/register").send(registration());
    const pending = await prisma.user.findUniqueOrThrow({ where: { email: "new-owner@shop.ph" } });

    // Still inside its window: an abandoned sign-up from this morning must not
    // be swept away while its owner is still looking for the email.
    expect(await purgeUnverifiedRegistrations()).toBe(0);

    await prisma.user.update({
      where: { id: pending.id },
      data: { createdAt: new Date(Date.now() - 73 * 60 * 60 * 1000) },
    });
    expect(await purgeUnverifiedRegistrations()).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: pending.id } })).toBeNull();
  });
});

describe("only an ACTIVE account may be used", () => {
  /*
   * `User_Status` existed before this and was decorative: the column was
   * written nowhere and read only by the profile response, so nothing enforced
   * it. A suspended account kept working for as long as its access token lived.
   */
  for (const status of [AccountStatus.SUSPENDED, AccountStatus.DELETION_PENDING] as const) {
    it(`refuses an API call from a ${status} account`, async () => {
      await transition(ctx.user, status, { reason: "test" });

      const res = await request(app).get("/api/v1/auth/me").set(...AUTH);

      // 403, not 401. 401 tells both clients "your session ended, sign in
      // again" — which is a lie here, and for a suspended account produces a
      // loop between the login screen and a refusal.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ACCOUNT_NOT_ACTIVE");
    });
  }

  it("refuses a login even with the correct password", async () => {
    await transition(ctx.user, AccountStatus.SUSPENDED, { reason: "test" });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ctx.user.email, password: PASSWORD });

    expect(res.status).toBe(403);
  });

  /**
   * Suspension has to reach Supabase, not just the database. A status the API
   * checks but the identity provider does not know about still leaves a valid
   * refresh token in someone's hands.
   */
  it("revokes the Supabase identity as it suspends", async () => {
    await transition(ctx.user, AccountStatus.SUSPENDED, { reason: "test" });
    const ban = callsTo("updateUserById").at(-1);
    expect((ban?.args[1] as { ban_duration?: string }).ban_duration).toBeTruthy();
  });

  it("lifts the ban when the account is reinstated", async () => {
    const suspended = await transition(ctx.user, AccountStatus.SUSPENDED, { reason: "test" });
    await transition(suspended, AccountStatus.ACTIVE, { reason: "appeal upheld" });
    expect((callsTo("updateUserById").at(-1)?.args[1] as { ban_duration?: string }).ban_duration).toBe("none");
  });

  it("refuses a transition the state machine does not allow", async () => {
    // PENDING_VERIFICATION goes to ACTIVE or nowhere: an account that has never
    // proved its address cannot be "suspended" into looking like a real one.
    const pending = await transition(ctx.user, AccountStatus.SUSPENDED, { reason: "test" });
    await prisma.user.update({ where: { id: pending.id }, data: { status: AccountStatus.PENDING_VERIFICATION } });
    await expect(
      transition({ ...pending, status: AccountStatus.PENDING_VERIFICATION }, AccountStatus.SUSPENDED, {
        reason: "test",
      }),
    ).rejects.toThrow(/cannot go from/);
  });
});

describe("changing a password keeps this session and ends the others", () => {
  it("revokes only the other sessions", async () => {
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set(...AUTH)
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });

    expect(res.status).toBe(200);
    expect(callsTo("signOut").map((c) => c.args[1])).toEqual(["others"]);
  });

  it("refuses on a wrong current password, so a stolen token cannot take the account", async () => {
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set(...AUTH)
      .send({ currentPassword: "not-the-password", newPassword: "a-brand-new-passphrase" });

    expect(res.status).toBe(400);
    expect(callsTo("signOut")).toHaveLength(0);
  });

  /**
   * Every re-authentication signs in on a throwaway client, and every one of
   * those mints a real session with a refresh token. Left unclosed, one
   * accumulates per password change — sessions the owner never created, cannot
   * see and cannot end.
   */
  it("closes the throwaway session it used to verify the password", async () => {
    await request(app)
      .post("/api/v1/auth/change-password")
      .set(...AUTH)
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });

    expect(callsTo("throwawaySignOut").length).toBeGreaterThan(0);
  });

  it("signs out this device only on an ordinary logout", async () => {
    await request(app).post("/api/v1/auth/logout").set(...AUTH);
    expect(callsTo("signOut").map((c) => c.args[1])).toEqual(["local"]);
  });

  it("signs out everywhere only when that is what was asked for", async () => {
    await request(app).post("/api/v1/auth/logout-all").set(...AUTH);
    expect(callsTo("signOut").map((c) => c.args[1])).toEqual(["global"]);
  });
});

describe("deletion ends access immediately and destroys data in the background", () => {
  /*
   * The account is given something IN STORAGE before every deletion test.
   *
   * Without it `clearStorage` has nothing to delete, always succeeds, and the
   * resumability tests below pass for the wrong reason — they would be
   * asserting that a no-op does not fail. An avatar is the smallest thing that
   * makes the stage real.
   */
  beforeEach(async () => {
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { avatarUrl: "https://example.test/storage/avatars/1.png" },
    });
  });

  async function requestDeletion() {
    return request(app)
      .delete("/api/v1/auth/me")
      .set(...AUTH)
      .send({ currentPassword: PASSWORD });
  }

  it("accepts, revokes access, and destroys nothing synchronously", async () => {
    const res = await requestDeletion();

    // 202: accepted. A 204 would claim the erasure had finished, which was
    // never true even when it ran inline — there was just nowhere to say so.
    expect(res.status).toBe(202);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    expect(user.status).toBe(AccountStatus.DELETION_PENDING);
    expect(user.deletionStage).toBe(AccountDeletionStage.REQUESTED);
    // Nothing irreversible has happened yet.
    expect(storageDeleted).toHaveLength(0);
    expect(callsTo("deleteUser")).toHaveLength(0);
    // But the account is already unusable.
    expect((await request(app).get("/api/v1/auth/me").set(...AUTH)).status).toBe(403);
  });

  it("refuses without the current password", async () => {
    const res = await request(app)
      .delete("/api/v1/auth/me")
      .set(...AUTH)
      .send({ currentPassword: "wrong" });
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { id: ctx.user.id } })).not.toBeNull();
  });

  /**
   * THE ORDER IS THE DESIGN, and it is the reverse of the obvious one. Storage
   * objects can only be found through the rows that name them, so the rows have
   * to outlive the objects — deleting the database first would orphan every
   * receipt image permanently, invisible to us and undeletable by anyone.
   */
  it("drains storage, then auth, then the rows", async () => {
    await requestDeletion();

    await runAccountDeletionWorkerOnce();
    expect(storageDeleted).toContain("https://example.test/storage/avatars/1.png");
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });
    expect(callsTo("deleteUser")).toHaveLength(0);

    await runAccountDeletionWorkerOnce();
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.AUTH_DELETED,
    });

    await runAccountDeletionWorkerOnce();
    expect(await prisma.user.findUnique({ where: { id: ctx.user.id } })).toBeNull();
  });

  /**
   * THE FAILURE THE OLD INLINE VERSION COULD NOT RECOVER FROM. It deleted
   * storage, then auth, then the row, with the request as the only driver — so
   * an interruption between any two steps left either an account whose receipts
   * had been shredded but which still logged in, or an unreachable pile of
   * records with no way to sign in and remove them. Neither is a state an owner
   * can get themselves out of. Here the pass simply repeats.
   */
  it("resumes at the stage that was in flight rather than restarting", async () => {
    await requestDeletion();

    storageFails.value = true;
    await runAccountDeletionWorkerOnce();
    let user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    expect(user.deletionStage).toBe(AccountDeletionStage.REQUESTED);
    expect(user.deletionAttempts).toBe(1);
    expect(user.deletionLastError).toContain("could not be removed");

    storageFails.value = false;
    await runAccountDeletionWorkerOnce();
    user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    expect(user.deletionStage).toBe(AccountDeletionStage.STORAGE_CLEARED);

    // The auth stage now fails, and the storage stage is NOT repeated.
    const storageCallsSoFar = storageDeleted.length;
    supabaseFailures.add("deleteUser");
    await runAccountDeletionWorkerOnce();
    expect(storageDeleted.length).toBe(storageCallsSoFar);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });

    supabaseFailures.clear();
    await runAccountDeletionWorkerOnce();
    await runAccountDeletionWorkerOnce();
    expect(await prisma.user.findUnique({ where: { id: ctx.user.id } })).toBeNull();
  });

  it("stops retrying a deletion that cannot succeed, instead of looping forever", async () => {
    await requestDeletion();
    storageFails.value = true;

    for (let i = 0; i < 12; i++) await runAccountDeletionWorkerOnce();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    expect(user.deletionAttempts).toBe(10);
    // Nothing left to claim, so the worker reports idle rather than spinning.
    expect(await runAccountDeletionWorkerOnce()).toBe(false);

    const ready = await request(app).get("/api/v1/health/ready");
    expect(ready.body.stalledAccountDeletions).toBe(1);
  });
});

describe("password recovery", () => {
  it("answers the same way for a registered and an unregistered address", async () => {
    const known = await request(app)
      .post("/api/v1/auth/recover-password")
      .send({ email: ctx.user.email, platform: "web" });
    const unknown = await request(app)
      .post("/api/v1/auth/recover-password")
      .send({ email: "nobody@shop.ph", platform: "web" });

    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
  });

  /**
   * The redirect is built from configuration, never echoed from the request.
   * A client-supplied `redirectTo` would be an open redirect with a live
   * password-reset token attached to it — anyone who could steer it could have
   * the token delivered to themselves.
   */
  it("sends the link to the app that asked, chosen server-side", async () => {
    await request(app).post("/api/v1/auth/recover-password").send({ email: ctx.user.email, platform: "mobile" });
    const opts = callsTo("resetPasswordForEmail").at(-1)?.args[1] as { redirectTo: string };
    expect(opts.redirectTo).toMatch(/^finsight:\/\/auth\/reset-password$/);

    await request(app).post("/api/v1/auth/recover-password").send({ email: ctx.user.email, platform: "web" });
    const web = callsTo("resetPasswordForEmail").at(-1)?.args[1] as { redirectTo: string };
    expect(web.redirectTo).toMatch(/^https?:\/\/.+\/auth\/reset-password$/);
  });

  it("rejects a platform that is not one of the two known clients", async () => {
    const res = await request(app)
      .post("/api/v1/auth/recover-password")
      .send({ email: ctx.user.email, platform: "https://evil.example/steal" });
    expect(res.status).toBe(400);
  });

  /**
   * A delivery failure stays invisible to the visitor and visible to us.
   * Swallowing it entirely — which is what happened before — meant an expired
   * SMTP credential looked exactly like a working system: everyone was told to
   * check their inbox, nothing arrived, and no signal existed anywhere.
   */
  it("keeps its public answer identical when delivery fails", async () => {
    supabaseFailures.add("resetPasswordForEmail");
    const res = await request(app)
      .post("/api/v1/auth/recover-password")
      .send({ email: ctx.user.email, platform: "web" });
    expect(res.status).toBe(200);
  });

  it("ends every session once a reset completes", async () => {
    await request(app).post("/api/v1/auth/reset-password/complete").set(...AUTH);
    expect(callsTo("signOut").map((c) => c.args[1])).toEqual(["global"]);
  });

  /**
   * A reset also proves the address, because the link only ever arrives in the
   * inbox. Without this, anyone who registered and then used "forgot password"
   * instead of the confirmation link would be left holding a working password
   * for an account that still refused to let them in.
   */
  it("activates an account that had never confirmed its address", async () => {
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { status: AccountStatus.PENDING_VERIFICATION },
    });

    await request(app).post("/api/v1/auth/reset-password/complete").set(...AUTH);

    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      status: AccountStatus.ACTIVE,
    });
  });
});

describe("email confirmation", () => {
  it("activates a pending account and is safe to click twice", async () => {
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { status: AccountStatus.PENDING_VERIFICATION },
    });

    const first = await request(app).post("/api/v1/auth/confirm-email").set(...AUTH);
    expect(first.status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      status: AccountStatus.ACTIVE,
    });

    // Mail clients pre-fetch links. A second click must say "you're all set",
    // not "that link is invalid".
    expect((await request(app).post("/api/v1/auth/confirm-email").set(...AUTH)).status).toBe(200);
  });

  it("refuses a token Supabase does not recognise", async () => {
    const res = await request(app).post("/api/v1/auth/confirm-email").set("Authorization", "Bearer nonsense");
    expect(res.status).toBe(400);
  });

  /**
   * THE DEAD END THIS CLOSES, which was reached in practice and not in theory.
   *
   * `status` mirrors a fact that lives in GoTrue, and only `confirmEmail`
   * refreshes it — from the browser, after the confirmation link redirects back
   * into the app. Every step of that return trip can fail while the address is
   * confirmed regardless: a redirect URL missing from Supabase's allow-list (it
   * falls back to the Site URL without erroring), the web app not running at
   * WEB_APP_URL, a mail scanner spending the one-time token first, a closed tab.
   *
   * The resulting account could not be recovered by any route the app offers.
   * Resending is a no-op, because GoTrue will not re-send a signup confirmation
   * to an address it already considers confirmed. Re-registering is a no-op,
   * because an existing address returns the neutral acknowledgement without
   * sending mail. Both silences are deliberate — and together they locked the
   * owner out permanently with nothing on screen to explain why.
   */
  it("reconciles a stale pending status at login when Supabase says confirmed", async () => {
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { status: AccountStatus.PENDING_VERIFICATION },
    });
    signInConfirmed.value = true;

    try {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: ctx.user.email, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
        status: AccountStatus.ACTIVE,
      });
    } finally {
      signInConfirmed.value = false;
    }
  });

  /** The other half of the rule: an address GoTrue has NOT confirmed stays out. */
  it("still refuses login when Supabase agrees the address is unconfirmed", async () => {
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { status: AccountStatus.PENDING_VERIFICATION },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ctx.user.email, password: PASSWORD });

    expect(res.status).toBe(403);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } })).toMatchObject({
      status: AccountStatus.PENDING_VERIFICATION,
    });
  });
});
