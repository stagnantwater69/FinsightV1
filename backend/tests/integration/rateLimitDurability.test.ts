import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import { LIMITS, rateLimit, resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb } from "../setup/testDb";

// NODE_ENV=test normally selects the deterministic in-memory test double.
// Select the deployed branch explicitly, using only the guarded local test DB.
function durableLimiter(name: string, limit: number) {
  vi.stubEnv("NODE_ENV", "production");
  try {
    return rateLimit({ name, limit, windowMs: 60_000 });
  } finally {
    vi.unstubAllEnvs();
  }
}

async function call(middleware: ReturnType<typeof rateLimit>) {
  const req = { ip: "203.0.113.7", headers: {}, method: "POST", path: "/api/v1/auth/login" } as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
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
});
