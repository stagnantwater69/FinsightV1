import { createHash } from "node:crypto";
import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType, Prisma, RecurringPatternStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay, utcStartOfDay, utcToday } from "../../lib/dates";
import { ApiError } from "../../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { saveFinding } from "./finding.service";
import { normalizeComparisonText } from "./nearDuplicate.service";
import { meetsNotificationSeverity } from "./config";
import { NOTIFICATION_TYPES } from "../notification.service";
import type { DetectionConfig } from "./config";

export const RECURRING_VERSION = "recurring-v1";
const MINIMUM_OBSERVATIONS = 3;
const MINIMUM_CONFIDENCE = 0.7;

/**
 * How many days before an owner-declared schedule's `nextDueDate` the
 * forward-looking `recurring-due-soon` finding starts firing.
 *
 * Every other recurring finding is retrospective: it can only speak up after
 * the grace period, i.e. after the owner has already forgotten. This lead time
 * is the only part of the detector that can prevent the miss rather than
 * report it. Fixed rather than proportional to `intervalDays` to start — a
 * weekly and a monthly bill both need about the same "act on this now" window,
 * and a proportional lead would make quarterly schedules shout 12 days early.
 * Owner-configurable lead time is deliberately deferred (plan open question 2).
 *
 * EXPORTED so recurringSchedule.service.ts's `dueState` can import it instead
 * of restating 3: the row an owner sees badged "due soon" in the agenda and the
 * row that raises this finding have to be the same row.
 */
export const DUE_SOON_LEAD_DAYS = 3;

/**
 * Ceiling on how many cycles one pass will advance a stale schedule.
 *
 * Past the cap the schedule is realigned to the record itself
 * (`record + intervalDays`) instead of staying on its original due-date grid.
 * That trades grid fidelity — a 5-year-dormant daily schedule loses its "due on
 * the 3rd" alignment — for the guarantee that `nextDueDate` always ends up
 * ahead of `lastRecordedDate`. See `advancedDueDate` for why that invariant is
 * not negotiable.
 *
 * 120 is far above any realistic gap (10 years of monthly, 2 years of weekly)
 * and far below anything expensive, since the advance is arithmetic rather than
 * iterative and cannot spin regardless.
 */
const MAX_CATCH_UP_CYCLES = 120;

/**
 * Where a schedule's `nextDueDate` lands once `record` is counted against it:
 * the first grid date strictly after the record.
 *
 * MUST stay ahead of the record. `lastRecordedDate` jumps to the newest matching
 * record, and the next pass only considers records dated after it, so a
 * `nextDueDate` left behind that date can never be satisfied again — the
 * schedule deadlocks and reports a bill the owner *did* record as missing, at
 * HIGH severity with a push, forever. Advancing by a single interval (the
 * original implementation) did exactly that to any schedule more than one cycle
 * behind, which is ordinary: the watchdog only runs on PROFILE_REFRESH, so a
 * profile untouched for two months of a monthly bill lands there.
 *
 * Computed arithmetically rather than in a loop so a years-stale schedule costs
 * one multiplication, not thousands of iterations.
 */
export function advancedDueDate(nextDueDate: Date, intervalDays: number, recordDate: Date) {
  if (recordDate < nextDueDate) return utcAddDays(nextDueDate, intervalDays);
  const cycles = Math.floor(daysBetween(nextDueDate, recordDate) / intervalDays) + 1;
  if (cycles > MAX_CATCH_UP_CYCLES) return utcAddDays(recordDate, intervalDays);
  return utcAddDays(nextDueDate, cycles * intervalDays);
}

/**
 * Identity used to line an owner's schedule up with the expense records that
 * satisfy it: same category, same vendor, same text. Normalized with the one
 * shared normalizer so "Power Co." and "power co" are the same payment.
 *
 * This is also the pre-image `recurringKey` hashes, so a schedule and the
 * pattern inferred from the same records group identically — but the hash is
 * only ever persisted for a PATTERN, derived from expense RECORDS. It is never
 * recomputed from owner-edited schedule text, which would orphan the stored
 * pattern row and make the next pass create a duplicate.
 */
function comparisonIdentity(categoryId: number, vendor: string | null, text: string) {
  return `${categoryId}|${normalizeComparisonText(vendor)}|${normalizeComparisonText(text)}`;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

/**
 * "today" / "tomorrow" / "in 3 days", for the FINDING's reason text only.
 *
 * Deliberately NOT used in the notification message — see notifyScheduleFinding.
 * A finding is read in context in the Expense Insight list, where a relative
 * phrase is more useful than a bare date; a notification must be a stable
 * string so it collapses to one per cycle.
 */
function relativeDuePhrase(daysUntilDue: number) {
  if (daysUntilDue <= 0) return "today";
  if (daysUntilDue === 1) return "tomorrow";
  return `in ${daysUntilDue} days`;
}

/**
 * Deliver a schedule warning to the owner's notification list.
 *
 * DELIBERATELY NARROW: this fires only for `recurring-missing` and
 * `recurring-due-soon`. It is NOT a general "notify on any HIGH finding raised
 * during a PROFILE_REFRESH job" rule, and must not be generalised into one
 * casually. The TRANSACTION path is naturally bounded — one job, one record, at
 * most a handful of findings. PROFILE_REFRESH re-examines a profile's entire
 * history in a single pass, so a blanket rule would mean that the day an
 * operator enables `trends` or `behavioralNovelty` the owner is buried under a
 * burst of notifications about months-old back-history. Widening this later is
 * a decision that needs a notification-volume review; it is not a tidy-up.
 *
 * `recurring-amount-change` and `recurring-repeated` are deliberately excluded,
 * and NOT because of their severity — `recurring-repeated` is always HIGH and
 * `recurring-amount-change` is HIGH above a 50% deviation, so both would clear
 * the default gate. They are excluded because they are informational and
 * record-attached: the expense they describe is already in the ledger and the
 * finding hangs off it, so the owner meets it in the Expense Insight list with
 * the record in front of them and has nothing to do about it right now. The
 * two methods that DO notify are the opposite — they report the ABSENCE of a
 * record, which the owner cannot discover by looking at their own list, and
 * which is only actionable before the bill is late. So do not re-derive this
 * exclusion from `notificationMinimumSeverity`: raising or lowering a severity
 * here must not change who gets pushed.
 */
async function notifyScheduleFinding(userId: number, businessProfileId: number, message: string) {
  // The TRANSACTION path dedupes on (businessProfileId, expenseRecordId, type,
  // message). A schedule warning has no expense record — the whole point is
  // that no record exists — so the tuple drops to (businessProfileId, type,
  // message). The message embeds the schedule label and its due date, so it is
  // as specific as the finding's own fingerprint, and a re-run of the same
  // detector pass produces a byte-identical string rather than a duplicate.
  //
  // BOTH messages must use the ABSOLUTE due date, never `relativeDuePhrase`.
  // A relative string ("in 2 days" / "tomorrow" / "today") changes once a day,
  // which would defeat this dedupe and produce up to DUE_SOON_LEAD_DAYS pushes
  // for a single due date. One reminder does the job of not letting the owner
  // forget; three is nagging. At the 3-6 schedules a small business typically
  // keeps, per-day reminders would put ~15 notifications a month into a list
  // shared with duplicate, large-expense and needs-review alerts, and recurring
  // should not dominate it. Nothing is hidden by collapsing: the due-soon
  // FINDING stays open in the Expense Insight list for the whole lead window,
  // and there is already a natural escalation that repeats nothing — one
  // due-soon push before the date, one recurring-missing push after the grace
  // period, each saying something new. Adding escalation later with evidence
  // that one reminder was not enough is easy; removing it after owners complain
  // about noise is the worse path. So: do not "unify" the notification string
  // with the finding's reason text.
  const existing = await prisma.notification.findFirst({
    where: { businessProfileId, type: NOTIFICATION_TYPES.RECURRING_SCHEDULE, message },
    select: { id: true },
  });
  if (existing) return;
  await prisma.notification.create({
    data: { userId, businessProfileId, type: NOTIFICATION_TYPES.RECURRING_SCHEDULE, message },
  });
}

interface RecurringRecord {
  id: number;
  categoryId: number;
  vendor: string | null;
  description: string;
  amount: number;
  date: Date;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function daysBetween(left: Date, right: Date) {
  return Math.round(Math.abs(right.getTime() - left.getTime()) / 86_400_000);
}

export function recurringKey(record: Pick<RecurringRecord, "categoryId" | "vendor" | "description">) {
  return createHash("sha256").update(comparisonIdentity(record.categoryId, record.vendor, record.description)).digest("hex");
}

export function inferRecurringPattern(records: RecurringRecord[]) {
  if (records.length < MINIMUM_OBSERVATIONS) return null;
  const sorted = [...records].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  const intervals = sorted.slice(1).map((record, index) => daysBetween(sorted[index]!.date, record.date));
  const intervalDays = Math.round(median(intervals));
  const recognized = (intervalDays >= 5 && intervalDays <= 9)
    || (intervalDays >= 25 && intervalDays <= 35)
    || (intervalDays >= 80 && intervalDays <= 100);
  if (!recognized) return null;

  const intervalTolerance = Math.max(2, intervalDays * 0.2);
  const intervalConfidence = intervals.filter((value) => Math.abs(value - intervalDays) <= intervalTolerance).length / intervals.length;
  const amounts = sorted.map((record) => record.amount);
  const expectedAmount = median(amounts);
  const deviations = amounts.map((amount) => Math.abs(amount - expectedAmount) / Math.max(Math.abs(expectedAmount), 1));
  const amountTolerance = Math.max(0.15, median(deviations) * 2);
  const amountConfidence = deviations.filter((value) => value <= amountTolerance).length / deviations.length;
  const confidence = (intervalConfidence + amountConfidence) / 2;
  if (confidence < MINIMUM_CONFIDENCE) return null;

  const latest = sorted.at(-1)!;
  return {
    sorted,
    intervalDays,
    expectedAmount,
    amountTolerance,
    confidence,
    lastOccurrence: latest.date,
    nextExpectedDate: utcAddDays(latest.date, intervalDays),
  };
}

export async function refreshRecurringPatterns(userId: number, businessProfileId: number, config: DetectionConfig, today = utcToday()) {
  if (!config.featureFlags.recurring) return [];
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const rows = await prisma.expenseRecord.findMany({
    where: { businessProfileId, date: { gte: utcAddDays(today, -730), lte: utcEndOfDay(today) } },
    select: { id: true, categoryId: true, vendor: true, description: true, amount: true, date: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 10_000,
  });
  const groups = new Map<string, RecurringRecord[]>();
  // Same records, keyed by the un-hashed identity, so an owner's schedule can
  // be matched to its records without ever hashing owner-edited text.
  const byIdentity = new Map<string, RecurringRecord[]>();
  for (const row of rows) {
    const record = { ...row, amount: Number(row.amount) };
    const key = recurringKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
    const identity = comparisonIdentity(record.categoryId, record.vendor, record.description);
    const matches = byIdentity.get(identity) ?? [];
    matches.push(record);
    byIdentity.set(identity, matches);
  }

  const patterns = [];
  for (const [normalizedKey, records] of groups) {
    const inferred = inferRecurringPattern(records);
    if (!inferred) continue;
    const latest = inferred.sorted.at(-1)!;
    patterns.push(await prisma.recurringPattern.upsert({
      where: { businessProfileId_normalizedKey: { businessProfileId, normalizedKey } },
      create: {
        businessProfileId, categoryId: latest.categoryId, normalizedKey,
        vendor: latest.vendor, description: latest.description,
        intervalDays: inferred.intervalDays,
        expectedAmount: new Prisma.Decimal(inferred.expectedAmount),
        amountTolerance: new Prisma.Decimal(inferred.amountTolerance),
        confidence: new Prisma.Decimal(inferred.confidence),
        observationCount: records.length,
        lastOccurrence: inferred.lastOccurrence,
        nextExpectedDate: inferred.nextExpectedDate,
      },
      update: {
        categoryId: latest.categoryId, vendor: latest.vendor, description: latest.description,
        intervalDays: inferred.intervalDays,
        expectedAmount: new Prisma.Decimal(inferred.expectedAmount),
        amountTolerance: new Prisma.Decimal(inferred.amountTolerance),
        confidence: new Prisma.Decimal(inferred.confidence),
        observationCount: records.length,
        lastOccurrence: inferred.lastOccurrence,
        nextExpectedDate: inferred.nextExpectedDate,
      },
    }));
  }

  await runScheduleWatchdog(userId, businessProfileId, byIdentity, config, today);
  return patterns;
}

/**
 * The watchdog watches the owner's DECLARATIONS (`RecurringSchedule`), not the
 * detector's own inferences (`RecurringPattern`).
 *
 * It used to loop over CONFIRMED patterns, which meant the thing being watched
 * was also the thing the detector rewrote on every pass — an owner could not
 * correct an amount or a date without it silently reverting. A schedule is
 * owner-owned; the detector reads it and, at most, records progress against it.
 */
async function runScheduleWatchdog(
  userId: number,
  businessProfileId: number,
  byIdentity: Map<string, RecurringRecord[]>,
  config: DetectionConfig,
  today: Date,
) {
  const schedules = await prisma.recurringSchedule.findMany({
    where: { businessProfileId, isActive: true },
    orderBy: [{ nextDueDate: "asc" }, { id: "asc" }],
  });

  for (const schedule of schedules) {
    const intervalDays = schedule.intervalDays;
    const expectedAmount = Number(schedule.expectedAmount);
    const records = byIdentity.get(comparisonIdentity(schedule.categoryId, schedule.vendor, schedule.label)) ?? [];

    const missingPrefix = `${RECURRING_VERSION}:missing:${schedule.id}:`;
    const dueSoonPrefix = `${RECURRING_VERSION}:due-soon:${schedule.id}:`;
    const dueKey = dateKey(schedule.nextDueDate);

    // The current cycle opens one interval before the due date. Anything the
    // detector has already counted (`lastRecordedDate`) is excluded so a single
    // payment can never advance the schedule twice across re-runs.
    const cycleStart = utcAddDays(schedule.nextDueDate, -intervalDays);
    // THIRD FLOOR — the declaration itself. A record the owner already had on
    // file when they wrote the schedule down is not evidence for a cycle they
    // declared AFTERWARDS. Without it, the first pass over a brand-new schedule
    // adopts the PREVIOUS cycle's payment as this cycle's: `lastRecordedDate`
    // is legitimately null on a fresh owner-declared row, so `cycleStart` is
    // the only floor, and a monthly bill recorded three weeks before the owner
    // declared it sits inside that window. The schedule then jumps a full
    // interval ahead on that record's back, and the very first declared cycle
    // gets neither the forward-looking due-soon warning nor the retrospective
    // missing one — the manual-declare cold start, which is the flow this
    // feature exists for, goes unwatched for one whole interval.
    //
    // DELIBERATELY scoped to schedules whose due date falls ON OR AFTER the day
    // they were declared, which is the shape that defect takes. A BACKDATED
    // declaration (`nextDueDate` strictly BEFORE the declaration day) is the
    // catch-up case, and there the records already on file are exactly what
    // legitimately satisfies those past cycles; flooring it would strand the
    // schedule on a due date it can never clear and report bills the owner DID
    // record as missing. Compared on the declaration's UTC day, since record
    // dates are date-only and `createdAt` is a timestamp.
    //
    // The boundary is `>=`, not `>` (P2 fix): a schedule declared due TODAY is a
    // fresh declaration, not a catch-up. It is also the shape the web form hands
    // out by default (`RecurringScheduleForm` seeds `nextDueDate` with today), so
    // at `>` the single most common declaration in the product selected catch-up
    // semantics and adopted the PREVIOUS cycle's record — the exact cold-start
    // defect this floor exists to stop, one day off its boundary. A record dated
    // before the declaration day still cannot satisfy a cycle declared for that
    // same day, which is what the floor means.
    const declaredOn = utcStartOfDay(schedule.createdAt);
    const declarationFloor = schedule.nextDueDate >= declaredOn ? declaredOn : null;
    const countedThrough = [schedule.lastRecordedDate, declarationFloor].reduce<Date>(
      (latest, candidate) => (candidate && candidate > latest ? candidate : latest),
      cycleStart,
    );
    const cycleRecord = records.filter((record) => record.date > countedThrough).at(-1) ?? null;

    if (cycleRecord) {
      // WRITE SITE — `lastRecordedDate` and `nextDueDate` are the ONLY two
      // fields the detector may ever write on a RecurringSchedule, and
      // `nextDueDate` only by adding `intervalDays`. `label`, `vendor`,
      // `categoryId`, `intervalDays`, `expectedAmount`, `amountTolerance` and
      // `isActive` are owner-set. Writing any of them here would silently
      // revert the owner's edit on the next pass — the exact defect the
      // two-table split exists to eliminate. Do not add fields to this update.
      await prisma.recurringSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRecordedDate: cycleRecord.date,
          // Must clear the record, not just step once — see advancedDueDate.
          nextDueDate: advancedDueDate(schedule.nextDueDate, intervalDays, cycleRecord.date),
        },
      });
      // The payment landed, so neither warning still stands.
      await prisma.anomalyFinding.updateMany({
        where: {
          businessProfileId,
          OR: [{ fingerprint: { startsWith: missingPrefix } }, { fingerprint: { startsWith: dueSoonPrefix } }],
          status: AnomalyFindingStatus.OPEN,
        },
        data: { status: AnomalyFindingStatus.SUPERSEDED },
      });
    } else {
      const graceDays = Math.max(2, Math.ceil(intervalDays * 0.15));
      const overdueAfter = utcAddDays(schedule.nextDueDate, graceDays);
      const dueSoonFrom = utcAddDays(schedule.nextDueDate, -DUE_SOON_LEAD_DAYS);

      if (today > overdueAfter) {
        const fingerprint = `${missingPrefix}${dueKey}`;
        await saveFinding({
          fingerprint, businessProfileId, type: AnomalyFindingType.RECURRING_CHANGE,
          // HIGH, not MEDIUM: the notification gate (job.service.ts) drops
          // anything below `notificationMinimumSeverity` (default HIGH), so at
          // MEDIUM this was computed and then silently discarded.
          severity: AnomalyFindingSeverity.HIGH, score: 1,
          method: "recurring-missing", title: "Expected recurring expense is missing",
          reasons: [`${schedule.label} was expected around ${dueKey}`],
          metadata: { recurringScheduleId: schedule.id, expectedAmount, intervalDays, dueDate: dueKey },
          detectorVersion: RECURRING_VERSION,
        });
        await prisma.anomalyFinding.updateMany({
          where: { businessProfileId, fingerprint: { startsWith: missingPrefix, not: fingerprint }, status: AnomalyFindingStatus.OPEN },
          data: { status: AnomalyFindingStatus.SUPERSEDED },
        });
        if (meetsNotificationSeverity(AnomalyFindingSeverity.HIGH, config)) {
          await notifyScheduleFinding(userId, businessProfileId, `${schedule.label} was due ${dueKey} and has not been recorded yet`.slice(0, 255));
        }
      } else {
        await prisma.anomalyFinding.updateMany({
          where: { businessProfileId, fingerprint: { startsWith: missingPrefix }, status: AnomalyFindingStatus.OPEN },
          data: { status: AnomalyFindingStatus.SUPERSEDED },
        });
      }

      if (today >= dueSoonFrom && today <= schedule.nextDueDate) {
        const fingerprint = `${dueSoonPrefix}${dueKey}`;
        const daysUntilDue = daysBetween(today, schedule.nextDueDate);
        await saveFinding({
          fingerprint, businessProfileId, type: AnomalyFindingType.RECURRING_CHANGE,
          // HIGH for the same reason as recurring-missing: a warning that never
          // reaches the owner is not a warning.
          severity: AnomalyFindingSeverity.HIGH, score: 1,
          method: "recurring-due-soon", title: "Recurring expense is due soon",
          reasons: [`${schedule.label} is due ${relativeDuePhrase(daysUntilDue)} (${dueKey}) and has not been recorded yet`],
          metadata: { recurringScheduleId: schedule.id, expectedAmount, intervalDays, dueDate: dueKey, daysUntilDue },
          detectorVersion: RECURRING_VERSION,
        });
        await prisma.anomalyFinding.updateMany({
          where: { businessProfileId, fingerprint: { startsWith: dueSoonPrefix, not: fingerprint }, status: AnomalyFindingStatus.OPEN },
          data: { status: AnomalyFindingStatus.SUPERSEDED },
        });
        if (meetsNotificationSeverity(AnomalyFindingSeverity.HIGH, config)) {
          await notifyScheduleFinding(userId, businessProfileId, `${schedule.label} is due ${dueKey} and has not been recorded yet`.slice(0, 255));
        }
      } else {
        await prisma.anomalyFinding.updateMany({
          where: { businessProfileId, fingerprint: { startsWith: dueSoonPrefix }, status: AnomalyFindingStatus.OPEN },
          data: { status: AnomalyFindingStatus.SUPERSEDED },
        });
      }
    }

    // SAME FLOOR AS THE CYCLE CHECK ABOVE. These two informational checks read
    // the schedule's matching records too, and must agree with the cycle half of
    // the loop about which records are evidence for THIS schedule. Reading the
    // unfiltered list meant a record the declaration floor had just refused to
    // count as satisfying a cycle was still compared against the declared amount
    // and interval: declare a schedule today and the owner is immediately told
    // that an 18-month-old expense "differs by 75% from the expected recurring
    // amount", or that two records from last year "appeared 4 days apart". Both
    // fingerprints are record-scoped and are never superseded anywhere in this
    // file, so those findings stay OPEN forever and inflate the Alerts badge.
    //
    // Only the declaration floor is applied, NOT `countedThrough`: `cycleStart`
    // and `lastRecordedDate` are about which cycle a record settles, whereas an
    // amount change or an early repeat is a property of the record itself and
    // should still be reported for a record that has already advanced the
    // schedule. A backdated declaration keeps its full history, exactly as it
    // does above — there the pre-existing records ARE the declared cycles.
    const evidence = declarationFloor ? records.filter((record) => record.date > declarationFloor) : records;
    const latest = evidence.at(-1);
    const previous = evidence.at(-2);
    if (!latest) continue;
    const deviation = Math.abs(latest.amount - expectedAmount) / Math.max(Math.abs(expectedAmount), 1);
    if (deviation > Number(schedule.amountTolerance)) {
      await saveFinding({
        fingerprint: `${RECURRING_VERSION}:amount:${schedule.id}:${latest.id}`,
        businessProfileId, expenseRecordId: latest.id, type: AnomalyFindingType.RECURRING_CHANGE,
        severity: deviation >= 0.5 ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
        score: Math.min(deviation, 1), method: "recurring-amount-change",
        title: "Recurring expense amount changed",
        reasons: [`The amount differs by ${Math.round(deviation * 100)}% from the expected recurring amount`],
        metadata: { recurringScheduleId: schedule.id, expectedAmount, actualAmount: latest.amount },
        detectorVersion: RECURRING_VERSION,
      });
    }
    if (previous && daysBetween(previous.date, latest.date) < intervalDays * 0.5) {
      await saveFinding({
        fingerprint: `${RECURRING_VERSION}:repeated:${schedule.id}:${latest.id}`,
        businessProfileId, expenseRecordId: latest.id, type: AnomalyFindingType.RECURRING_CHANGE,
        severity: AnomalyFindingSeverity.HIGH, score: 1, method: "recurring-repeated",
        title: "Recurring expense appeared earlier than expected",
        reasons: [`This expense appeared ${daysBetween(previous.date, latest.date)} days after the previous one; the usual interval is ${intervalDays} days`],
        metadata: { recurringScheduleId: schedule.id, intervalDays },
        detectorVersion: RECURRING_VERSION,
      });
    }
  }
}

export async function reviewRecurringPattern(userId: number, patternId: number, status: RecurringPatternStatus) {
  const pattern = await prisma.recurringPattern.findFirst({ where: { id: patternId, businessProfile: { userId } }, select: { id: true } });
  if (!pattern) throw new ApiError(404, "Recurring pattern not found");
  return prisma.recurringPattern.update({ where: { id: pattern.id }, data: { status } });
}

export async function listRecurringPatterns(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  return prisma.recurringPattern.findMany({
    where: { businessProfileId },
    include: { category: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { nextExpectedDate: "asc" }, { id: "asc" }],
  });
}
