import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthClient } from "@supabase/auth-js";

const AUTH_URL = "https://project.supabase.test/auth/v1";
const KID = "test-key";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const { privateKey: strangerKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

const requests: string[] = [];
const getUserAnswer = vi.fn();

// The real supabase-js client, so the signature check under test is the real
// one; only the network is stubbed.
const auth = new AuthClient({
  url: AUTH_URL,
  autoRefreshToken: false,
  persistSession: false,
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/user")) {
      const { status, body } = getUserAnswer() as { status: number; body: unknown };
      return Response.json(body, { status });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch,
});

const liveSessions = new Set<string>();
vi.mock("../../src/config/supabase", () => ({ supabaseAdmin: { auth } }));
vi.mock("../../src/config/prisma", () => ({
  prisma: {
    // Stands in for auth.sessions: the session id is the first value bound.
    $queryRaw: async (_sql: TemplateStringsArray, sessionId: string) => (liveSessions.has(sessionId) ? [{ "?column?": 1 }] : []),
  },
}));

const { verifyAccessToken } = await import("../../src/lib/accessToken");

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function es256Token(claims: Record<string, unknown>, key = privateKey, kid = KID): string {
  const signingInput = `${encode({ alg: "ES256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function userClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: randomUUID(),
    session_id: randomUUID(),
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe("verifyAccessToken", () => {
  beforeEach(() => {
    requests.length = 0;
    liveSessions.clear();
    getUserAnswer.mockReset();
  });

  it("accepts a signed token with a live session without asking Supabase Auth about it", async () => {
    const claims = userClaims();
    liveSessions.add(claims.session_id);

    const verdict = await verifyAccessToken(es256Token(claims));

    expect(verdict).toEqual({ authUserId: claims.sub, error: null });
    expect(requests.some((url) => url.endsWith("/user"))).toBe(false);
  });

  it("refuses a token signed by any other key", async () => {
    const claims = userClaims();
    liveSessions.add(claims.session_id);

    const verdict = await verifyAccessToken(es256Token(claims, strangerKey));

    expect(verdict.authUserId).toBeUndefined();
    expect(verdict.error).not.toBeNull();
  });

  it("refuses a correctly signed token whose session has ended", async () => {
    // Log out deletes the session; the signature stays valid until expiry.
    const verdict = await verifyAccessToken(es256Token(userClaims()));

    expect(verdict.authUserId).toBeUndefined();
    expect(verdict.error?.message).toMatch(/session/i);
  });

  it("refuses an expired token", async () => {
    const claims = userClaims({ exp: Math.floor(Date.now() / 1000) - 10 });
    liveSessions.add(claims.session_id);

    expect((await verifyAccessToken(es256Token(claims))).authUserId).toBeUndefined();
  });

  it("refuses a signed token that is not a user session", async () => {
    const verdict = await verifyAccessToken(es256Token({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 3600 }));

    expect(verdict.authUserId).toBeUndefined();
  });

  it("leaves legacy shared-secret tokens to Supabase Auth", async () => {
    const authUserId = randomUUID();
    getUserAnswer.mockReturnValue({ status: 200, body: { id: authUserId, aud: "authenticated" } });
    const legacy = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(userClaims({ sub: authUserId }))}.signature`;

    const verdict = await verifyAccessToken(legacy);

    expect(verdict).toEqual({ authUserId, error: null });
    expect(requests.some((url) => url.endsWith("/user"))).toBe(true);
  });

  it("passes on Supabase Auth's refusal of a legacy token", async () => {
    getUserAnswer.mockReturnValue({ status: 403, body: { code: "session_not_found", msg: "Session not found" } });
    const legacy = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(userClaims())}.signature`;

    const verdict = await verifyAccessToken(legacy);

    expect(verdict.authUserId).toBeUndefined();
    expect(verdict.error?.status).toBe(403);
  });
});
