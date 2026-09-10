import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { api, errorMessage } = await import("../src/lib/api");

function reply(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * WHY 503 IS SINGLED OUT. Losing the database connection for a moment is the
 * most common 5xx this app will ever show, and it is not a defect in the
 * request — a retry a second later works. Flattening it into the generic 5xx
 * line ("the server had a problem with that") tells the owner the opposite:
 * that something they did was wrong and that retrying is pointless. The server
 * sends a sentence that says what is actually happening, so the client's job
 * is to not throw it away.
 */
describe("5xx message handling", () => {
  const original = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("keeps the server's reason for a 503", async () => {
    const reason = "FinSight can't reach its database right now. This is usually a brief connection problem — please try again in a moment. Nothing on your account has changed.";
    vi.mocked(globalThis.fetch).mockResolvedValue(reply(503, { error: reason, code: "DATABASE_UNREACHABLE" }));

    const err = await api.get("/dashboard").then(() => null, (e: unknown) => e);
    expect(errorMessage(err)).toBe(reason);
    expect((err as { status: number }).status).toBe(503);
  });

  it("still replaces a 500 body, which carries no reason worth showing", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(reply(500, { error: "Internal server error" }));

    const err = await api.get("/dashboard").then(() => null, (e: unknown) => e);
    expect(errorMessage(err)).toBe("FinSight's server had a problem with that. Please try again in a moment.");
  });
});
