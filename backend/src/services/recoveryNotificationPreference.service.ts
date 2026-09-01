import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import type { RecoveryNotificationPreference } from "@prisma/client";

// Write/CRUD surface only, per docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md
// §7.5/§10.8/§11 Phase 6. The evaluation logic that actually fires
// notifications (reading these settings against live recovery-target state,
// respecting quiet hours and the cooldown window) belongs to a different
// service owned elsewhere in the codebase — this file only persists what the
// owner configured and returns it (or the effective defaults) back.

export const DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE = {
  targetIncreaseAlertEnabled: true,
  targetIncreaseThresholdPercent: 15,
  behindThreeDaysAlertEnabled: true,
  openDayNoSalesAlertEnabled: true,
  projectionShortfallAlertEnabled: true,
  coverageReachedAlertEnabled: true,
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
  minHoursBetweenNotifications: 24,
};

export type RecoveryNotificationPreferenceDTO = typeof DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE;

// `@db.Time(0)` columns round-trip through Prisma as `Date` objects anchored
// to the Unix epoch date — only the UTC time-of-day component is meaningful,
// so a fixed epoch date is used on the way in and stripped back out on the
// way out. Stored/compared as plain HH:MM wall-clock values; deliberately no
// timezone conversion here (the business-timezone interpretation is the
// consuming notification-evaluation service's job, not this persistence
// layer's).
function timeStringToDate(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

function dateToTimeString(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function toDTO(pref: RecoveryNotificationPreference): RecoveryNotificationPreferenceDTO {
  return {
    targetIncreaseAlertEnabled: pref.targetIncreaseAlertEnabled,
    targetIncreaseThresholdPercent: Number(pref.targetIncreaseThresholdPercent),
    behindThreeDaysAlertEnabled: pref.behindThreeDaysAlertEnabled,
    openDayNoSalesAlertEnabled: pref.openDayNoSalesAlertEnabled,
    projectionShortfallAlertEnabled: pref.projectionShortfallAlertEnabled,
    coverageReachedAlertEnabled: pref.coverageReachedAlertEnabled,
    quietHoursStart: pref.quietHoursStart ? dateToTimeString(pref.quietHoursStart) : null,
    quietHoursEnd: pref.quietHoursEnd ? dateToTimeString(pref.quietHoursEnd) : null,
    minHoursBetweenNotifications: pref.minHoursBetweenNotifications,
  };
}

export async function getRecoveryNotificationPreference(
  userId: number,
  businessProfileId: number,
): Promise<RecoveryNotificationPreferenceDTO> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const existing = await prisma.recoveryNotificationPreference.findUnique({
    where: { businessProfileId },
  });

  // Deliberately never auto-created here — GET returns what the defaults
  // WOULD be, and a row only ever comes into existence via an explicit PUT.
  return existing ? toDTO(existing) : { ...DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE };
}

export interface UpdateRecoveryNotificationPreferenceInput {
  targetIncreaseAlertEnabled?: boolean;
  targetIncreaseThresholdPercent?: number;
  behindThreeDaysAlertEnabled?: boolean;
  openDayNoSalesAlertEnabled?: boolean;
  projectionShortfallAlertEnabled?: boolean;
  coverageReachedAlertEnabled?: boolean;
  /** `undefined` = leave unchanged, `null` = clear, `"HH:MM"` = set. */
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  minHoursBetweenNotifications?: number;
}

export async function upsertRecoveryNotificationPreference(
  userId: number,
  businessProfileId: number,
  input: UpdateRecoveryNotificationPreferenceInput,
): Promise<RecoveryNotificationPreferenceDTO> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const existing = await prisma.recoveryNotificationPreference.findUnique({
    where: { businessProfileId },
  });
  const current = existing ? toDTO(existing) : DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE;

  const merged: RecoveryNotificationPreferenceDTO = {
    targetIncreaseAlertEnabled: input.targetIncreaseAlertEnabled ?? current.targetIncreaseAlertEnabled,
    targetIncreaseThresholdPercent: input.targetIncreaseThresholdPercent ?? current.targetIncreaseThresholdPercent,
    behindThreeDaysAlertEnabled: input.behindThreeDaysAlertEnabled ?? current.behindThreeDaysAlertEnabled,
    openDayNoSalesAlertEnabled: input.openDayNoSalesAlertEnabled ?? current.openDayNoSalesAlertEnabled,
    projectionShortfallAlertEnabled: input.projectionShortfallAlertEnabled ?? current.projectionShortfallAlertEnabled,
    coverageReachedAlertEnabled: input.coverageReachedAlertEnabled ?? current.coverageReachedAlertEnabled,
    quietHoursStart: "quietHoursStart" in input ? input.quietHoursStart ?? null : current.quietHoursStart,
    quietHoursEnd: "quietHoursEnd" in input ? input.quietHoursEnd ?? null : current.quietHoursEnd,
    minHoursBetweenNotifications: input.minHoursBetweenNotifications ?? current.minHoursBetweenNotifications,
  };

  // Both-or-neither, re-checked here against the MERGED result (not just the
  // partial payload) — a PUT that only touches quietHoursStart must still
  // leave the row in a valid both-set-or-both-null state, whatever the
  // pre-existing quietHoursEnd was.
  if ((merged.quietHoursStart === null) !== (merged.quietHoursEnd === null)) {
    throw new ApiError(400, "quietHoursStart and quietHoursEnd must be set together or not at all");
  }

  const saved = await prisma.recoveryNotificationPreference.upsert({
    where: { businessProfileId },
    create: {
      businessProfileId,
      targetIncreaseAlertEnabled: merged.targetIncreaseAlertEnabled,
      targetIncreaseThresholdPercent: merged.targetIncreaseThresholdPercent,
      behindThreeDaysAlertEnabled: merged.behindThreeDaysAlertEnabled,
      openDayNoSalesAlertEnabled: merged.openDayNoSalesAlertEnabled,
      projectionShortfallAlertEnabled: merged.projectionShortfallAlertEnabled,
      coverageReachedAlertEnabled: merged.coverageReachedAlertEnabled,
      quietHoursStart: merged.quietHoursStart ? timeStringToDate(merged.quietHoursStart) : null,
      quietHoursEnd: merged.quietHoursEnd ? timeStringToDate(merged.quietHoursEnd) : null,
      minHoursBetweenNotifications: merged.minHoursBetweenNotifications,
    },
    update: {
      targetIncreaseAlertEnabled: merged.targetIncreaseAlertEnabled,
      targetIncreaseThresholdPercent: merged.targetIncreaseThresholdPercent,
      behindThreeDaysAlertEnabled: merged.behindThreeDaysAlertEnabled,
      openDayNoSalesAlertEnabled: merged.openDayNoSalesAlertEnabled,
      projectionShortfallAlertEnabled: merged.projectionShortfallAlertEnabled,
      coverageReachedAlertEnabled: merged.coverageReachedAlertEnabled,
      quietHoursStart: merged.quietHoursStart ? timeStringToDate(merged.quietHoursStart) : null,
      quietHoursEnd: merged.quietHoursEnd ? timeStringToDate(merged.quietHoursEnd) : null,
      minHoursBetweenNotifications: merged.minHoursBetweenNotifications,
    },
  });

  return toDTO(saved);
}
