import type { Request, Response } from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import { LIMITS, rateLimit, resetRateLimits, type RateLimitOptions } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb } from "../setup/testDb";

function deployed(options: RateLimitOptions) {
  vi.stubEnv("NODE_ENV", "production");
  try { return rateLimit(options); } finally { vi.unstubAllEnvs(); }
}

async function attempt(options: RateLimitOptions, userId = 1) {
  const res = {
    locals: {}, headers: {} as Record<string, string>, code: 0, body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const next = vi.fn();
  await deployed(options)({ user: { id: userId }, method: "POST", headers: {}, path: "/synthetic-test" } as Request,
    res as unknown as Response, next);
  return { res, next };
}

beforeEach(async () => { await prisma.apiRateLimit.deleteMany(); resetRateLimits(); });
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

describe("deployed hardening quota persistence", () => {
  it.each([LIMITS.AUTHENTICATED_WRITE, LIMITS.SUGGEST_CATEGORY_HOURLY, LIMITS.SCAN_RECEIPT_HOURLY])(
    "enforces $name from its stored quota across a fresh middleware instance", async (options) => {
      const now = new Date();
      await prisma.apiRateLimit.create({ data: {
        key: `${options.name}:u1`, count: options.limit, windowStart: now, expiresAt: new Date(now.getTime() + options.windowMs),
      } });
      resetRateLimits();
      const blocked = await attempt(options);
      expect(blocked.res.code).toBe(429);
      expect(blocked.next).not.toHaveBeenCalled();
      expect(blocked.res.body).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: Number(blocked.res.headers["Retry-After"]) });
      expect((await prisma.apiRateLimit.findUniqueOrThrow({ where: { key: `${options.name}:u1` } })).count).toBe(options.limit + 1);
      expect((await attempt(options, 2)).next).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("fails closed when the durable write-counter database call fails", async () => {
    const outage = new Prisma.PrismaClientInitializationError("Synthetic database outage", "6.19.3", "P1001");
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(outage);
    const unavailable = await attempt(LIMITS.AUTHENTICATED_WRITE);
    expect(unavailable.next).toHaveBeenCalledExactlyOnceWith(outage);
    expect(unavailable.res.code).toBe(0);
    expect(await prisma.apiRateLimit.count()).toBe(0);
  });
});
