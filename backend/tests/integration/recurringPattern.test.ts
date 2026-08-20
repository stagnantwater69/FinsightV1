import { AnomalyFindingSeverity, AnomalyFindingType, AnalysisJobKind, RecurringPatternStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * This file drives the detector with an explicitly recurring-enabled config, and
 * it also calls the owner CRUD (updateRecurringSchedule / deleteRecurringSchedule)
 * directly. Those now refuse with 404 unless `featureFlags.recurring` is on, so
 * the runtime config the guard reads has to agree with the config passed to the
 * detector below — otherwise this file would be testing the flag, not the
 * behaviour. .env.test leaves ANOMALY_RECURRING_ENABLED unset (false, as
 * production ships it), so it is overridden here rather than globally.
 *
 * Read through a getter so the flag-off cases below (which exercise the worker's
 * own use of RUNTIME_DETECTION_CONFIG) can turn it back off explicitly, instead
 * of depending on an env var they never name.
 */
const { recurringFlag } = vi.hoisted(() => ({ recurringFlag: { enabled: true } }));
vi.mock("../../src/services/anomalyDetection/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/anomalyDetection/config")>();
  return {
    ...actual,
    get RUNTIME_DETECTION_CONFIG() {
      return actual.detectionConfig({ featureFlags: { recurring: recurringFlag.enabled } });
    },
  };
});

import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { refreshRecurringPatterns, reviewRecurringPattern } from "../../src/services/anomalyDetection/recurring.service";
import { deleteRecurringSchedule, updateRecurringSchedule } from "../../src/services/recurringSchedule.service";
import { DEFAULT_DETECTION_CONFIG, detectionConfig } from "../../src/services/anomalyDetection/config";
import { runAnalysisWorkerOnce } from "../../src/services/anomalyDetection/job.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const RECURRING_ENABLED_CONFIG = detectionConfig({ featureFlags: { recurring: true } });

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); recurringFlag.enabled = true; });
afterAll(disconnectDb);

async function add(date: string, amount = 1_000) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id, categoryId: ctx.categories.Utilities!,
    date, amount, description: "Monthly electricity", vendor: "Power Co.",
  });
}

describe("recurring pattern persistence", () => {
  it("discovers a candidate but waits for owner confirmation before warning", async () => {
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const patterns = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, new Date("2026-03-05T00:00:00Z"));

    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.status).toBe(RecurringPatternStatus.CANDIDATE);
    expect(patterns[0]!.observationCount).toBe(3);
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });

  it("does not warn about a confirmed pattern on its own — the watchdog watches schedules", async () => {
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const [pattern] = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, new Date("2026-03-05T00:00:00Z"));
    await reviewRecurringPattern(ctx.user.id, pattern!.id, RecurringPatternStatus.CONFIRMED);
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, new Date("2026-04-10T00:00:00Z"));

    // Confirming a pattern is an inference the owner agreed with; it is Phase 3's
    // job to turn that into a RecurringSchedule. Until a schedule exists there is
    // nothing declared to watch.
    expect(await prisma.anomalyFinding.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("protects pattern review by ownership", async () => {
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const [pattern] = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, new Date("2026-03-05T00:00:00Z"));
    const other = await makeOwnerWithProfile({ name: "Other" });
    await expect(reviewRecurringPattern(other.user.id, pattern!.id, RecurringPatternStatus.CONFIRMED)).rejects.toMatchObject({ status: 404 });
  });
});

const utc = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * An owner-declared schedule. `label`/`vendor`/`categoryId` line up with the
 * records `add()` writes, so the watchdog can match them.
 */
async function declareSchedule(overrides: Partial<{ label: string; intervalDays: number; expectedAmount: number; nextDueDate: string; isActive: boolean; createdAt: string }> = {}) {
  return prisma.recurringSchedule.create({
    data: {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Utilities!,
      label: overrides.label ?? "Monthly electricity",
      vendor: "Power Co.",
      intervalDays: overrides.intervalDays ?? 30,
      expectedAmount: overrides.expectedAmount ?? 1_000,
      nextDueDate: utc(overrides.nextDueDate ?? "2026-04-01"),
      isActive: overrides.isActive ?? true,
      // Only the cold-start case needs to pin this; everywhere else the row's
      // real creation instant is irrelevant to what the pass does.
      ...(overrides.createdAt ? { createdAt: new Date(`${overrides.createdAt}T09:00:00Z`) } : {}),
    },
  });
}

describe("recurring schedule watchdog", () => {
  it("raises recurring-due-soon BEFORE the due date when the cycle has no record", async () => {
    const schedule = await declareSchedule({ nextDueDate: "2026-04-01" });

    // Outside the 3-day lead time: silent.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-25"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-due-soon" } })).toBe(0);

    // Inside it: warns, and warns loudly enough to clear the notification gate.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-30"));
    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-due-soon" } });
    expect(finding.type).toBe(AnomalyFindingType.RECURRING_CHANGE);
    expect(finding.severity).toBe(AnomalyFindingSeverity.HIGH);
    expect(finding.fingerprint).toBe("recurring-v1:due-soon:" + schedule.id + ":2026-04-01");
    expect((finding.metadata as { recurringScheduleId: number }).recurringScheduleId).toBe(schedule.id);
  });

  it("raises recurring-missing at HIGH after the grace period", async () => {
    const schedule = await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));

    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-missing" } });
    expect(finding.severity).toBe(AnomalyFindingSeverity.HIGH);
    expect(finding.fingerprint).toBe("recurring-v1:missing:" + schedule.id + ":2026-04-01");
    // Due-soon is retired once the date has passed.
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-due-soon", status: "OPEN" } })).toBe(0);
  });

  it("advances nextDueDate and records lastRecordedDate when a matching record arrives", async () => {
    await add("2026-03-02");
    const schedule = await declareSchedule({ nextDueDate: "2026-03-05", intervalDays: 30 });

    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-06"));
    const advanced = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(advanced.lastRecordedDate?.toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(advanced.nextDueDate.toISOString().slice(0, 10)).toBe("2026-04-04");

    // A re-run must not advance the same payment twice.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-06"));
    const rerun = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(rerun.nextDueDate.toISOString().slice(0, 10)).toBe("2026-04-04");
  });

  it("does not let a record that PREDATES the declaration satisfy the first declared cycle", async () => {
    // REGRESSION (P2). The cold-start flow the feature exists for: an owner who
    // already knows the power bill is due on the 1st declares it, and the
    // previous month's payment is already on file. `lastRecordedDate` is null
    // on a fresh row, so `cycleStart` (2026-08-02) was the only floor and the
    // 2026-08-10 record — the PREVIOUS cycle's payment, recorded before the
    // schedule existed — was adopted as this cycle's. The schedule jumped to
    // 2026-10-01 on the first pass, and the declared 2026-09-01 cycle got
    // neither the forward-looking warning nor the retrospective one.
    await add("2026-08-10", 9_500);
    const schedule = await declareSchedule({
      nextDueDate: "2026-09-01", intervalDays: 30, expectedAmount: 9_500, createdAt: "2026-08-19",
    });

    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-19"));
    const afterDeclaration = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(afterDeclaration.nextDueDate.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(afterDeclaration.lastRecordedDate).toBeNull();

    // The cycle is now actually watched: warned before the date...
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-30"));
    const dueSoon = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-due-soon" } });
    expect(dueSoon.fingerprint).toBe("recurring-v1:due-soon:" + schedule.id + ":2026-09-01");

    // ...and reported after the grace period when nothing was recorded for it.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-09-10"));
    const missing = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-missing" } });
    expect(missing.fingerprint).toBe("recurring-v1:missing:" + schedule.id + ":2026-09-01");
    expect(missing.severity).toBe(AnomalyFindingSeverity.HIGH);

    // A record made AFTER the declaration still satisfies the cycle it lands in,
    // so the floor is a cold-start guard and not a permanent block.
    await add("2026-09-12", 9_500);
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-09-13"));
    const satisfied = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(satisfied.lastRecordedDate?.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(satisfied.nextDueDate.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(0);
  });

  it("treats a schedule declared due TODAY as a fresh declaration, not a backdated catch-up", async () => {
    // REGRESSION (P2). The declaration floor was scoped with a strict `>`, so a
    // schedule whose nextDueDate landed exactly ON the declaration day read as a
    // BACKDATED catch-up and the floor switched off. That is the web form's
    // default (RecurringScheduleForm seeds nextDueDate with today), so simply
    // accepting the default reproduced the cold-start defect the test above
    // locks out, one day off its boundary: the previous cycle's record was
    // adopted, nextDueDate jumped to 2026-09-18, and the first declared cycle
    // got neither the due-soon nor the missing warning.
    await add("2026-08-10", 9_500);
    const schedule = await declareSchedule({
      nextDueDate: "2026-08-19", intervalDays: 30, expectedAmount: 9_500, createdAt: "2026-08-19",
    });

    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-19"));
    const afterDeclaration = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(afterDeclaration.nextDueDate.toISOString().slice(0, 10)).toBe("2026-08-19");
    expect(afterDeclaration.lastRecordedDate).toBeNull();

    // The declared cycle is watched on the day itself...
    const dueSoon = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-due-soon" } });
    expect(dueSoon.fingerprint).toBe("recurring-v1:due-soon:" + schedule.id + ":2026-08-19");

    // ...and reported after the grace period when nothing was recorded for it.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-30"));
    const missing = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-missing" } });
    expect(missing.fingerprint).toBe("recurring-v1:missing:" + schedule.id + ":2026-08-19");
    expect(missing.severity).toBe(AnomalyFindingSeverity.HIGH);
  });

  it("keeps the floor OFF for a genuinely backdated declaration so its history still counts", async () => {
    // The other side of the same boundary: a due date strictly BEFORE the
    // declaration day is the catch-up shape, where records already on file are
    // exactly what legitimately satisfies those past cycles. Flooring it would
    // strand the schedule on a date it can never clear.
    await add("2026-08-10", 9_500);
    const schedule = await declareSchedule({
      nextDueDate: "2026-08-18", intervalDays: 30, expectedAmount: 9_500, createdAt: "2026-08-19",
    });

    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-19"));
    const caughtUp = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(caughtUp.lastRecordedDate?.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(caughtUp.nextDueDate.toISOString().slice(0, 10)).toBe("2026-09-17");
  });

  it("does not raise amount-change or repeated findings about history that PREDATES a declaration due TODAY", async () => {
    // REGRESSION (P2), the informational half of the due-today boundary. With
    // the floor disabled, `evidence` fell back to the unfiltered record list and
    // raised amount-change plus repeated against 18-month-old pre-declaration
    // history. Neither fingerprint prefix is superseded anywhere in this file, so
    // those findings stay OPEN and inflate the Alerts badge permanently.
    await add("2025-02-10", 3_000);
    await add("2025-02-14", 3_000); // 4 days apart — under half of a 30d interval.
    await declareSchedule({
      nextDueDate: "2026-08-19", intervalDays: 30, expectedAmount: 12_000, createdAt: "2026-08-19",
    });

    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-19"));

    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-amount-change" } })).toBe(0);
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-repeated" } })).toBe(0);
  });

  it("does not raise amount-change or repeated findings about history that PREDATES the declaration", async () => {
    // REGRESSION (P2). The declaration floor stopped pre-declaration records
    // SATISFYING a cycle, but the amount-change / repeated block at the end of
    // the same loop read the unfiltered record list, so it fired on exactly the
    // records the floor had just refused to count. Declaring a schedule today
    // immediately alarmed the owner about 18-month-old history — and neither
    // fingerprint prefix is ever superseded, so those findings stay OPEN and
    // inflate the Alerts badge forever.
    await add("2025-02-10", 3_000);
    await add("2025-02-14", 3_000); // 4 days apart — under half of a 30d interval.
    await declareSchedule({
      nextDueDate: "2026-09-01", intervalDays: 30, expectedAmount: 12_000, createdAt: "2026-08-19",
    });

    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-08-19"));

    // The floor still held for the cycle half of the loop...
    const afterDeclaration = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: (await prisma.recurringSchedule.findFirstOrThrow()).id } });
    expect(afterDeclaration.lastRecordedDate).toBeNull();
    // ...and now the informational half agrees with it.
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-amount-change" } })).toBe(0);
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-repeated" } })).toBe(0);

    // Not a permanent mute: a record made AFTER the declaration is still judged.
    await add("2026-09-05", 3_000);
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-09-06"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-amount-change" } })).toBe(1);
  });

  it("catches a schedule up across several missed cycles instead of deadlocking", async () => {
    // REGRESSION (P1). lastRecordedDate jumps to the NEWEST matching record,
    // and the next pass only looks at records after it. A nextDueDate that
    // advanced by a single interval was therefore left permanently behind
    // lastRecordedDate: no later record could ever satisfy it, so the schedule
    // reported a bill the owner HAD recorded as missing — HIGH, with a push,
    // on every pass, forever. Ordinary trigger: the watchdog only runs on
    // PROFILE_REFRESH, so any profile idle for two cycles lands here.
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const schedule = await declareSchedule({ nextDueDate: "2026-01-01", intervalDays: 30 });

    for (let pass = 0; pass < 5; pass += 1) {
      await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-06"));
    }

    const after = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(after.lastRecordedDate?.toISOString().slice(0, 10)).toBe("2026-03-02");
    // 2026-01-01 + 3x30d — the first grid date strictly after the newest record.
    expect(after.nextDueDate.toISOString().slice(0, 10)).toBe("2026-04-01");
    // The invariant that makes the deadlock impossible.
    expect(after.nextDueDate.getTime()).toBeGreaterThan(after.lastRecordedDate!.getTime());

    // And nothing tells the owner they forgot a payment they made.
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(0);
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule" } })).toBe(0);
  });

  it("never overwrites owner-edited schedule fields on a detector re-run", async () => {
    // THE REGRESSION TEST FOR THIS WHOLE PLAN. The defect being locked out is
    // the one RecurringPattern still has: its upsert rewrites description,
    // intervalDays, expectedAmount and amountTolerance on every pass, so an
    // owner edit would silently revert. RecurringSchedule holds owner intent;
    // the detector may only ever touch lastRecordedDate and nextDueDate.
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");

    // (a) A schedule that DOES match the records, so the detector genuinely
    //     writes to it during these passes. Numeric fields are edited away from
    //     what the detector infers (1,000 / 30d / 0.15). The label and vendor
    //     match only AFTER normalization — "MONTHLY  Electricity" normalizes to
    //     the record's "Monthly electricity" — so the owner's own capitalization
    //     and spacing are recoverable evidence: if the write site ever wrote
    //     `label: record.description`, these raw strings would change even
    //     though matching still succeeded. Matching on normalized text is what
    //     makes this the only way to catch an identity clobber at the write
    //     site; asserting a label that is already byte-identical to the record
    //     proves nothing.
    const matching = await prisma.recurringSchedule.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Utilities!,
        label: "MONTHLY  Electricity",
        vendor: "power co",
        intervalDays: 45,
        expectedAmount: 4_242.42,
        amountTolerance: 0.5,
        nextDueDate: utc("2026-03-05"),
      },
    });

    // (b) A schedule whose identity fields are deliberately UNLIKE the records
    //     and unlike the inferred pattern. Asserting label/vendor/categoryId on
    //     a schedule that already matches the records proves nothing — the
    //     detector writing `label: pattern.description` would produce the same
    //     value. These have to differ for the assertion to bite.
    const distinct = await prisma.recurringSchedule.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        label: "Landlord — unit 2B, quarterly",
        vendor: "Metro Realty Holdings",
        intervalDays: 91,
        expectedAmount: 87_500,
        amountTolerance: 0.02,
        nextDueDate: utc("2026-03-05"),
      },
    });

    // Several passes, including ones that DO match records and so DO write.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-06"));
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-05-20"));

    const afterMatching = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: matching.id } });
    expect(Number(afterMatching.expectedAmount)).toBe(4_242.42);
    expect(afterMatching.intervalDays).toBe(45);
    expect(Number(afterMatching.amountTolerance)).toBe(0.5);
    expect(afterMatching.isActive).toBe(true);
    // Proof the detector did write to this row (so the assertions above are not
    // passing merely because it was never touched).
    expect(afterMatching.lastRecordedDate).not.toBeNull();
    // The owner's exact wording survives that write.
    expect(afterMatching.label).toBe("MONTHLY  Electricity");
    expect(afterMatching.vendor).toBe("power co");
    expect(afterMatching.categoryId).toBe(ctx.categories.Utilities!);

    const afterDistinct = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: distinct.id } });
    expect(afterDistinct.label).toBe("Landlord — unit 2B, quarterly");
    expect(afterDistinct.vendor).toBe("Metro Realty Holdings");
    expect(afterDistinct.categoryId).toBe(ctx.categories.Inventory!);
    expect(afterDistinct.intervalDays).toBe(91);
    expect(Number(afterDistinct.expectedAmount)).toBe(87_500);
    expect(Number(afterDistinct.amountTolerance)).toBe(0.02);
    // Nor may the detector adopt an unrelated pattern's records as this
    // schedule's progress: no match means no tracking write either.
    expect(afterDistinct.lastRecordedDate).toBeNull();
    expect(afterDistinct.nextDueDate.toISOString().slice(0, 10)).toBe("2026-03-05");
  });

  it("notifies about a due-soon schedule exactly ONCE per cycle, across the whole lead window", async () => {
    await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-30"));

    const notifications = await prisma.notification.findMany({ where: { type: "Recurring Schedule" } });
    expect(notifications).toHaveLength(1);
    // Absolute date, not "in 2 days". This assertion is the decision: a relative
    // phrase changes daily, which would defeat the (businessProfileId, type,
    // message) dedupe and turn one due date into three pushes.
    expect(notifications[0]!.message).toBe("Monthly electricity is due 2026-04-01 and has not been recorded yet");
    expect(notifications[0]!.userId).toBe(ctx.user.id);
    expect(notifications[0]!.expenseRecordId).toBeNull();

    // Same day again, then every remaining day of the lead window, then the due
    // date itself — still one notification. Different DAYS is what pins this;
    // a same-day re-run alone would not catch a regression to relative wording.
    for (const day of ["2026-03-30", "2026-03-31", "2026-04-01"]) {
      await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc(day));
    }
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule" } })).toBe(1);

    // The finding, unlike the push, stays open across the window — nothing is
    // hidden by collapsing the notification.
    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-due-soon" } });
    expect(finding.status).toBe("OPEN");
    expect((finding.reasons as string[])[0]).toBe("Monthly electricity is due today (2026-04-01) and has not been recorded yet");
  });

  it("notifies about a missing schedule and does not duplicate on re-run", async () => {
    await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-11"));

    const notifications = await prisma.notification.findMany({ where: { type: "Recurring Schedule" } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toBe("Monthly electricity was due 2026-04-01 and has not been recorded yet");
  });

  it("does NOT notify for recurring-amount-change — informational findings stay in the list", async () => {
    await add("2026-03-02", 5_000);
    await declareSchedule({ nextDueDate: "2026-03-05", intervalDays: 30, expectedAmount: 1_000 });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-06"));

    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-amount-change" } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule" } })).toBe(0);
  });

  it("does NOT notify for recurring-repeated even though it clears the severity gate", async () => {
    // Pins the REASON the informational half of the watchdog is excluded from
    // notifyScheduleFinding: it is not that these findings sit below the gate.
    // `recurring-repeated` is raised at HIGH unconditionally and the default
    // `notificationMinimumSeverity` is HIGH, so a severity-derived exclusion
    // would already be leaking pushes here. The exclusion is by METHOD: this
    // finding hangs off a record the owner can already see, whereas the two
    // methods that do notify report a record that does not exist.
    await add("2026-03-02"); await add("2026-03-10");
    await declareSchedule({ nextDueDate: "2026-04-01", intervalDays: 30 });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-11"));

    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-repeated" } });
    expect(finding.severity).toBe(AnomalyFindingSeverity.HIGH);
    expect(RECURRING_ENABLED_CONFIG.notificationMinimumSeverity).toBe("HIGH");
    expect(finding.expenseRecordId).not.toBeNull();
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule" } })).toBe(0);
  });

  it("ignores paused schedules", async () => {
    await declareSchedule({ nextDueDate: "2026-04-01", isActive: false });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));
    expect(await prisma.anomalyFinding.count()).toBe(0);
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule" } })).toBe(0);
  });

  /*
   * Pausing/deleting has to CLOSE what the watchdog already raised, not merely
   * stop raising more. The watchdog selects `isActive: true` only, and every
   * supersede write it performs is inside that loop, so an already-open
   * recurring-missing finding becomes unreachable the instant the schedule stops
   * being active — and unreachable forever once the row is deleted, since the
   * schedule id survives only inside fingerprints and metadata JSON. Both
   * clients promise "FinSight just stops telling you when it's late".
   */
  it("supersedes the open missing finding and clears its notification when the owner PAUSES the schedule", async () => {
    const schedule = await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule", readStatus: false } })).toBe(1);

    await updateRecurringSchedule(ctx.user.id, schedule.id, { isActive: false });

    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(0);
    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "recurring-missing" } });
    expect(finding.status).toBe("SUPERSEDED");
    // The alarm leaves the bell too — it is the same warning, delivered twice.
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule", readStatus: false } })).toBe(0);

    // And a later pass must not resurrect it: the pause is not a one-off cleanup.
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-05-10"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(0);
  });

  it("supersedes the open due-soon finding when the owner PAUSES the schedule", async () => {
    const schedule = await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-03-30"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-due-soon", status: "OPEN" } })).toBe(1);

    await updateRecurringSchedule(ctx.user.id, schedule.id, { isActive: false });

    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-due-soon", status: "OPEN" } })).toBe(0);
  });

  it("supersedes the open finding before the row is DELETED, so nothing is orphaned", async () => {
    const schedule = await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(1);

    await deleteRecurringSchedule(ctx.user.id, schedule.id);

    expect(await prisma.recurringSchedule.count({ where: { id: schedule.id } })).toBe(0);
    // No FK, no cascade — if this row were still OPEN, no code path anywhere
    // could ever close it again.
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(0);
    expect(await prisma.notification.count({ where: { type: "Recurring Schedule", readStatus: false } })).toBe(0);
  });

  it("leaves another schedule's findings alone when one is paused", async () => {
    const kept = await declareSchedule({ nextDueDate: "2026-04-01" });
    const paused = await declareSchedule({ label: "Monthly internet", nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(2);

    await updateRecurringSchedule(ctx.user.id, paused.id, { isActive: false });

    const open = await prisma.anomalyFinding.findMany({ where: { method: "recurring-missing", status: "OPEN" } });
    expect(open).toHaveLength(1);
    expect(open[0]!.fingerprint).toBe(`recurring-v1:missing:${kept.id}:2026-04-01`);
    const unread = await prisma.notification.findMany({ where: { type: "Recurring Schedule", readStatus: false } });
    expect(unread.map((row) => row.message)).toEqual(["Monthly electricity was due 2026-04-01 and has not been recorded yet"]);
  });

  it("does not let one owner retire another owner's schedule findings", async () => {
    const schedule = await declareSchedule({ nextDueDate: "2026-04-01" });
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, RECURRING_ENABLED_CONFIG, utc("2026-04-10"));
    const other = await makeOwnerWithProfile({ name: "Other" });

    await expect(updateRecurringSchedule(other.user.id, schedule.id, { isActive: false })).rejects.toMatchObject({ status: 404 });
    await expect(deleteRecurringSchedule(other.user.id, schedule.id)).rejects.toMatchObject({ status: 404 });
    expect(await prisma.anomalyFinding.count({ where: { method: "recurring-missing", status: "OPEN" } })).toBe(1);
  });
});

describe("recurring detection feature flag", () => {
  it("no-ops when the recurring flag is off (default), matching sibling per-record detectors", async () => {
    expect(DEFAULT_DETECTION_CONFIG.featureFlags.recurring).toBe(false);
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const patterns = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, DEFAULT_DETECTION_CONFIG, new Date("2026-03-05T00:00:00Z"));

    expect(patterns).toHaveLength(0);
    expect(await prisma.recurringPattern.count()).toBe(0);
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });

  it("does not create RecurringPattern rows or findings from a PROFILE_REFRESH job when the flag is off", async () => {
    // The worker reads RUNTIME_DETECTION_CONFIG itself, so the flag is turned
    // off here rather than left to the ambient env.
    recurringFlag.enabled = false;
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    await prisma.analysisJob.create({
      data: {
        businessProfileId: ctx.profile.id,
        idempotencyKey: `profile:${ctx.profile.id}:test`,
        kind: AnalysisJobKind.PROFILE_REFRESH,
      },
    });

    const processed = await runAnalysisWorkerOnce();

    expect(processed).toBe(true);
    expect(await prisma.recurringPattern.count()).toBe(0);
    expect(await prisma.anomalyFinding.count({ where: { type: AnomalyFindingType.RECURRING_CHANGE } })).toBe(0);
  });
});
