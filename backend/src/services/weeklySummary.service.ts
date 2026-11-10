import { prisma } from "../config/prisma";
import { resolveBusinessToday, utcAddDays, utcDateKey, utcEndOfDay, utcIsoWeekday } from "../lib/dates";
import { COUNTED_EXPENSE } from "./financialPosition.service";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";

/**
 * One alert each Monday, in the business's own timezone, summing up the week
 * that just ended: counted expenses and recorded sales, by record date. It
 * points the owner at Ask FinSight for the detail rather than trying to be a
 * report itself.
 *
 * Idempotent per business and week: a profile that already has a summary
 * from the last six days is skipped, so the hourly sweep sends at most one.
 * A week with no records at all sends nothing.
 *
 * shortcut: the skip check and the insert are not one transaction, so two
 * workers sweeping in the same instant could both send. The maintenance lane
 * runs once per deployment today; add an advisory lock if that changes.
 */
const MESSAGE_LIMIT = 255;

export interface WeeklySummaryResult {
  sent: number;
}

function peso(n: number): string {
  return `PHP ${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function weeklySummaryMessage(
  week: { start: Date; end: Date },
  totals: { expenses: number; expenseCount: number; sales: number; salesCount: number },
): string {
  const range = `${utcDateKey(week.start)} to ${utcDateKey(week.end)}`;
  return (
    `Last week (${range}): ${peso(totals.sales)} in sales from ${totals.salesCount} record(s), ` +
    `${peso(totals.expenses)} in expenses from ${totals.expenseCount} record(s). Ask Fin what changed.`
  ).slice(0, MESSAGE_LIMIT);
}

export async function sendWeeklySummaries(now: Date = new Date()): Promise<WeeklySummaryResult> {
  const profiles = await prisma.businessProfile.findMany({
    where: { user: { status: "ACTIVE", deletionRequestedAt: null } },
    select: { id: true, userId: true, timezone: true },
  });
  const alreadySentSince = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  let sent = 0;

  for (const profile of profiles) {
    const today = resolveBusinessToday(profile.timezone, now);
    if (utcIsoWeekday(today) !== 1) continue;

    const recent = await prisma.notification.findFirst({
      where: { businessProfileId: profile.id, type: NOTIFICATION_TYPES.WEEKLY_SUMMARY, dateCreated: { gte: alreadySentSince } },
      select: { id: true },
    });
    if (recent) continue;

    const week = { start: utcAddDays(today, -7), end: utcAddDays(today, -1) };
    const date = { gte: week.start, lte: utcEndOfDay(week.end) };
    const [expenses, sales] = await Promise.all([
      prisma.expenseRecord.aggregate({
        where: { businessProfileId: profile.id, ...COUNTED_EXPENSE, date },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.salesReferenceRecord.aggregate({
        where: { businessProfileId: profile.id, date },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    if (expenses._count._all === 0 && sales._count._all === 0) continue;

    await createNotification(
      profile.userId,
      profile.id,
      NOTIFICATION_TYPES.WEEKLY_SUMMARY,
      weeklySummaryMessage(week, {
        expenses: Number(expenses._sum.amount ?? 0),
        expenseCount: expenses._count._all,
        sales: Number(sales._sum.amount ?? 0),
        salesCount: sales._count._all,
      }),
    );
    sent += 1;
  }
  return { sent };
}
