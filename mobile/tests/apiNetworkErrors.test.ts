import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://10.32.98.74:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { api, errorMessage } = await import("../src/lib/api");

describe("network failures show useful guidance without transport details", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it.each([
    new TypeError("Failed to fetch"),
    new Error("Network request failed: http://10.32.98.74:4000/api/v1/auth/login"),
    "raw transport detail",
  ])("handles a failed login safely (%s)", async (failure) => {
    globalThis.fetch = vi.fn().mockRejectedValue(failure);

    const err = await api.post("/auth/login", { email: "owner@example.com", password: "synthetic-password" })
      .then(() => null, (error: unknown) => error);

    expect(err).toMatchObject({ status: 0 });
    expect(errorMessage(err)).toBe("Couldn't reach FinSight. Check your connection and try again in a moment.");
  });
});
