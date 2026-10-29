import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn());
vi.mock("../../src/config/errorReporting", () => ({ reportError }));

import { prisma } from "../../src/config/prisma";
import { LIMITS } from "../../src/middleware/rateLimit.middleware";
import { sweepSustainedUsage } from "../../src/services/usageAlerts.service";
import { disconnectDb, resetDb } from "../setup/testDb";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
// USAGE_ALERT_SHARE 0.8 and USAGE_ALERT_DAYS 3 are the defaults.
const ASK = LIMITS.ASK_DAILY;
const ASK_THRESHOLD = Math.ceil(ASK.limit * 0.8);

/** A live daily window for `key`, expiring `expiresInMs` after `now`. */
async function liveWindow(key: string, count: number, now: Date, expiresInMs = 12 * HOUR_MS) {
  await prisma.apiRateLimit.upsert({
    where: { key },
    create: { key, count, windowStart: new Date(now.getTime() + expiresInMs - DAY_MS), expiresAt: new Date(now.getTime() + expiresInMs) },
    update: { count, windowStart: new Date(now.getTime() + expiresInMs - DAY_MS), expiresAt: new Date(now.getTime() + expiresInMs) },
  });
}

/** A day the sweep already recorded for `key`, whose window ended `daysAgo` days before `now`. */
async function pastWindow(key: string, now: Date, daysAgo: number) {
  await prisma.sustainedUsageWindow.create({
    data: { key, count: ASK_THRESHOLD, windowExpiresAt: new Date(now.getTime() - daysAgo * DAY_MS) },
  });
}

beforeEach(async () => {
  await resetDb();
  reportError.mockClear();
});
afterAll(disconnectDb);

describe("sustained-usage sweep", () => {
  it("records a window once it passes the alert share, and only once however often the sweep runs", async () => {
    const now = new Date();
    await liveWindow(`${ASK.name}:u7`, ASK_THRESHOLD - 1, now);
    expect(await sweepSustainedUsage(now)).toMatchObject({ recorded: 0, reported: 0 });

    await liveWindow(`${ASK.name}:u7`, ASK_THRESHOLD, now);
    expect(await sweepSustainedUsage(now)).toMatchObject({ recorded: 1, reported: 0 });
    expect(await sweepSustainedUsage(now)).toMatchObject({ recorded: 0, reported: 0 });
    expect(await prisma.sustainedUsageWindow.count()).toBe(1);
  });

  it("reports an owner whose use crossed the share in enough recent daily windows", async () => {
    const now = new Date();
    await pastWindow(`${ASK.name}:u7`, now, 0.5);
    await pastWindow(`${ASK.name}:u7`, now, 1.5);
    await liveWindow(`${ASK.name}:u7`, ASK_THRESHOLD + 5, now);

    expect(await sweepSustainedUsage(now)).toMatchObject({ recorded: 1, reported: 1 });
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]![1]).toEqual({
      level: "warning",
      limiter: ASK.name,
      ownerId: "7",
      fingerprint: ["sustained-usage", ASK.name, "7"],
    });
  });

  it("does not report heavy days that are too few or too far apart", async () => {
    const now = new Date();
    await pastWindow(`${ASK.name}:u7`, now, 0.5);
    await pastWindow(`${ASK.name}:u7`, now, 5);
    await liveWindow(`${ASK.name}:u7`, ASK_THRESHOLD, now);
    await liveWindow(`${ASK.name}:u8`, ASK.limit, now);

    expect(await sweepSustainedUsage(now)).toMatchObject({ recorded: 2, reported: 0 });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("ignores expired windows, shared budgets and other limiters", async () => {
    const now = new Date();
    await liveWindow(`${ASK.name}:u7`, ASK.limit, now, -HOUR_MS);
    await liveWindow("shared-ai-answers-daily:all", 1_000_000, now);
    await liveWindow(`${LIMITS.ASK_HOURLY.name}:u7`, 1_000_000, now);

    expect(await sweepSustainedUsage(now)).toMatchObject({ recorded: 0 });
    expect(await prisma.sustainedUsageWindow.count()).toBe(0);
  });

  it("forgets recorded windows after thirty days", async () => {
    const now = new Date();
    await pastWindow(`${ASK.name}:u7`, now, 31);
    await pastWindow(`${ASK.name}:u7`, now, 29);

    expect(await sweepSustainedUsage(now)).toMatchObject({ pruned: 1 });
    expect(await prisma.sustainedUsageWindow.count()).toBe(1);
  });
});
