import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { reportError } from "../config/errorReporting";
import { OWNER_DAILY_CAPS } from "../middleware/rateLimit.middleware";

/*
 * SUSTAINED USE OF A BILLED CALL BY ONE OWNER.
 *
 * The per-owner daily caps stop any one day from costing more than a ceiling,
 * and the API already reports an owner who hits one. What neither catches is
 * an account that stays just under its cap every day — a script tuned to the
 * limit, or a client stuck in a slow loop — which costs the most over a month
 * and never trips anything.
 *
 * So once an hour this reads the live daily-cap windows in ApiRateLimit and
 * records each one in which an owner passed USAGE_ALERT_SHARE of the cap. When
 * an owner has done that in USAGE_ALERT_DAYS windows within that many days,
 * the newly recorded window is reported: at most one report per owner per cap
 * per day while it lasts, grouped in Sentry into one issue per owner and cap.
 *
 * It only reports. Nothing here refuses a request; the caps already do that.
 */

const DAY_MS = 24 * 60 * 60_000;
const RETENTION_MS = 30 * DAY_MS;

export interface SustainedUsageSweep {
  /** Windows that crossed the threshold since the last sweep. */
  recorded: number;
  /** Of those, the ones that made a sustained pattern and were reported. */
  reported: number;
  pruned: number;
}

export async function sweepSustainedUsage(now = new Date()): Promise<SustainedUsageSweep> {
  let recorded = 0;
  let reported = 0;
  const lookback = new Date(now.getTime() - env.USAGE_ALERT_DAYS * DAY_MS);

  for (const cap of OWNER_DAILY_CAPS) {
    const threshold = Math.ceil(cap.limit * env.USAGE_ALERT_SHARE);
    // A window already recorded is skipped, so RETURNING lists only the
    // windows that crossed since the last sweep.
    const crossed = await prisma.$queryRaw<Array<{ key: string }>>`
      INSERT INTO "SustainedUsageWindow" (
        "SustainedUsageWindow_Key", "SustainedUsageWindow_WindowExpiresAt", "SustainedUsageWindow_Count"
      )
      SELECT "ApiRateLimit_Key", "ApiRateLimit_ExpiresAt", "ApiRateLimit_Count"
      FROM "ApiRateLimit"
      WHERE "ApiRateLimit_Key" LIKE ${`${cap.name}:u%`}
        AND "ApiRateLimit_ExpiresAt" > ${now}
        AND "ApiRateLimit_Count" >= ${threshold}
      ON CONFLICT DO NOTHING
      RETURNING "SustainedUsageWindow_Key" AS key
    `;
    recorded += crossed.length;
    if (crossed.length === 0) continue;

    const windows = await prisma.sustainedUsageWindow.groupBy({
      by: ["key"],
      where: { key: { in: crossed.map((row) => row.key) }, windowExpiresAt: { gt: lookback } },
      _count: true,
    });
    for (const { key, _count: windowCount } of windows) {
      if (windowCount < env.USAGE_ALERT_DAYS) continue;
      const ownerId = key.slice(key.indexOf(":u") + 2);
      logger.warn({ limiter: cap.name, ownerId, windows: windowCount }, "sustained high usage of a billed call");
      reportError(
        new Error(`Sustained use of "${cap.name}": ${windowCount} days at ${threshold}+ of ${cap.limit}`),
        { level: "warning", limiter: cap.name, ownerId, fingerprint: ["sustained-usage", cap.name, ownerId] },
      );
      reported++;
    }
  }

  const { count: pruned } = await prisma.sustainedUsageWindow.deleteMany({
    where: { windowExpiresAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
  return { recorded, reported, pruned };
}
