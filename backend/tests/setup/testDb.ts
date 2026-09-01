import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import { resolveBusinessToday } from "../../src/lib/dates";

// Tables in dependency order isn't needed — one TRUNCATE ... CASCADE with
// RESTART IDENTITY resets both rows and the id sequences, so tests can assert
// on predictable ids and never leak state into the next file.
const TABLES = [
  "ApiRateLimit",
  "CategoryStatistics",
  "RecurringSchedule",
  "RecurringPattern",
  "AnalysisJob",
  "AnomalyFinding",
  "AIInteraction",
  "ChatMessage",
  "Conversation",
  "Notification",
  "CSVImportBatch",
  "ReceiptScan",
  "SalesReferenceRecord",
  "ReductionOpportunityFeedback",
  "ExpenseRecord",
  "ExpenseCategory",
  "RecoveryPlan",
  "RecoveryNotificationTriggerState",
  "RecoveryNotificationPreference",
  "BusinessOperatingDayOverride",
  "BusinessOperatingDay",
  "BusinessProfile",
  "User",
];

export async function resetDb() {
  const list = TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

export async function disconnectDb() {
  await prisma.$disconnect();
}

/**
 * Waits for a receipt scan's background read to finish.
 *
 * uploadAndScan returns as soon as the photographs are stored, leaving OCR,
 * the vision rescue and the categoriser running behind the response — so a
 * test that asserted on extracted fields immediately would be racing work
 * that had not happened yet.
 *
 * POLLS rather than awaiting the background promise directly, deliberately:
 * that is exactly what both clients do, so a test using this exercises the
 * real upload-then-poll contract instead of reaching through it into an
 * internal handle no client has. It also means these tests would catch a
 * scan that never reaches a terminal state at all, which awaiting an internal
 * promise would quietly hide.
 *
 * Returns the terminal status so a caller can assert on "Failed" as easily as
 * on "Complete"; throws only if neither is reached, which is a real bug
 * rather than slowness — the work is fully mocked in these suites.
 */
export async function waitForScanProcessing(scanId: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scan = await prisma.receiptScan.findUnique({
      where: { id: scanId },
      select: { processingStatus: true },
    });
    if (scan && scan.processingStatus !== "Processing") return scan.processingStatus;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Scan ${scanId} never left "Processing" within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------
// Factories
// ---------------------------------------------------------------
// Written against Prisma directly rather than through the services, so a test
// can set up arbitrary state (including states the API wouldn't normally
// produce) without the setup itself depending on the code under test.

export async function makeUser(overrides: { email?: string } = {}) {
  const email = overrides.email ?? `test-${randomUUID()}@example.com`;
  return prisma.user.create({
    data: {
      authId: randomUUID(),
      firstName: "Test",
      lastName: "Owner",
      email,
    },
  });
}

export interface ProfileOverrides {
  name?: string;
  availableFunds?: number;
  expectedMonthlyExpenses?: number;
  operatingDays?: number;
  largeExpenseThresholdPercent?: number;
  /** IANA timezone identifier. Omitted means the schema default ("Asia/Manila"). */
  timezone?: string;
}

export async function makeProfile(userId: number, overrides: ProfileOverrides = {}) {
  return prisma.businessProfile.create({
    data: {
      userId,
      name: overrides.name ?? "Test Store",
      type: "Sari-Sari Store",
      availableFunds: new Prisma.Decimal(overrides.availableFunds ?? 48500),
      expectedMonthlyExpenses: new Prisma.Decimal(overrides.expectedMonthlyExpenses ?? 125000),
      operatingDays: overrides.operatingDays ?? 25,
      largeExpenseThresholdPercent: new Prisma.Decimal(overrides.largeExpenseThresholdPercent ?? 25),
      ...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {}),
    },
  });
}

export async function makeCategory(businessProfileId: number, name: string) {
  return prisma.expenseCategory.create({ data: { businessProfileId, name } });
}

/** A whole owner + profile + categories in one call, for the common case. */
export async function makeOwnerWithProfile(
  profileOverrides: ProfileOverrides = {},
  categoryNames: string[] = ["Inventory", "Utilities"]
) {
  const user = await makeUser();
  const profile = await makeProfile(user.id, profileOverrides);
  const categories: Record<string, number> = {};
  for (const name of categoryNames) {
    categories[name] = (await makeCategory(profile.id, name)).id;
  }
  return { user, profile, categories };
}

// ---------------------------------------------------------------
// Dates
// ---------------------------------------------------------------
// Record dates are date-only values stored at UTC midnight. Test helpers must
// build them the same way — using local-time getters here is the exact bug that
// was found hiding today's records from the dashboard.

export function utcDay(offsetDays = 0): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

/** "YYYY-MM-DD" for a day offset from today, as the API accepts. */
export function utcDayString(offsetDays = 0): string {
  return utcDay(offsetDays).toISOString().slice(0, 10);
}

/**
 * The `utcDay`/`utcDayString` offset that lands on `daysAgo` days before the
 * BUSINESS's own current calendar day (`resolveBusinessToday`), not the
 * server's raw UTC day.
 *
 * WHY THIS EXISTS ALONGSIDE utcDay. `utcDay`/`utcDayString` are deliberately
 * server-UTC-based (see this file's own header) and that is correct for most
 * tests, which only compare a record's date against a query window anchored
 * to the SAME clock. It stops being correct the moment a test's expectation
 * is instead phrased in terms of "the business's current month/day" — which
 * is how insights.service.ts itself resolves "today" (resolveBusinessToday)
 * for recovery-target logic. The default test profile's timezone is
 * Asia/Manila (UTC+8), which is on its NEXT calendar day for roughly
 * 16:00-23:59 UTC — a test asserting against a hardcoded total for "this
 * month" during that window, using a UTC-anchored date, silently lands the
 * seeded record in the wrong month from the business's point of view.
 */
export function businessDayOffset(timezone: string, daysAgo = 0): number {
  const businessDay = resolveBusinessToday(timezone);
  businessDay.setUTCDate(businessDay.getUTCDate() - daysAgo);
  return Math.round((businessDay.getTime() - utcDay(0).getTime()) / 86_400_000);
}
