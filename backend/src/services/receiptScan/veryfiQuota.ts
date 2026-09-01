import { prisma } from "../../config/prisma";
import { env } from "../../config/env";

/**
 * A calendar-month request cap on Veryfi calls, so a deliberately-enabled
 * integration cannot silently run past a trial or paid plan's limit.
 *
 * See docs/superpowers/specs/2026-09-01-veryfi-production-ocr-integration-design.md.
 * The only reader/writer of the `VeryfiUsage` table.
 */

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Whether a Veryfi call is still allowed this month.
 *
 * `VERYFI_MONTHLY_LIMIT` unset means unlimited — see its own comment in
 * env.ts for why that is the default rather than zero.
 */
export async function veryfiQuotaAvailable(): Promise<boolean> {
  if (env.VERYFI_MONTHLY_LIMIT === undefined) return true;

  const usage = await prisma.veryfiUsage.findUnique({ where: { month: currentMonthKey() } });
  return (usage?.count ?? 0) < env.VERYFI_MONTHLY_LIMIT;
}

/**
 * Records one Veryfi call attempt against this month's count.
 *
 * Called only when Veryfi was actually attempted — a call skipped because
 * the quota was already exhausted, or because `VERYFI_ENABLED` is false,
 * must never increment this.
 */
export async function recordVeryfiUsage(): Promise<void> {
  const month = currentMonthKey();
  await prisma.veryfiUsage.upsert({
    where: { month },
    create: { month, count: 1 },
    update: { count: { increment: 1 } },
  });
}
