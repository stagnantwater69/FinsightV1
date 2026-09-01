// Recovery Target notifications — RECOVERY-TARGET-IMPROVEMENT-PLAN.md §10.8 /
// §11 Phase 6.
//
// Orchestration only: loads `RecoveryNotificationPreference` and
// `RecoveryNotificationTriggerState`, resolves quiet hours/"now" in the
// business's own timezone, and writes durable state + notifications. All the
// actual trigger DECISIONS (fire or not, given inputs) are pure functions in
// analysis.service.ts, unit-testable without a database.
//
// WIRED INTO `getRecoveryInsight` (insights.service.ts), which every load of
// the Recovery Target screen AND the Dashboard calls — there is no in-memory
// scheduler or background worker here. This matches the one existing pattern
// this codebase uses for durable notifications: generate them synchronously,
// inside the request that observes the condition (see
// notification.service.ts's callers in expenseRecord/salesRecord/csvImport
// services, and recurring.service.ts's `notifyScheduleFinding`).
//
// Five triggers exist (`RecoveryNotificationTrigger`). Two of them —
// OPEN_DAY_NO_SALES and PROJECTION_SHORTFALL — are wired end-to-end (state
// rows are created/evaluated every call) but their pure decision functions
// always return `false`, deliberately, per their doc comments in
// analysis.service.ts. Do not "finish" them without the missing capability
// (operating hours) or approval (the projection's backtesting gate) each one
// is blocked on.
import { Prisma, type BusinessProfile, type RecoveryNotificationTrigger } from "@prisma/client";
import { prisma } from "../config/prisma";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import { DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE } from "./recoveryNotificationPreference.service";
import {
  decideBehindThreeDaysTrigger,
  decideCoverageReachedTrigger,
  decideOpenDayNoSalesTrigger,
  decideProjectionShortfallTrigger,
  decideTargetIncreaseTrigger,
  isWithinNotificationCooldown,
  isWithinQuietHours,
  type DayStatus,
  type RecoveryTargets,
} from "./analysis.service";

// Defaults for a business profile with no `RecoveryNotificationPreference`
// row reuse the exact same constant the CRUD surface
// (recoveryNotificationPreference.service.ts) already returns from its GET
// endpoint for the same "unconfigured" case — one source of truth for what
// "every trigger defaults ON" actually means, rather than two numbers that
// could silently drift apart.
const DEFAULT_TARGET_INCREASE_THRESHOLD_PERCENT = DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE.targetIncreaseThresholdPercent;
const DEFAULT_MIN_HOURS_BETWEEN_NOTIFICATIONS = DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE.minHoursBetweenNotifications;

/**
 * Neutral, supportive copy per §10.8 — never claims profit, a guaranteed
 * outcome, or a specific peso figure. §14 flags that lock-screen previews may
 * expose financial information, and unlike the existing
 * `LARGE_EXPENSE_FLAG`/`POSSIBLE_DUPLICATE` notifications (which do embed a
 * peso amount tied to ONE already-recorded expense), a Recovery Target
 * notification describes the whole business's month-to-date position — a
 * more sensitive figure to put on a lock screen than a single transaction.
 * These messages are deliberately MORE conservative than that existing
 * convention rather than matching its level of detail; the amount is
 * available once the owner opens the app. This is a judgment call, not a
 * strict reading of an existing precedent, since no other notification type
 * in this codebase describes an aggregate financial position.
 */
const MESSAGES: Record<"TARGET_INCREASE" | "BEHIND_THREE_DAYS" | "COVERAGE_REACHED", string> = {
  TARGET_INCREASE: "Your Recovery Target went up. Open the app to see today's plan.",
  BEHIND_THREE_DAYS: "Your Recovery Target has been behind pace for a few days. Take a look when you can.",
  COVERAGE_REACHED: "You've reached this month's Recovery Target. Nice work.",
};

/** Minutes since local midnight (0-1439) for `at`, in `timezone`. */
function resolveBusinessLocalMinuteOfDay(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Some locales render midnight as "24:00" under hour12: false.
  return (hour % 24) * 60 + minute;
}

/** "YYYY-MM", business-local, for `at`. */
function resolveBusinessMonthKey(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  })
    .format(at)
    .slice(0, 7);
}

/**
 * `RecoveryNotificationPreference.quietHoursStart`/`quietHoursEnd` are
 * `@db.Time(0)` columns — Prisma/node-postgres represent a bare TIME value as
 * a `Date` anchored to the Unix epoch, with only the UTC hour/minute
 * components meaningful. This reads those, not a real calendar date.
 */
function minutesFromTimeColumn(value: Date | null): number | null {
  if (!value) return null;
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

export interface RecoveryNotificationContext {
  profile: BusinessProfile;
  /** `RecoveryTargets` this same request already computed — no re-derivation. */
  targets: Pick<RecoveryTargets, "status" | "adjustedDailyTarget">;
  /**
   * Status of the most recent COMPLETED (strictly before business-local
   * today) operating days, oldest-first or newest-first — order does not
   * matter to `decideBehindThreeDaysTrigger`, which only checks that all
   * three are `"below"`. Pass however many are available; fewer than 3 means
   * the trigger cannot fire this evaluation (see that function's doc
   * comment).
   */
  lastThreeCompletedOperatingDayStatuses: DayStatus[];
  /** Defaults to `new Date()`; overridable so tests control "now" and quiet-hours/cooldown math deterministically. */
  now?: Date;
}

/**
 * Evaluates all five §10.8 triggers for one business profile and, for
 * whichever fire, writes a durable `Notification` — subject to per-trigger
 * opt-in, cooldown, and quiet hours.
 *
 * NEVER THROWS: a failure here must not break the Recovery Target response
 * that triggered it (see the try/catch below and the call site in
 * `getRecoveryInsight`). Errors are logged, not swallowed silently.
 */
export async function evaluateRecoveryNotifications(ctx: RecoveryNotificationContext): Promise<void> {
  const now = ctx.now ?? new Date();
  const businessProfileId = ctx.profile.id;

  try {
    const [preference, triggerStates] = await Promise.all([
      prisma.recoveryNotificationPreference.findUnique({ where: { businessProfileId } }),
      prisma.recoveryNotificationTriggerState.findMany({ where: { businessProfileId } }),
    ]);

    // Missing preference row = every trigger defaults ON, no quiet hours, the
    // schema's default cooldown/threshold — matching the schema author's
    // documented "absent means every trigger below defaults ON" convention.
    const minHoursBetweenNotifications = preference?.minHoursBetweenNotifications ?? DEFAULT_MIN_HOURS_BETWEEN_NOTIFICATIONS;
    const thresholdPercent = preference ? Number(preference.targetIncreaseThresholdPercent) : DEFAULT_TARGET_INCREASE_THRESHOLD_PERCENT;
    const quietHoursStartMinute = minutesFromTimeColumn(preference?.quietHoursStart ?? null);
    const quietHoursEndMinute = minutesFromTimeColumn(preference?.quietHoursEnd ?? null);

    const localMinuteOfDay = resolveBusinessLocalMinuteOfDay(ctx.profile.timezone, now);
    // §10.8 "quiet hours" — DEFER rather than queue: a suppressed firing is
    // simply not raised this evaluation. `lastEvaluatedAt` still advances (see
    // `upsertTriggerState`), so the cooldown clock is never paused by quiet
    // hours; the condition is simply re-checked, fresh, on the next
    // evaluation after quiet hours end. This is simpler than a deferred-send
    // queue and still correct: nothing here is a one-time event that would be
    // lost by not queueing it — every trigger's condition (still behind,
    // still covered, still above the threshold) is naturally re-observable on
    // the next `getRecoveryInsight` call, which happens on every screen load.
    const withinQuietHours = isWithinQuietHours({ localMinuteOfDay, quietHoursStartMinute, quietHoursEndMinute });

    const stateByTrigger = new Map(triggerStates.map((s) => [s.trigger, s]));
    const cooldownOrQuietSuppressed = (lastFiredAt: Date | null) =>
      isWithinNotificationCooldown({ lastFiredAt, now, minHoursBetweenNotifications }) || withinQuietHours;

    await Promise.all([
      evaluateTargetIncrease(ctx, now, preference?.targetIncreaseAlertEnabled ?? true, thresholdPercent, cooldownOrQuietSuppressed),
      evaluateBehindThreeDays(ctx, now, preference?.behindThreeDaysAlertEnabled ?? true, cooldownOrQuietSuppressed),
      evaluateOpenDayNoSales(ctx, stateByTrigger, now),
      evaluateProjectionShortfall(ctx, stateByTrigger, now),
      evaluateCoverageReached(ctx, now, preference?.coverageReachedAlertEnabled ?? true, cooldownOrQuietSuppressed),
    ]);
  } catch (err) {
    console.error(`evaluateRecoveryNotifications failed for businessProfileId=${businessProfileId}`, err);
  }
}

type TriggerStateRow = { lastFiredAt: Date | null; lastFiredValue: Prisma.Decimal | null };

/** Anything with the same trigger-state read/write shape — the global client, or a `$transaction` callback's `tx`. */
type TriggerStateClient = Pick<typeof prisma, "recoveryNotificationTriggerState">;

/**
 * Race condition fix (QA finding on Phase 6): `evaluateRecoveryNotifications`
 * runs on EVERY load of the Recovery Target screen AND the Dashboard, with no
 * queue/scheduler serializing calls — two concurrent calls for the same
 * business profile (e.g. both screens loading at once) previously could both
 * read the same pre-fire `RecoveryNotificationTriggerState` row, both decide
 * "fire", and both write a `Notification` row. The `@@unique` constraint on
 * `RecoveryNotificationTriggerState` only prevents a duplicate STATE row —
 * `Notification` has no uniqueness constraint at all, so nothing stopped two
 * rows landing there.
 *
 * Fix: a Postgres session-scoped advisory lock (`pg_advisory_xact_lock`),
 * keyed on (businessProfileId, this one trigger), held for the lifetime of a
 * `$transaction` that does the READ of the state row, the DECIDE step, and
 * the WRITE (state upsert + notification insert, if any) — all inside that
 * same transaction. A second concurrent call for the same profile+trigger
 * blocks on the lock (rather than racing past it), and once it acquires the
 * lock it re-reads the state row FRESH (not the pre-lock snapshot
 * `evaluateRecoveryNotifications` fetched up front for logging/cheap access),
 * so it correctly sees the first call's just-committed `lastFiredAt` and is
 * suppressed by cooldown (COVERAGE_REACHED is additionally self-correcting
 * here even without cooldown: its own decision function keys off
 * `lastFiredMonthKey`, which the fresh read now reflects).
 *
 * `pg_advisory_xact_lock` auto-releases at transaction end (commit OR
 * rollback) — never held past this function returning, and never needs an
 * explicit unlock call. Only TARGET_INCREASE/BEHIND_THREE_DAYS/
 * COVERAGE_REACHED take this lock: OPEN_DAY_NO_SALES and PROJECTION_SHORTFALL
 * are permanently inert (see their evaluate* doc comments) and can never
 * produce a duplicate notification, so locking them would only add overhead.
 *
 * This matches this codebase's existing convention for a check-then-act race
 * against Postgres (`anomalyDetection/job.service.ts`'s job-claim query uses
 * `SELECT ... FOR UPDATE SKIP LOCKED`) rather than introducing a new pattern
 * — both rely on a Postgres-level lock instead of an application-level mutex,
 * which is the only thing that actually works across concurrent Node
 * requests/processes.
 */
async function withTriggerLock<T>(businessProfileId: number, trigger: RecoveryNotificationTrigger, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Two-int32-key form: businessProfileId as-is (Postgres `Int` columns are
    // already within int4 range), and a small fixed index per trigger so the
    // five triggers for one profile never contend with each other.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${businessProfileId}::int, ${TRIGGER_LOCK_INDEX[trigger]}::int)`;
    return fn(tx);
  });
}

const TRIGGER_LOCK_INDEX: Record<RecoveryNotificationTrigger, number> = {
  TARGET_INCREASE: 1,
  BEHIND_THREE_DAYS: 2,
  OPEN_DAY_NO_SALES: 3,
  PROJECTION_SHORTFALL: 4,
  COVERAGE_REACHED: 5,
};

async function upsertTriggerState(
  client: TriggerStateClient,
  params: {
    businessProfileId: number;
    trigger: RecoveryNotificationTrigger;
    now: Date;
    didFire: boolean;
    lastFiredValue: number | null;
  }
): Promise<void> {
  const { businessProfileId, trigger, now, didFire, lastFiredValue } = params;
  const decimalValue = lastFiredValue != null ? new Prisma.Decimal(lastFiredValue) : null;
  await client.recoveryNotificationTriggerState.upsert({
    where: { businessProfileId_trigger: { businessProfileId, trigger } },
    create: {
      businessProfileId,
      trigger,
      lastEvaluatedAt: now,
      lastFiredAt: didFire ? now : null,
      lastFiredValue: decimalValue,
    },
    update: {
      // ALWAYS advances, whether or not this evaluation fired — this is what
      // makes repeated evaluation idempotent rather than needing its own
      // separate "have I already looked at this" cache.
      lastEvaluatedAt: now,
      ...(didFire ? { lastFiredAt: now } : {}),
      lastFiredValue: decimalValue,
    },
  });
}

/**
 * Locked (see `withTriggerLock`'s doc comment): the read of the trigger-state
 * row happens FRESH, inside the lock, rather than from the
 * `evaluateRecoveryNotifications`-level `stateByTrigger` snapshot fetched
 * before any lock was held — that snapshot can be stale by the time this
 * runs if a concurrent evaluation for the same profile got here first.
 */
async function evaluateTargetIncrease(
  ctx: RecoveryNotificationContext,
  now: Date,
  enabled: boolean,
  thresholdPercent: number,
  suppressed: (lastFiredAt: Date | null) => boolean,
): Promise<void> {
  await withTriggerLock(ctx.profile.id, "TARGET_INCREASE", async (tx) => {
    const state = await tx.recoveryNotificationTriggerState.findUnique({
      where: { businessProfileId_trigger: { businessProfileId: ctx.profile.id, trigger: "TARGET_INCREASE" } },
    });
    const lastFiredAt = state?.lastFiredAt ?? null;
    const lastFiredValue = state?.lastFiredValue != null ? Number(state.lastFiredValue) : null;

    const decision = decideTargetIncreaseTrigger({
      adjustedDailyTarget: ctx.targets.adjustedDailyTarget,
      lastFiredValue,
      thresholdPercent,
    });

    const didFire = enabled && decision.fire && !suppressed(lastFiredAt);

    // Baseline handling: if the condition wasn't met, always persist
    // `decision.nextLastFiredValue` (either the first-ever baseline, or the
    // unchanged existing one). If the condition WAS met but suppressed by
    // cooldown/quiet hours, deliberately leave the baseline UNCHANGED
    // (`lastFiredValue`, not the new higher value) — otherwise the material
    // increase would be silently absorbed into the baseline without the owner
    // ever having been told about it, and a later, smaller increase on top of
    // it might never clear the threshold on its own.
    const nextLastFiredValue = !decision.fire ? decision.nextLastFiredValue : didFire ? decision.nextLastFiredValue : lastFiredValue;

    await upsertTriggerState(tx, { businessProfileId: ctx.profile.id, trigger: "TARGET_INCREASE", now, didFire, lastFiredValue: nextLastFiredValue });
    if (didFire) {
      await createNotification(ctx.profile.userId, ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET, MESSAGES.TARGET_INCREASE, undefined, tx);
    }
  });
}

/** Locked — see `evaluateTargetIncrease`'s doc comment; same fresh-read-under-lock reasoning applies here. */
async function evaluateBehindThreeDays(
  ctx: RecoveryNotificationContext,
  now: Date,
  enabled: boolean,
  suppressed: (lastFiredAt: Date | null) => boolean,
): Promise<void> {
  await withTriggerLock(ctx.profile.id, "BEHIND_THREE_DAYS", async (tx) => {
    const state = await tx.recoveryNotificationTriggerState.findUnique({
      where: { businessProfileId_trigger: { businessProfileId: ctx.profile.id, trigger: "BEHIND_THREE_DAYS" } },
    });
    const lastFiredAt = state?.lastFiredAt ?? null;

    const conditionMet = decideBehindThreeDaysTrigger({
      monthStatus: ctx.targets.status,
      lastThreeCompletedOperatingDayStatuses: ctx.lastThreeCompletedOperatingDayStatuses,
    });
    const didFire = enabled && conditionMet && !suppressed(lastFiredAt);

    await upsertTriggerState(tx, { businessProfileId: ctx.profile.id, trigger: "BEHIND_THREE_DAYS", now, didFire, lastFiredValue: null });
    if (didFire) {
      await createNotification(ctx.profile.userId, ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET, MESSAGES.BEHIND_THREE_DAYS, undefined, tx);
    }
  });
}

/**
 * Always inert — see `decideOpenDayNoSalesTrigger`'s doc comment
 * (analysis.service.ts) for exactly why. Still evaluated every call so
 * `lastEvaluatedAt` advances like every other trigger, and so enabling it
 * later (once an operating-hours capability exists) is a one-line change to
 * the pure decision function, not new wiring here.
 */
async function evaluateOpenDayNoSales(
  ctx: RecoveryNotificationContext,
  _stateByTrigger: Map<RecoveryNotificationTrigger, TriggerStateRow>,
  now: Date,
): Promise<void> {
  const conditionMet = decideOpenDayNoSalesTrigger();
  await upsertTriggerState(prisma, { businessProfileId: ctx.profile.id, trigger: "OPEN_DAY_NO_SALES", now, didFire: false, lastFiredValue: null });
  if (conditionMet) {
    // Unreachable today — decideOpenDayNoSalesTrigger() always returns false.
    await createNotification(ctx.profile.userId, ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET, "Recovery Target needs attention today.");
  }
}

/**
 * Always inert — see `decideProjectionShortfallTrigger`'s doc comment
 * (analysis.service.ts): the projection it would depend on is not yet
 * approved for display anywhere.
 */
async function evaluateProjectionShortfall(
  ctx: RecoveryNotificationContext,
  _stateByTrigger: Map<RecoveryNotificationTrigger, TriggerStateRow>,
  now: Date,
): Promise<void> {
  const conditionMet = decideProjectionShortfallTrigger();
  await upsertTriggerState(prisma, { businessProfileId: ctx.profile.id, trigger: "PROJECTION_SHORTFALL", now, didFire: false, lastFiredValue: null });
  if (conditionMet) {
    // Unreachable today — decideProjectionShortfallTrigger() always returns false.
    await createNotification(ctx.profile.userId, ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET, "Your month-end projection now shows a shortfall.");
  }
}

/**
 * Locked — see `evaluateTargetIncrease`'s doc comment. Self-correcting even
 * without the cooldown suppression check: `decideCoverageReachedTrigger`
 * keys off `lastFiredMonthKey`, which the fresh in-lock read now reflects, so
 * a second concurrent call within the same month sees itself as already
 * fired regardless of `minHoursBetweenNotifications`.
 */
async function evaluateCoverageReached(
  ctx: RecoveryNotificationContext,
  now: Date,
  enabled: boolean,
  suppressed: (lastFiredAt: Date | null) => boolean,
): Promise<void> {
  await withTriggerLock(ctx.profile.id, "COVERAGE_REACHED", async (tx) => {
    const state = await tx.recoveryNotificationTriggerState.findUnique({
      where: { businessProfileId_trigger: { businessProfileId: ctx.profile.id, trigger: "COVERAGE_REACHED" } },
    });
    const lastFiredAt = state?.lastFiredAt ?? null;
    const currentMonthKey = resolveBusinessMonthKey(ctx.profile.timezone, now);
    const lastFiredMonthKey = lastFiredAt ? resolveBusinessMonthKey(ctx.profile.timezone, lastFiredAt) : null;

    const conditionMet = decideCoverageReachedTrigger({
      monthStatus: ctx.targets.status,
      lastFiredAt,
      currentMonthKey,
      lastFiredMonthKey,
    });
    const didFire = enabled && conditionMet && !suppressed(lastFiredAt);

    await upsertTriggerState(tx, { businessProfileId: ctx.profile.id, trigger: "COVERAGE_REACHED", now, didFire, lastFiredValue: null });
    if (didFire) {
      await createNotification(ctx.profile.userId, ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET, MESSAGES.COVERAGE_REACHED, undefined, tx);
    }
  });
}
