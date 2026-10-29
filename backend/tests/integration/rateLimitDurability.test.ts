import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import {
  byEmail,
  LIMITS,
  rateLimit,
  rateLimits,
  refundRateLimitsForError,
  resetRateLimits,
  type RateLimitOptions,
} from "../../src/middleware/rateLimit.middleware";
import { disconnectDb } from "../setup/testDb";

// NODE_ENV=test normally selects the deterministic in-memory test double.
// Select the deployed branch explicitly, using only the guarded local test DB.
function durableLimiter(name: string, limit: number): ReturnType<typeof rateLimit>;
function durableLimiter(options: RateLimitOptions): ReturnType<typeof rateLimit>;
function durableLimiter(nameOrOptions: string | RateLimitOptions, limit?: number) {
  vi.stubEnv("NODE_ENV", "production");
  try {
    return rateLimit(
      typeof nameOrOptions === "string"
        ? { name: nameOrOptions, limit: limit!, windowMs: 60_000 }
        : nameOrOptions,
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

function durableChain(...limiters: RateLimitOptions[]): ReturnType<typeof rateLimits> {
  vi.stubEnv("NODE_ENV", "production");
  try {
    return rateLimits(...limiters);
  } finally {
    vi.unstubAllEnvs();
  }
}

async function call(middleware: ReturnType<typeof rateLimit>, body?: unknown) {
  const req = { ip: "203.0.113.7", headers: {}, method: "POST", path: "/api/v1/auth/login", body } as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, unknown>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const next = vi.fn();
  await middleware(req, res as unknown as Response, next);
  return { res, next };
}

describe("deployed login rate-limit storage", () => {
  beforeEach(async () => {
    await prisma.apiRateLimit.deleteMany();
    resetRateLimits();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(disconnectDb);

  it("shares one quota across fresh middleware instances and concurrent requests", async () => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () => call(durableLimiter("qa-durable", 3))));

    expect(attempts.filter(({ next }) => next.mock.calls.length === 1)).toHaveLength(3);
    expect(attempts.filter(({ res }) => res.statusCode === 429)).toHaveLength(5);
    const stored = await prisma.apiRateLimit.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.count).toBe(8);

    resetRateLimits();
    const afterRestart = await call(durableLimiter("qa-durable", 3));
    expect(afterRestart.res.statusCode).toBe(429);
    expect(afterRestart.next).not.toHaveBeenCalled();
  });

  it.each([
    ["RECEIPT_DELETE_WRITE", LIMITS.RECEIPT_DELETE_WRITE],
    ["RECEIPT_CONFIRM_WRITE", LIMITS.RECEIPT_CONFIRM_WRITE],
    ["RECEIPT_DUPLICATE_READ", LIMITS.RECEIPT_DUPLICATE_READ],
  ])("persists the %s quota in the database and answers 429 past it after a restart", async (_name, limit) => {
    const attempts = [];
    for (let attempt = 0; attempt < limit.limit; attempt++) {
      attempts.push(await call(durableLimiter(limit.name, limit.limit)));
    }
    expect(attempts.every(({ next }) => next.mock.calls.length === 1)).toBe(true);

    resetRateLimits();
    const overLimit = await call(durableLimiter(limit.name, limit.limit));
    expect(overLimit.res.statusCode).toBe(429);
    expect(overLimit.next).not.toHaveBeenCalled();
    const stored = await prisma.apiRateLimit.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.count).toBe(limit.limit + 1);
  });

  it("fails closed during a database outage and uses the persisted quota after recovery", async () => {
    const limiter = durableLimiter("qa-recovery", 1);
    expect((await call(limiter)).next).toHaveBeenCalledWith();
    const outage = new Prisma.PrismaClientInitializationError("Can't reach database server", "6.19.3", "P1001");
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(outage);

    const unavailable = await call(limiter);
    expect(unavailable.next).toHaveBeenCalledExactlyOnceWith(outage);
    expect(unavailable.res.statusCode).toBe(0);

    const recovered = await call(limiter);
    expect(recovered.res.statusCode).toBe(429);
    expect(recovered.next).not.toHaveBeenCalled();
    expect((await prisma.apiRateLimit.findMany())[0]!.count).toBe(2);
  });

  it("refunds a provider outage once from the exact active re-auth window", async () => {
    const limiter = durableLimiter(LIMITS.AUTH_REAUTH);
    const first = await call(limiter);
    await call(limiter);

    expect((await prisma.apiRateLimit.findFirstOrThrow()).count).toBe(2);
    await refundRateLimitsForError(first.res as unknown as Response, "AUTH_PROVIDER_UNAVAILABLE");
    expect((await prisma.apiRateLimit.findFirstOrThrow()).count).toBe(1);

    expect(refundRateLimitsForError(first.res as unknown as Response, "AUTH_PROVIDER_UNAVAILABLE")).toBeNull();
    expect((await prisma.apiRateLimit.findFirstOrThrow()).count).toBe(1);
  });

  it("does not refund a new window after the registered re-auth window rolls over", async () => {
    const limiter = durableLimiter(LIMITS.AUTH_REAUTH);
    const original = await call(limiter);
    await prisma.apiRateLimit.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } });

    await call(limiter);
    const rolled = await prisma.apiRateLimit.findFirstOrThrow();
    expect(rolled.count).toBe(1);

    await refundRateLimitsForError(original.res as unknown as Response, "AUTH_PROVIDER_UNAVAILABLE");
    const afterRefund = await prisma.apiRateLimit.findFirstOrThrow();
    expect(afterRefund.count).toBe(1);
    expect(afterRefund.expiresAt.getTime()).toBe(rolled.expiresAt.getTime());
  });

  describe("several limiters counted in one statement", () => {
    const burst = { name: "qa-chain-burst", limit: 2, windowMs: 60_000 };
    const hourly = { name: "qa-chain-hourly", limit: 10, windowMs: 3_600_000 };
    const shared = { name: "qa-chain-shared", limit: 100, windowMs: 86_400_000, identify: () => "all" };
    const counts = async () => Object.fromEntries(
      (await prisma.apiRateLimit.findMany()).map((row) => [row.key.split(":")[0], row.count]),
    );

    it("counts every limiter in a single round trip while each one passes", async () => {
      const queryRaw = vi.spyOn(prisma, "$queryRaw");
      const passed = await call(durableChain(burst, hourly, shared));

      expect(passed.next).toHaveBeenCalledWith();
      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(await counts()).toEqual({ "qa-chain-burst": 1, "qa-chain-hourly": 1, "qa-chain-shared": 1 });
      // Headers describe the last limiter consulted, as the old middleware chain left them.
      expect(passed.res.headers["RateLimit-Limit"]).toBe("100");
    });

    it("does not count the limiters after the one that refused, so a shared budget is never spent on a refusal", async () => {
      const chain = durableChain(burst, hourly, shared);
      await call(chain);
      await call(chain);
      const refused = await call(chain);

      expect(refused.res.statusCode).toBe(429);
      expect(refused.next).not.toHaveBeenCalled();
      expect(refused.res.headers["RateLimit-Limit"]).toBe("2");
      expect(await counts()).toEqual({ "qa-chain-burst": 3, "qa-chain-hourly": 2, "qa-chain-shared": 2 });
    });

    it("answers with the refusing limiter's own code when a later limiter is the one exhausted", async () => {
      const chain = durableChain(burst, { ...shared, limit: 1, refusal: { code: "DAILY_CAPACITY_REACHED", message: () => "paused" } });
      await call(chain);
      const refused = await call(chain);

      expect(refused.res.statusCode).toBe(429);
      expect(refused.res.body).toMatchObject({ code: "DAILY_CAPACITY_REACHED" });
      expect(await counts()).toEqual({ "qa-chain-burst": 2, "qa-chain-shared": 2 });
    });

    it("skips a limiter whose identity is absent and still counts the rest", async () => {
      const chain = durableChain({ ...burst, identify: byEmail }, hourly);
      expect((await call(chain)).next).toHaveBeenCalledWith();
      expect(await counts()).toEqual({ "qa-chain-hourly": 1 });

      expect((await call(chain, { email: "Owner@Shop.ph" })).next).toHaveBeenCalledWith();
      expect(await counts()).toEqual({ "qa-chain-burst": 1, "qa-chain-hourly": 2 });
    });

    it("keeps an exact quota under concurrent requests", async () => {
      const chain = durableChain(burst, shared);
      const attempts = await Promise.all(Array.from({ length: 8 }, () => call(chain)));

      expect(attempts.filter(({ next }) => next.mock.calls.length === 1)).toHaveLength(2);
      expect(await counts()).toEqual({ "qa-chain-burst": 8, "qa-chain-shared": 2 });
    });
  });
});
