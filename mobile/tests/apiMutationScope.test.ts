import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { api } = await import("../src/lib/api");
const {
  beginServerStateSession,
  clearServerStateCache,
  fetchServerState,
  peekServerState,
} = await import("../src/lib/serverStateCache");

const BUSINESS_A = 11;
const BUSINESS_B = 22;

function reply(status = 200, body: unknown = {}) {
  return {
    ok: true,
    status,
    text: async () => (status === 204 ? "" : JSON.stringify(body)),
  } as Response;
}

async function seedForBoth(paths: readonly string[]) {
  await Promise.all(
    paths.flatMap((path) =>
      [BUSINESS_A, BUSINESS_B].map((businessProfileId) =>
        fetchServerState({
          path,
          query: { businessProfileId },
          fetcher: async () => ({ path, businessProfileId }),
        }),
      ),
    ),
  );
}

function expectEvictedOnlyForBusiness(paths: readonly string[]) {
  for (const path of paths) {
    expect(peekServerState(path, { businessProfileId: BUSINESS_A })).toBeNull();
    expect(peekServerState(path, { businessProfileId: BUSINESS_B })).not.toBeNull();
  }
}

function expectLocalOptionsStayedOffWire(path: string, body?: unknown) {
  const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  expect(url).toBe(`http://localhost:4000/api/v1${path}`);
  expect(init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
  expect(init?.headers).not.toHaveProperty("cacheScope");
  expect(String(url)).not.toContain("cacheScope");
}

describe("business-scoped mutation invalidation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearServerStateCache();
    beginServerStateSession("mutation-scope");
    globalThis.fetch = vi.fn(async () => reply()) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearServerStateCache();
  });

  it("scopes a 204 record delete without adding the business to the request", async () => {
    const paths = ["/records/search", "/dashboard/summary", "/insights/expense-overview"];
    await seedForBoth(paths);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(reply(204));

    await api.delete("/records/expenses/91", undefined, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/records/expenses/91");
  });

  it("scopes a record patch without adding the business to the request body", async () => {
    const paths = ["/records/search", "/dashboard/summary", "/insights/expense-overview"];
    const body = { description: "Updated stock purchase", amount: 900 };
    await seedForBoth(paths);

    await api.patch("/records/expenses/91", body, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/records/expenses/91", body);
  });

  it("scopes finding review while preserving its existing request body", async () => {
    const paths = ["/insights/findings", "/dashboard/summary", "/insights/expense-overview"];
    const body = { status: "CONFIRMED", feedback: "DUPLICATE" };
    await seedForBoth(paths);

    await api.patch("/insights/findings/7/review", body, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/insights/findings/7/review", body);
  });

  it("scopes receipt confirmation while preserving its existing request body", async () => {
    const paths = ["/records/search", "/dashboard/summary", "/insights/expense-overview"];
    const body = {
      expectedScanRevision: 3,
      date: "2026-09-30",
      description: "Market supplies",
      amount: 1250,
      splits: [{ categoryId: 4, amount: 1250 }],
    };
    await seedForBoth(paths);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(reply(200, []));

    await api.post("/records/receipts/41/confirm", body, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/records/receipts/41/confirm", body);
  });

  it("scopes a recurring schedule edit", async () => {
    const paths = [
      "/insights/recurring-schedules",
      "/insights/recurring-patterns",
      "/insights/findings",
      "/notifications",
      "/dashboard/summary",
    ];
    const body = { label: "Shop rent" };
    await seedForBoth(paths);

    await api.patch("/insights/recurring-schedules/5", body, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/insights/recurring-schedules/5", body);
  });

  it("scopes a recurring schedule delete", async () => {
    const paths = [
      "/insights/recurring-schedules",
      "/insights/recurring-patterns",
      "/insights/findings",
      "/notifications",
      "/dashboard/summary",
    ];
    await seedForBoth(paths);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(reply(204));

    await api.delete("/insights/recurring-schedules/5", undefined, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/insights/recurring-schedules/5");
  });

  it("scopes one notification read and refreshes the dashboard", async () => {
    const paths = ["/notifications", "/dashboard/summary"];
    await seedForBoth(paths);

    await api.patch("/notifications/9/read", undefined, {
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    expectLocalOptionsStayedOffWire("/notifications/9/read");
  });

  it("keeps mark-all's business query on the wire while scoping invalidation locally", async () => {
    const paths = ["/notifications", "/dashboard/summary"];
    await seedForBoth(paths);

    await api.patch("/notifications/read-all", undefined, {
      query: { businessProfileId: BUSINESS_A },
      cacheScope: { businessProfileId: BUSINESS_A },
    });

    expectEvictedOnlyForBusiness(paths);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
    expect(url).toBe(
      `http://localhost:4000/api/v1/notifications/read-all?businessProfileId=${BUSINESS_A}`,
    );
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("cacheScope");
  });

  it.each(["PUT", "DELETE"])(
    "%s derives recovery-plan cache scope from the path without changing the wire contract",
    async (method) => {
      const pathA = `/business-profiles/${BUSINESS_A}/recovery-plans`;
      const pathB = `/business-profiles/${BUSINESS_B}/recovery-plans`;
      await Promise.all([
        fetchServerState({
          path: pathA,
          query: { month: "2026-08" },
          fetcher: async () => ({ businessProfileId: BUSINESS_A }),
        }),
        fetchServerState({
          path: pathB,
          query: { month: "2026-08" },
          fetcher: async () => ({ businessProfileId: BUSINESS_B }),
        }),
      ]);
      const mutationPath = `${pathA}/2026-08`;
      const body = { ownerTargetAmount: 30_000 };

      if (method === "PUT") await api.put(mutationPath, body);
      else await api.delete(mutationPath);

      expect(peekServerState(pathA, { month: "2026-08" })).toBeNull();
      expect(peekServerState(pathB, { month: "2026-08" })).not.toBeNull();
      expectLocalOptionsStayedOffWire(mutationPath, method === "PUT" ? body : undefined);
    },
  );

  it("keeps the existing PATCH query position on the wire", async () => {
    await api.patch("/notifications/read-all", undefined, {
      businessProfileId: BUSINESS_A,
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
    expect(url).toBe(
      `http://localhost:4000/api/v1/notifications/read-all?businessProfileId=${BUSINESS_A}`,
    );
    expect(init?.body).toBeUndefined();
  });

  it("keeps the existing DELETE header position on the wire", async () => {
    await api.delete(
      "/records/receipts/41",
      undefined,
      { "Idempotency-Key": "delete-41" },
    );

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
    expect(url).toBe("http://localhost:4000/api/v1/records/receipts/41");
    expect(init?.headers).toMatchObject({ "Idempotency-Key": "delete-41" });
    expect(init?.body).toBeUndefined();
  });
});
