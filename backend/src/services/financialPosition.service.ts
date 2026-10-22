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

/** The rows recorded on the baseline day that count: their explicit anchor classification, or the legacy fallback. */
function baselineDayDelta(profile: OwnedBusinessContext["profile"]) {
  return {
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
  };
}

const COUNTED = {
  reviewStatus: "Reviewed",
  duplicateStatus: "Not a Duplicate",
  duplicateOfRecordId: null,
} as const;

function calculation(
  profile: OwnedBusinessContext["profile"],
  asOfDate: Date,
  sales: { amount: Prisma.Decimal; count: number },
  expenses: { amount: Prisma.Decimal; count: number },
): AvailableFundsCalculation {
  const baselineAmount = new Prisma.Decimal(profile.availableFunds);
  return {
    calculatedAmount: Number(baselineAmount.add(sales.amount).sub(expenses.amount)),
    baselineAmount: Number(baselineAmount),
    baselineAt: profile.availableFundsBaselineAt.toISOString(),
    baselineDate: utcDateKey(profile.availableFundsBaselineDate),
    confirmedSalesAdded: Number(sales.amount),
    confirmedExpensesDeducted: Number(expenses.amount),
    confirmedSalesRecordCount: sales.count,
    confirmedExpenseRecordCount: expenses.count,
    asOfDate: utcDateKey(asOfDate),
  };
}

/**
 * Computes the recorded balance without mutating the owner's baseline.
 *
 * Days after the baseline day come from AvailableFundsDailyTotal, which the
 * database keeps current on every write (see the model in schema.prisma), so
 * the cost follows the number of days since the baseline, not the number of
 * records. Summing every record since the baseline cost ~250 ms at 500,000
 * records. The baseline day itself is still read record by record: whether a
 * row on that day counts depends on the baseline's own timestamp, which the
 * daily totals cannot know.
 *
 * calculateAvailableFundsFromRecords is the same figure computed directly; the
 * tests hold the two equal.
 */
export async function calculateAvailableFundsForOwnedBusiness(
  context: OwnedBusinessContext,
  asOfDate: Date,
  db: FinancialDb = prisma,
): Promise<AvailableFundsCalculation> {
  const { profile } = context;
  const baselineCounts = profile.availableFundsBaselineDate <= asOfDate;
  const [days, baselineSales, baselineExpenses] = await Promise.all([
    db.availableFundsDailyTotal.aggregate({
      where: {
        businessProfileId: profile.id,
        date: { gt: profile.availableFundsBaselineDate, lte: utcEndOfDay(asOfDate) },
      },
      _sum: { salesAmount: true, salesCount: true, expenseAmount: true, expenseCount: true },
    }),
    baselineCounts
      ? db.salesReferenceRecord.aggregate({
          where: { businessProfileId: profile.id, ...COUNTED, AND: [baselineDayDelta(profile)], ...FINAL_SALES_SOURCE },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : null,
    baselineCounts
      ? db.expenseRecord.aggregate({
          where: { businessProfileId: profile.id, ...COUNTED, AND: [baselineDayDelta(profile)], ...FINAL_EXPENSE_SOURCE },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : null,
  ]);

  const zero = new Prisma.Decimal(0);
  return calculation(
    profile,
    asOfDate,
    {
      amount: (days._sum.salesAmount ?? zero).add(baselineSales?._sum.amount ?? zero),
      count: (days._sum.salesCount ?? 0) + (baselineSales?._count._all ?? 0),
    },
    {
      amount: (days._sum.expenseAmount ?? zero).add(baselineExpenses?._sum.amount ?? zero),
      count: (days._sum.expenseCount ?? 0) + (baselineExpenses?._count._all ?? 0),
    },
  );
}

/**
 * The same balance summed record by record, the definition the daily totals
 * must agree with. Not for request paths: its cost grows with every record
 * since the baseline. Used by the tests and the reconciliation check.
 */
export async function calculateAvailableFundsFromRecords(
  context: OwnedBusinessContext,
  asOfDate: Date,
  db: FinancialDb = prisma,
): Promise<AvailableFundsCalculation> {
  const { profile } = context;
  const window = {
    businessProfileId: profile.id,
    ...COUNTED,
    date: {
      gte: profile.availableFundsBaselineDate,
      lte: utcEndOfDay(asOfDate),
    },
  } as const;
  const deltaWindow = {
    OR: [{ date: { gt: profile.availableFundsBaselineDate } }, baselineDayDelta(profile)],
  };

  const [sales, expenses] = await Promise.all([
    db.salesReferenceRecord.aggregate({
      where: { ...window, AND: [deltaWindow], ...FINAL_SALES_SOURCE },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.expenseRecord.aggregate({
      where: { ...window, AND: [deltaWindow], ...FINAL_EXPENSE_SOURCE },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const zero = new Prisma.Decimal(0);
  return calculation(
    profile,
    asOfDate,
    { amount: sales._sum.amount ?? zero, count: sales._count._all },
    { amount: expenses._sum.amount ?? zero, count: expenses._count._all },
  );
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
