import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { api, setSessionEndedHandler } = await import("../src/lib/api");

const AUTH_CONTEXT = readFileSync(join(__dirname, "..", "src", "context", "AuthContext.tsx"), "utf8");

function reply(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * INT-001. A dead session used to be a sentence and nothing else.
 *
 * `toError` rewrote every authenticated 401 to "Your session has expired.
 * Please log in again." and then the app carried on exactly where it was — in
 * the authenticated shell, holding a token the server had already refused, with
 * every screen after it failing the same way. There was no reaction at all to a
 * suspended or unconfirmed account: `requireAuth` answers those with 403 and
 * `code: "ACCOUNT_NOT_ACTIVE"`, and nothing in the client read that code.
 *
 * The transport cannot navigate, so it reports the fact upwards; AuthProvider
 * clears the session and App.tsx renders AuthStack the moment there is no
 * profile. Same arrangement web uses.
 */
describe("a session the server has ended", () => {
  const original = globalThis.fetch;
  let reasons: string[];

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    reasons = [];
    setSessionEndedHandler((reason) => reasons.push(reason));
  });
  afterEach(() => {
    globalThis.fetch = original;
    setSessionEndedHandler(null);
  });

  it("ends the session on an authenticated 401", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(reply(401, { error: "Invalid or expired session" }));
    await api.get("/dashboard").catch(() => undefined);
    expect(reasons).toEqual(["expired"]);
  });

  /**
   * The login form's own 401 is "that password is wrong", not "your session
   * ended" — signing someone out of a session they do not have yet, on the
   * screen they are trying to sign in on, is the loop this guards against.
   */
  it("leaves the credential endpoints alone", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(reply(401, { error: "Invalid email or password" }));
    await api.post("/auth/login", { email: "a@b.c", password: "x" }).catch(() => undefined);
    await api.post("/auth/register", {}).catch(() => undefined);
    await api.post("/auth/change-password", {}).catch(() => undefined);
    await api.post("/auth/recover-password", {}).catch(() => undefined);
    expect(reasons).toEqual([]);
  });

  it("ends the session on a 403 that carries ACCOUNT_NOT_ACTIVE", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reply(403, { error: "This account has been suspended.", code: "ACCOUNT_NOT_ACTIVE" }),
    );
    await api.get("/dashboard").catch(() => undefined);
    expect(reasons).toEqual(["account-not-active"]);
  });

  /**
   * Matched on the code, never the status. Plenty of honest 403s mean "that
   * record is not yours", and ending the session on those would sign an owner
   * out for opening the wrong thing.
   */
  it("leaves an ordinary 403 alone", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(reply(403, { error: "Forbidden" }));
    await api.get("/records/expenses/9").catch(() => undefined);
    expect(reasons).toEqual([]);
  });

  it("keeps the caller's own error, so the screen mid-request still has something to show", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(reply(401, { error: "Missing bearer token" }));
    const err = await api.get("/dashboard").then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("Your session has expired. Please log in again.");
  });
});

/**
 * The handler is only half the fix; what it does is the other half. AuthContext
 * cannot be mounted by the source project, so its wiring is read.
 */
describe("AuthProvider's reaction", () => {
  it("registers a handler and clears it on unmount", () => {
    expect(AUTH_CONTEXT).toContain("setSessionEndedHandler((reason) =>");
    expect(AUTH_CONTEXT).toContain("return () => setSessionEndedHandler(null);");
  });

  /** Clearing `profile` IS the navigation — App.tsx renders AuthStack without one. */
  it("drops the local session rather than only recording a reason", () => {
    expect(AUTH_CONTEXT).toMatch(/setProfile\(null\);\s*\n\s*setPreferences\(null\);\s*\n\s*void supabase\.auth\.signOut\(\);/);
  });

  /**
   * A 401 on the cold-start /auth/me is "this stored token is no longer any
   * good", not an expiry the owner lived through — the token still has to go,
   * but they must not be told a session ended that they never had.
   */
  it("only announces to someone who was actually signed in", () => {
    expect(AUTH_CONTEXT).toContain("if (signedInRef.current) setSessionEnded(reason);");
  });

  /**
   * A deliberate logout with an already-dead token must not read as a fault.
   *
   * The sign-in half is now pinned on `adoptSession` rather than on `login`.
   * Confirming an email and exchanging a session handoff both end with a
   * session the backend has already validated, so they enter through the same
   * tail login does — and every one of them has to leave the "your session
   * ended" banner cleared behind it, or the owner's next sign-out shows a
   * warning about a session that ended perfectly normally an hour ago.
   */
  it("clears the banner on a deliberate sign-out and on a successful sign-in", () => {
    expect(AUTH_CONTEXT).toMatch(/clearLocalSession\(\)[\s\S]*?setSessionEnded\(null\);/);
    expect(AUTH_CONTEXT).toMatch(/setProfile\(p\);[\s\S]{0,200}?setSessionEnded\(null\);/);
    // …and that login has not grown a second copy of that tail.
    expect(AUTH_CONTEXT).toMatch(/await adoptSession\(data\.session, data\.profile\);/);
  });
});
