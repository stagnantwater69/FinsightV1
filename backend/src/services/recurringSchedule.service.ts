import { AnomalyFindingStatus, Prisma, RecurringPatternStatus } from "@prisma/client";
import type { RecurringSchedule } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { utcAddDays, utcToday } from "../lib/dates";
import { DUE_SOON_LEAD_DAYS, RECURRING_VERSION } from "./anomalyDetection/recurring.service";
import { RUNTIME_DETECTION_CONFIG } from "./anomalyDetection/config";
import { NOTIFICATION_TYPES } from "./notification.service";

/*
 * Owner CRUD over RecurringSchedule — deliberately NOT under
 * services/anomalyDetection/. A schedule is the owner's declaration ("I told
 * FinSight this repeats"); the detector only reads it and, at most, records
 * progress against it. Keeping the two in separate modules is what stops the
 * next edit to the detector from quietly acquiring the ability to overwrite
 * owner input, which is the defect the two-table split exists to prevent.
 */

/**
 * The one gate on the whole owner-facing half of recurring schedules.
 *
 * WHY IT EXISTS. `refreshRecurringPatterns` returns early when
 * `featureFlags.recurring` is off, and that function is the only thing that ever
 * advances a schedule's `nextDueDate`. With the flag off but the CRUD live, an
 * owner can declare schedules through a fully working UI whose due dates never
 * move: every schedule slides permanently into OVERDUE no matter how faithfully
 * the bill is paid, and the agenda shows a wall of red to a shop doing
 * everything right. Half-dark is worse than dark. The flag now decides the whole
 * feature, detector and CRUD together.
 *
 * WHY HERE, in the service, rather than in the controller. Every route into this
 * data goes through one of the exported functions below, so calling this on the
 * first line of each of them means a sixth endpoint added later inherits the
 * gate by construction instead of by someone remembering. `insights.routes.ts`
 * mounts it a second time as a router-level guard — not a duplicate rule (it
 * calls this same function), but an earlier one: the controller parses the body
 * before it reaches the service, so without the route-level mount a probe
 * sending an invalid body to a dark endpoint would get `400 Validation failed`
 * and learn the endpoint exists.
 *
 * WHY 404, and not 503 or a `featureDisabled` body. A disabled endpoint should
 * be indistinguishable from one that was never deployed. That is the same stance
 * `lib/ownership.ts` takes for another owner's rows — 404, never 403, because
 * "not yours" and "not there" must read identically from outside. A 503 or a
 * named flag error advertises an unshipped feature to anyone probing the API and
 * invites clients to special-case it. The message is deliberately the generic
 * "Not found" rather than "Recurring schedule not found": a resource-specific
 * phrase is the tell that the resource exists.
 *
 * Reads `RUNTIME_DETECTION_CONFIG`, never `env.ANOMALY_RECURRING_ENABLED`
 * directly, so the detector and the CRUD cannot disagree about what the flag
 * says. Read at call time, not captured at module load, so the value is whatever
 * the config module currently exposes.
 */
export function assertRecurringSchedulesEnabled(): void {
  if (!RUNTIME_DETECTION_CONFIG.featureFlags.recurring) {
    throw new ApiError(404, "Not found");
  }
}

interface CreateInput {
  businessProfileId: number;
  categoryId: number;
  label: string;
  vendor?: string;
  intervalDays: number;
  expectedAmount: number;
  amountTolerance?: number;
  /** YYYY-MM-DD. */
  nextDueDate: string;
  isActive?: boolean;
}

interface UpdateInput {
  categoryId?: number;
  label?: string;
  vendor?: string | null;
  intervalDays?: number;
  expectedAmount?: number;
  amountTolerance?: number;
  /** YYYY-MM-DD. */
  nextDueDate?: string;
  isActive?: boolean;
}

/**
 * Where a schedule sits relative to today.
 *
 * COMPUTED HERE, NOT ON THE CLIENTS. Web and mobile both render the agenda
 * grouped by this, and two independent implementations of "is it due soon"
 * drift the moment one of them is edited — an owner would then see a bill in
 * "Due this week" on the phone and in "Later" on the laptop. One rule, one
 * place, shipped in the payload.
 */
export type DueState = "OVERDUE" | "DUE_SOON" | "SCHEDULED";

/**
 * Deliberately expressed with the same comparison the detector's
 * `recurring-due-soon` finding uses (recurring.service.ts), importing its lead
 * time rather than restating 3: the row an owner sees badged "due soon" and the
 * row that raises the notification must be the same row.
 */
export function dueStateOf(nextDueDate: Date, today = utcToday()): DueState {
  if (today > nextDueDate) return "OVERDUE";
  if (today >= utcAddDays(nextDueDate, -DUE_SOON_LEAD_DAYS)) return "DUE_SOON";
  return "SCHEDULED";
}

type ScheduleRow = RecurringSchedule & { category?: { name: string } };

/**
 * Whitelists the fields the clients may see and — the part that is easy to
 * forget — turns the two Decimal columns into numbers. Returned raw, a
 * Prisma.Decimal serializes as an object, so `expectedAmount` arrives as
 * `{ s, e, d }` and every money component downstream renders NaN.
 */
function toDTO(row: ScheduleRow, today = utcToday()) {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    categoryId: row.categoryId,
    categoryName: row.category?.name,
    label: row.label,
    vendor: row.vendor,
    intervalDays: row.intervalDays,
    expectedAmount: Number(row.expectedAmount),
    amountTolerance: Number(row.amountTolerance),
    nextDueDate: row.nextDueDate,
    lastRecordedDate: row.lastRecordedDate,
    isActive: row.isActive,
    sourcePatternId: row.sourcePatternId,
    dueState: dueStateOf(row.nextDueDate, today),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// 400 rather than 404: the caller has already proved it owns the profile, so
// this is a bad request, not a hidden row. Mirrors expenseRecord.service.ts.
async function verifyCategoryBelongsToProfile(categoryId: number, businessProfileId: number) {
  const category = await prisma.expenseCategory.findFirst({ where: { id: categoryId, businessProfileId } });
  if (!category) {
    throw new ApiError(400, "Category does not belong to this business profile");
  }
}

/**
 * `amountTolerance` is a fraction, constrained by the database to 0..1.
 *
 * The clamp matters on the pattern-confirm path: `inferRecurringPattern`
 * computes `Math.max(0.15, median(deviations) * 2)`, which has no upper bound,
 * and RecurringPattern carries no CHECK to catch it. Copying such a value
 * straight across would fail the schedule's CHECK as a 500 on exactly the rows
 * the constraint exists for. The migration's backfill clamps with LEAST(...,1)
 * for the same reason.
 */
function clampTolerance(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Writes that retire everything the watchdog raised about a schedule the owner
 * has just stopped watching (paused or deleted).
 *
 * THIS HAS TO LIVE ON THE CRUD SIDE. `runScheduleWatchdog` only ever selects
 * `isActive: true` schedules, and every SUPERSEDED write it performs is inside
 * that loop — so the moment a schedule stops being active it becomes
 * unreachable by the only code that could ever close its findings, and a HIGH
 * `recurring-missing` finding plus its unread notification stay in front of the
 * owner forever. Deletion is worse still: `recurringScheduleId` lives only in
 * the finding's metadata JSON, with no FK and therefore no cascade, so the rows
 * outlive the schedule with nothing left to point back at. Both clients promise
 * the opposite ("the schedule stays, FinSight just stops telling you when it's
 * late"), so the promise is kept here, at the transition, not by the detector.
 *
 * Returned as unexecuted Prisma promises so the caller can run them in the SAME
 * transaction as the pause/delete: a schedule that is inactive while its alarm
 * is still open is exactly the state this exists to prevent.
 *
 * Findings are matched on the fingerprint prefixes the detector builds
 * (`<version>:missing:<id>:` / `<version>:due-soon:<id>:`) rather than on the
 * metadata JSON, because those prefixes are what the detector's own supersede
 * writes already key on. Only the two absence-reporting methods are retired —
 * `recurring-amount-change` and `recurring-repeated` hang off a real expense
 * record that still exists and is still worth reading.
 */
function retireScheduleWatchWrites(schedule: Pick<RecurringSchedule, "id" | "businessProfileId" | "label">) {
  return [
    prisma.anomalyFinding.updateMany({
      where: {
        businessProfileId: schedule.businessProfileId,
        status: AnomalyFindingStatus.OPEN,
        OR: [
          { fingerprint: { startsWith: `${RECURRING_VERSION}:missing:${schedule.id}:` } },
          { fingerprint: { startsWith: `${RECURRING_VERSION}:due-soon:${schedule.id}:` } },
        ],
      },
      data: { status: AnomalyFindingStatus.SUPERSEDED },
    }),
    // Marked read, never deleted: the (businessProfileId, type, message) row is
    // what stops notifyScheduleFinding pushing the same due date twice, so
    // removing it would re-nag the owner if they resume the schedule. Matched on
    // the two message shapes the detector emits for this label, since a
    // notification carries no schedule reference at all.
    prisma.notification.updateMany({
      where: {
        businessProfileId: schedule.businessProfileId,
        type: NOTIFICATION_TYPES.RECURRING_SCHEDULE,
        readStatus: false,
        OR: [
          { message: { startsWith: `${schedule.label} is due ` } },
          { message: { startsWith: `${schedule.label} was due ` } },
        ],
      },
      data: { readStatus: true },
    }),
  ];
}

export async function listRecurringSchedules(userId: number, businessProfileId: number) {
  // Refuses rather than returning []: an empty agenda is indistinguishable from
  // "you have no schedules", which is a lie of a different kind.
  assertRecurringSchedulesEnabled();
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const today = utcToday();
  const rows = await prisma.recurringSchedule.findMany({
    where: { businessProfileId },
    include: { category: { select: { name: true } } },
    // Paused schedules last, then soonest-due first: the agenda's reading order.
    orderBy: [{ isActive: "desc" }, { nextDueDate: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => toDTO(row, today));
}

export async function createRecurringSchedule(userId: number, input: CreateInput) {
  assertRecurringSchedulesEnabled();
  await requireOwnedBusinessProfile(userId, input.businessProfileId);
  await verifyCategoryBelongsToProfile(input.categoryId, input.businessProfileId);

  const row = await prisma.recurringSchedule.create({
    data: {
      businessProfileId: input.businessProfileId,
      categoryId: input.categoryId,
      label: input.label,
      vendor: input.vendor,
      intervalDays: input.intervalDays,
      expectedAmount: new Prisma.Decimal(input.expectedAmount),
      amountTolerance:
        input.amountTolerance === undefined ? undefined : new Prisma.Decimal(clampTolerance(input.amountTolerance)),
      nextDueDate: new Date(input.nextDueDate),
      isActive: input.isActive,
    },
    include: { category: { select: { name: true } } },
  });
  return toDTO(row);
}

export async function updateRecurringSchedule(userId: number, id: number, input: UpdateInput) {
  assertRecurringSchedulesEnabled();
  // Scoped lookup, never a separate ownership query and never a 403: another
  // owner's schedule must be indistinguishable from one that does not exist.
  const existing = await prisma.recurringSchedule.findFirst({ where: { id, businessProfile: { userId } } });
  if (!existing) {
    throw new ApiError(404, "Recurring schedule not found");
  }

  if (input.categoryId !== undefined) {
    await verifyCategoryBelongsToProfile(input.categoryId, existing.businessProfileId);
  }

  // Pausing is the owner saying "stop telling me about this". Anything the
  // watchdog already raised is retired in the same transaction, because once
  // isActive flips the detector can no longer reach those rows. Keyed on the
  // resulting state rather than on the true->false edge so that re-pausing an
  // already-paused schedule also clears anything left over from before this fix.
  // `existing.label` (not `input.label`) matches the notifications, which were
  // written under the label in force when they were raised.
  const update = prisma.recurringSchedule.update({
    where: { id: existing.id },
    data: {
      categoryId: input.categoryId,
      label: input.label,
      vendor: input.vendor,
      intervalDays: input.intervalDays,
      expectedAmount: input.expectedAmount === undefined ? undefined : new Prisma.Decimal(input.expectedAmount),
      amountTolerance:
        input.amountTolerance === undefined ? undefined : new Prisma.Decimal(clampTolerance(input.amountTolerance)),
      nextDueDate: input.nextDueDate === undefined ? undefined : new Date(input.nextDueDate),
      isActive: input.isActive,
    },
    include: { category: { select: { name: true } } },
  });

  if (input.isActive === false) {
    const [row] = await prisma.$transaction([update, ...retireScheduleWatchWrites(existing)]);
    return toDTO(row);
  }
  return toDTO(await update);
}

export async function deleteRecurringSchedule(userId: number, id: number) {
  assertRecurringSchedulesEnabled();
  const existing = await prisma.recurringSchedule.findFirst({ where: { id, businessProfile: { userId } } });
  if (!existing) {
    throw new ApiError(404, "Recurring schedule not found");
  }
  // Retire BEFORE the row goes: nothing references a schedule id once the row is
  // gone (the id lives only in fingerprints and metadata JSON), so a finding
  // left open here can never be closed by anything, ever.
  await prisma.$transaction([...retireScheduleWatchWrites(existing), prisma.recurringSchedule.delete({ where: { id: existing.id } })]);
}

/**
 * Promotes a detector candidate into an owner-owned schedule.
 *
 * ONE TRANSACTION for both writes: a schedule without its pattern marked
 * CONFIRMED would be re-offered as a candidate on the next screen load, and a
 * CONFIRMED pattern without a schedule is precisely the invisible row this
 * whole feature exists to eliminate. Neither half is useful alone.
 *
 * `label` is seeded from `pattern.description` on purpose — the watchdog
 * matches expense records to schedules on categoryId + vendor + label, so
 * copying the description (which is what the pattern was inferred from) makes
 * the new schedule match its own records by construction. It is free for the
 * owner to rename afterwards; matching is then their business.
 */
export async function confirmRecurringPattern(userId: number, patternId: number) {
  assertRecurringSchedulesEnabled();
  const pattern = await prisma.recurringPattern.findFirst({
    where: { id: patternId, businessProfile: { userId } },
    include: { derivedSchedule: { select: { id: true } } },
  });
  if (!pattern) {
    throw new ApiError(404, "Recurring pattern not found");
  }
  if (pattern.derivedSchedule) {
    throw new ApiError(409, "This pattern already has a schedule");
  }

  // RecurringSchedule has CHECK (expectedAmount > 0); RecurringPattern has no
  // such constraint. Caught here so a degenerate inference is a clear 400
  // instead of a constraint violation surfacing as a 500.
  const expectedAmount = Number(pattern.expectedAmount);
  if (!(expectedAmount > 0)) {
    throw new ApiError(400, "This pattern's expected amount is not a positive amount, so it cannot be scheduled");
  }

  const [schedule] = await prisma.$transaction([
    prisma.recurringSchedule.create({
      data: {
        businessProfileId: pattern.businessProfileId,
        categoryId: pattern.categoryId,
        label: pattern.description,
        vendor: pattern.vendor,
        intervalDays: pattern.intervalDays,
        expectedAmount: pattern.expectedAmount,
        amountTolerance: new Prisma.Decimal(clampTolerance(Number(pattern.amountTolerance))),
        nextDueDate: pattern.nextExpectedDate,
        sourcePatternId: pattern.id,
      },
      include: { category: { select: { name: true } } },
    }),
    prisma.recurringPattern.update({
      where: { id: pattern.id },
      data: { status: RecurringPatternStatus.CONFIRMED },
    }),
  ]);

  return toDTO(schedule);
}
