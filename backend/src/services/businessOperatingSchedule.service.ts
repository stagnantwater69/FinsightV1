import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import { Prisma, type BusinessOperatingDay, type BusinessOperatingDayOverride, type OperatingDayOverrideType } from "@prisma/client";

// Write/CRUD surface only, per docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.2-§7.4
// and §11 Phase 2 "Backend API". The read-side calendar-resolution logic that
// CONSUMES these two tables (open/closed-for-a-date-range, exact monthly/
// remaining open-day counts) is owned by a separate agent and lives in its own
// service — this file never derives calendar semantics, it only persists what
// the owner entered.

const MAX_OVERRIDE_RANGE_DAYS = 366;

export interface ScheduleEntryInput {
  weekday: number;
  isOpen: boolean;
}

function toScheduleDTO(day: BusinessOperatingDay) {
  return {
    weekday: day.weekday,
    isOpen: day.isOpen,
  };
}

export async function getWeeklySchedule(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const days = await prisma.businessOperatingDay.findMany({
    where: { businessProfileId },
    orderBy: { weekday: "asc" },
  });
  return days.map(toScheduleDTO);
}

/**
 * Replaces the whole weekly schedule atomically. Callers (the controller)
 * are responsible for validating that `entries` is exactly the seven
 * weekdays 1-7, each appearing once — this is the invariant that guarantees
 * "all seven weekdays exist after setup, so absence never means closed"
 * (plan §7.2). Enforced again here defensively so a future caller of this
 * service can't skip it.
 */
export async function replaceWeeklySchedule(userId: number, businessProfileId: number, entries: ScheduleEntryInput[]) {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const weekdays = entries.map((e) => e.weekday);
  const uniqueWeekdays = new Set(weekdays);
  if (
    entries.length !== 7 ||
    uniqueWeekdays.size !== 7 ||
    weekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7)
  ) {
    throw new ApiError(400, "Schedule must contain exactly the seven weekdays 1-7, each exactly once");
  }

  // Upsert-per-weekday rather than delete-then-createMany: the domain is
  // fixed (exactly weekdays 1-7, enforced above), so there's never a stale
  // row to clean up, and this is safe under concurrent PUTs for the same
  // profile, unlike delete+recreate — where one writer's deleteMany can run
  // between another writer's deleteMany and createMany, and the second
  // writer's createMany then collides with the first writer's
  // already-committed rows under BusinessOperatingDay_profile_weekday_key
  // (a raw, unhandled 500 via errorHandler, since it has no P2002 case).
  //
  // Entries are upserted in a fixed (ascending-weekday) order regardless of
  // the order `entries` arrived in, and sequentially rather than via
  // Promise.all: two concurrent PUTs each touch the same seven rows, and
  // taking those per-row locks in a consistent order across both
  // transactions rules out a Postgres deadlock (40P01) that an inconsistent
  // order could otherwise introduce.
  const orderedEntries = [...entries].sort((a, b) => a.weekday - b.weekday);
  await prisma.$transaction(async (tx) => {
    for (const e of orderedEntries) {
      await tx.businessOperatingDay.upsert({
        where: { businessProfileId_weekday: { businessProfileId, weekday: e.weekday } },
        update: { isOpen: e.isOpen },
        create: { businessProfileId, weekday: e.weekday, isOpen: e.isOpen },
      });
    }
  });

  const days = await prisma.businessOperatingDay.findMany({
    where: { businessProfileId },
    orderBy: { weekday: "asc" },
  });
  return days.map(toScheduleDTO);
}

function toOverrideDTO(override: BusinessOperatingDayOverride) {
  return {
    id: override.id,
    businessProfileId: override.businessProfileId,
    date: override.date.toISOString().slice(0, 10),
    type: override.type,
    reason: override.reason,
  };
}

export interface OverrideListFilter {
  from?: string;
  to?: string;
}

export async function listOverrides(userId: number, businessProfileId: number, filter: OverrideListFilter) {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  let dateFilter: Prisma.BusinessOperatingDayOverrideWhereInput = {};
  if (filter.from || filter.to) {
    const from = filter.from ? new Date(`${filter.from}T00:00:00.000Z`) : undefined;
    const to = filter.to ? new Date(`${filter.to}T00:00:00.000Z`) : undefined;

    if (from && to) {
      if (to.getTime() < from.getTime()) {
        throw new ApiError(400, "`to` must not be before `from`");
      }
      const spanDays = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
      if (spanDays > MAX_OVERRIDE_RANGE_DAYS) {
        throw new ApiError(400, `Date range cannot exceed ${MAX_OVERRIDE_RANGE_DAYS} days`);
      }
    }

    dateFilter = {
      date: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
    };
  }

  const overrides = await prisma.businessOperatingDayOverride.findMany({
    where: { businessProfileId, ...dateFilter },
    orderBy: { date: "asc" },
  });
  return overrides.map(toOverrideDTO);
}

export interface CreateOverrideInput {
  date: string;
  type: OperatingDayOverrideType;
  reason?: string;
}

export async function createOverride(userId: number, businessProfileId: number, input: CreateOverrideInput) {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const date = new Date(`${input.date}T00:00:00.000Z`);

  try {
    const override = await prisma.businessOperatingDayOverride.create({
      data: {
        businessProfileId,
        date,
        type: input.type,
        reason: input.reason,
      },
    });
    return toOverrideDTO(override);
  } catch (err) {
    // Same translation convention as auth.service.ts's registration race and
    // csvImport.service.ts's duplicate-row handling: a raw P2002 from the
    // @@unique([businessProfileId, date]) constraint never reaches the client.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ApiError(409, "An override already exists for this date");
    }
    throw err;
  }
}

export async function deleteOverride(userId: number, businessProfileId: number, id: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const existing = await prisma.businessOperatingDayOverride.findFirst({
    where: { id, businessProfileId },
  });
  if (!existing) {
    throw new ApiError(404, "Operating day override not found");
  }

  await prisma.businessOperatingDayOverride.delete({ where: { id } });
}
