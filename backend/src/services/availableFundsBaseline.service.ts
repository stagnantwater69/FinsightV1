import type { BusinessProfile, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { utcDateKey } from "../lib/dates";
import { ApiError } from "../middleware/error.middleware";

type BaselineDb = Prisma.TransactionClient | typeof prisma;

export interface AvailableFundsBaselineInput {
  includedInAvailableFundsBaseline?: boolean;
  availableFundsBaselineAt?: string;
}

export interface StoredAvailableFundsClassification {
  includedInAvailableFundsBaseline: boolean | null;
  availableFundsDeltaBaselineAt: Date | null;
}

type BaselineProfile = Pick<
  BusinessProfile,
  "availableFundsBaselineAt" | "availableFundsBaselineDate"
>;

type ExistingClassification = StoredAvailableFundsClassification & {
  date: Date;
};

const REQUIRED_MESSAGE =
  "Choose whether this transaction was already included in the recorded available funds";
const CHANGED_MESSAGE =
  "Available funds baseline changed; review this transaction again";

export async function loadAvailableFundsBaseline(
  db: BaselineDb,
  businessProfileId: number,
): Promise<BaselineProfile> {
  return db.businessProfile.findUniqueOrThrow({
    where: { id: businessProfileId },
    select: {
      availableFundsBaselineAt: true,
      availableFundsBaselineDate: true,
    },
  });
}

export function resolveAvailableFundsClassification(
  profile: BaselineProfile,
  transactionDate: Date,
  input: AvailableFundsBaselineInput,
  existing?: ExistingClassification,
): StoredAvailableFundsClassification {
  const hasIncluded = input.includedInAvailableFundsBaseline !== undefined;
  const hasBaselineAt = input.availableFundsBaselineAt !== undefined;
  if (hasIncluded !== hasBaselineAt) {
    throw new ApiError(400, REQUIRED_MESSAGE, {
      code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED",
    });
  }

  if (hasIncluded) {
    const suppliedBaselineAt = new Date(input.availableFundsBaselineAt!);
    if (!Number.isFinite(suppliedBaselineAt.getTime())) {
      throw new ApiError(400, "availableFundsBaselineAt must be a valid ISO timestamp", {
        code: "AVAILABLE_FUNDS_BASELINE_INVALID",
      });
    }
    if (suppliedBaselineAt.getTime() !== profile.availableFundsBaselineAt.getTime()) {
      throw new ApiError(409, CHANGED_MESSAGE, {
        code: "AVAILABLE_FUNDS_BASELINE_CHANGED",
      });
    }
  }

  const baselineDate = utcDateKey(profile.availableFundsBaselineDate);
  const recordDate = utcDateKey(transactionDate);
  if (recordDate !== baselineDate) {
    if (hasIncluded) {
      throw new ApiError(
        400,
        "Available funds baseline classification only applies to transactions on the balance date",
        { code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE" },
      );
    }
    if (existing && utcDateKey(existing.date) === recordDate) {
      return {
        includedInAvailableFundsBaseline: existing.includedInAvailableFundsBaseline,
        availableFundsDeltaBaselineAt: existing.availableFundsDeltaBaselineAt,
      };
    }
    return {
      includedInAvailableFundsBaseline: null,
      availableFundsDeltaBaselineAt: null,
    };
  }

  if (!hasIncluded) {
    const canPreserveExisting = existing
      && utcDateKey(existing.date) === recordDate
      && existing.includedInAvailableFundsBaseline !== null
      && existing.availableFundsDeltaBaselineAt?.getTime()
        === profile.availableFundsBaselineAt.getTime();
    if (canPreserveExisting) {
      return {
        includedInAvailableFundsBaseline: existing.includedInAvailableFundsBaseline,
        availableFundsDeltaBaselineAt: existing.availableFundsDeltaBaselineAt,
      };
    }
    throw new ApiError(400, REQUIRED_MESSAGE, {
      code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED",
    });
  }

  return {
    includedInAvailableFundsBaseline: input.includedInAvailableFundsBaseline!,
    availableFundsDeltaBaselineAt: profile.availableFundsBaselineAt,
  };
}
