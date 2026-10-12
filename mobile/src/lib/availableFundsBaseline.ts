import type { BusinessProfile } from "./types";

export type AvailableFundsBaselineDecision = boolean | null;

export interface AvailableFundsBaselineRequest {
  includedInAvailableFundsBaseline: boolean;
  availableFundsBaselineAt: string;
}

type BaselineProfile = Pick<
  BusinessProfile,
  "availableFundsBaselineAt" | "availableFundsBaselineDate"
>;

export function needsAvailableFundsBaselineDecision(
  profile: BaselineProfile | null | undefined,
  transactionDate: string,
): boolean {
  return Boolean(
    profile?.availableFundsBaselineAt
      && profile.availableFundsBaselineDate
      && transactionDate === profile.availableFundsBaselineDate,
  );
}

export function availableFundsBaselineRequest(
  profile: BaselineProfile | null | undefined,
  transactionDate: string,
  decision: AvailableFundsBaselineDecision,
): AvailableFundsBaselineRequest | Record<string, never> {
  if (!needsAvailableFundsBaselineDecision(profile, transactionDate)) return {};
  if (decision === null || !profile?.availableFundsBaselineAt) {
    throw new Error("Choose whether this transaction was already included in the recorded balance.");
  }
  return {
    includedInAvailableFundsBaseline: decision,
    availableFundsBaselineAt: profile.availableFundsBaselineAt,
  };
}

export function isAvailableFundsBaselineRecoveryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const directCode = (error as { code?: unknown }).code;
  const responseCode = (error as { response?: { data?: { code?: unknown } } }).response?.data?.code;
  return directCode === "AVAILABLE_FUNDS_BASELINE_CHANGED"
    || directCode === "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED"
    || directCode === "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE"
    || responseCode === "AVAILABLE_FUNDS_BASELINE_CHANGED"
    || responseCode === "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED"
    || responseCode === "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE";
}
