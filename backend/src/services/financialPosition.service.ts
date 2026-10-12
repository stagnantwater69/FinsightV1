import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { resolveBusinessToday, utcDateKey, utcEndOfDay, utcStartOfMonth } from "../lib/dates";
import {
  requireOwnedBusinessContext,
  type OwnedBusinessContext,
} from "./ownedBusinessContext.service";

type FinancialDb = Prisma.TransactionClient | typeof prisma;

const FINAL_EXPENSE_SOURCE = {
  OR: [
    { source: "MANUAL_ENTRY" },
    {
      source: "CSV_UPLOAD",
      importBatch: { is: { processingStatus: "COMPLETE" } },
    },
    {
      source: "RECEIPT_SCAN",
      receiptScan: { is: { confirmationStatus: "Confirmed" } },
    },
  ],
} satisfies Prisma.ExpenseRecordWhereInput;

const FINAL_SALES_SOURCE = {
  OR: [
    { source: "MANUAL_ENTRY" },
    {
      source: "CSV_UPLOAD",
      importBatch: { is: { processingStatus: "COMPLETE" } },
    },
  ],
} satisfies Prisma.SalesReferenceRecordWhereInput;

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function previousMonthStart(targetMonth: Date): Date {
  return new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 1, 1));
}

export interface AvailableFundsCalculation {
  calculatedAmount: number;
  baselineAmount: number;
  baselineAt: string;
  baselineDate: string;
  confirmedSalesAdded: number;
  confirmedExpensesDeducted: number;
  confirmedSalesRecordCount: number;
  confirmedExpenseRecordCount: number;
  asOfDate: string;
}

export type MonthlyExpenseBasis = {
  amount: number;
  source: "owner_estimate" | "previous_complete_month";
  sourceMonth: string | null;
  ownerEstimate: number;
  recordsCompleteThroughMonth: string | null;
  recordsCompleteThroughConfirmedAt: string | null;
  eligibleRecordCount: number;
};

export interface FinancialPosition {
  asOfDate: string;
  availableFunds: AvailableFundsCalculation;
  monthlyExpenseBasis: MonthlyExpenseBasis;
}

/**
 * Computes the recorded balance without mutating the owner's baseline.
 * Baseline-day rows use their explicit anchor classification; null pairs are
 * the legacy fallback retained for rows created before that contract existed.
 */
export async function calculateAvailableFundsForOwnedBusiness(
  context: OwnedBusinessContext,
  asOfDate: Date,
  db: FinancialDb = prisma,
): Promise<AvailableFundsCalculation> {
  const { profile } = context;
  const commonWindow = {
    businessProfileId: profile.id,
    reviewStatus: "Reviewed",
    duplicateStatus: "Not a Duplicate",
    duplicateOfRecordId: null,
    date: {
      gte: profile.availableFundsBaselineDate,
      lte: utcEndOfDay(asOfDate),
    },
  } as const;
  const deltaWindow = {
    OR: [
      { date: { gt: profile.availableFundsBaselineDate } },
      {
        date: profile.availableFundsBaselineDate,
        OR: [
          {
            includedInAvailableFundsBaseline: false,
            availableFundsDeltaBaselineAt: profile.availableFundsBaselineAt,
          },
          {
            includedInAvailableFundsBaseline: null,
            availableFundsDeltaBaselineAt: null,
            createdAt: { gt: profile.availableFundsBaselineAt },
          },
        ],
      },
    ],
  };

  const [sales, expenses] = await Promise.all([
    db.salesReferenceRecord.aggregate({
      where: { ...commonWindow, AND: [deltaWindow], ...FINAL_SALES_SOURCE },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.expenseRecord.aggregate({
      where: { ...commonWindow, AND: [deltaWindow], ...FINAL_EXPENSE_SOURCE },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const baselineAmount = new Prisma.Decimal(profile.availableFunds);
  const confirmedSalesAdded = sales._sum.amount ?? new Prisma.Decimal(0);
  const confirmedExpensesDeducted = expenses._sum.amount ?? new Prisma.Decimal(0);

  return {
    calculatedAmount: Number(baselineAmount.add(confirmedSalesAdded).sub(confirmedExpensesDeducted)),
    baselineAmount: Number(baselineAmount),
    baselineAt: profile.availableFundsBaselineAt.toISOString(),
    baselineDate: utcDateKey(profile.availableFundsBaselineDate),
    confirmedSalesAdded: Number(confirmedSalesAdded),
    confirmedExpensesDeducted: Number(confirmedExpensesDeducted),
    confirmedSalesRecordCount: sales._count._all,
    confirmedExpenseRecordCount: expenses._count._all,
    asOfDate: utcDateKey(asOfDate),
  };
}

/**
 * A completed marker makes exactly the preceding month authoritative for a
 * target month. A zero total remains record-derived rather than falling back.
 */
export async function resolveMonthlyExpenseBasisForOwnedBusiness(
  context: OwnedBusinessContext,
  targetMonth: Date,
  db: FinancialDb = prisma,
): Promise<MonthlyExpenseBasis> {
  const { profile } = context;
  const normalizedTargetMonth = utcStartOfMonth(targetMonth);
  const sourceMonth = previousMonthStart(normalizedTargetMonth);
  const completeThrough = profile.expenseRecordsCompleteThroughMonth;
  const canUseRecords = completeThrough !== null && sourceMonth <= completeThrough;

  const common = {
    ownerEstimate: Number(profile.expectedMonthlyExpenses),
    recordsCompleteThroughMonth: completeThrough ? monthKey(completeThrough) : null,
    recordsCompleteThroughConfirmedAt:
      profile.expenseRecordsCompleteThroughConfirmedAt?.toISOString() ?? null,
  };

  if (!canUseRecords) {
    return {
      amount: common.ownerEstimate,
      source: "owner_estimate",
      sourceMonth: null,
      eligibleRecordCount: 0,
      ...common,
    };
  }

  const expenses = await db.expenseRecord.aggregate({
    where: {
      businessProfileId: profile.id,
      reviewStatus: "Reviewed",
      duplicateStatus: "Not a Duplicate",
      duplicateOfRecordId: null,
      date: { gte: sourceMonth, lt: normalizedTargetMonth },
      ...FINAL_EXPENSE_SOURCE,
    },
    _sum: { amount: true },
    _count: { _all: true },
  });

  return {
    amount: Number(expenses._sum.amount ?? 0),
    source: "previous_complete_month",
    sourceMonth: monthKey(sourceMonth),
    eligibleRecordCount: expenses._count._all,
    ...common,
  };
}

export async function getFinancialPositionForOwnedBusiness(
  context: OwnedBusinessContext,
  now: Date = new Date(),
  db: FinancialDb = prisma,
): Promise<FinancialPosition> {
  const asOfDate = resolveBusinessToday(context.profile.timezone, now);
  const targetMonth = utcStartOfMonth(asOfDate);
  const [availableFunds, monthlyExpenseBasis] = await Promise.all([
    calculateAvailableFundsForOwnedBusiness(context, asOfDate, db),
    resolveMonthlyExpenseBasisForOwnedBusiness(context, targetMonth, db),
  ]);

  return {
    asOfDate: utcDateKey(asOfDate),
    availableFunds,
    monthlyExpenseBasis,
  };
}

export async function getFinancialPosition(
  userId: number,
  businessProfileId: number,
  now: Date = new Date(),
): Promise<FinancialPosition> {
  const context = await requireOwnedBusinessContext(userId, businessProfileId);
  return getFinancialPositionForOwnedBusiness(context, now);
}
