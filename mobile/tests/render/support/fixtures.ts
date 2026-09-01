import type {
  BusinessProfile,
  ExpenseCategory,
  PurchasePriceContext,
  PurchaseReview,
  SpendingImpact,
} from '../../../src/lib/types';

export const businessProfile = {
  id: 1,
  name: 'Aling Nena Sari-Sari',
  type: 'retail',
  archivedAt: null,
} as unknown as BusinessProfile;

export const categories = [
  { id: 10, name: 'Stock' },
  { id: 11, name: 'Utilities' },
] as unknown as ExpenseCategory[];

/**
 * A high-impact scenario: ₱11,000 against ₱13,095 of available funds, which is
 * 84.0% and over the owner's 30% threshold.
 */
export const highImpact: SpendingImpact = {
  periodDays: 30,
  periodStart: '2026-07-27',
  periodEnd: '2026-08-26',
  plannedAmount: 11000,
  thresholdPercent: 30,
  thresholdAmount: 3928.5,
  percentOfFunds: 84,
  impactBand: 'High Impact',
  exceedsFunds: false,
  funds: { before: 13095, after: 2095 },
  periodExpenses: { before: 8400, after: 19400 },
  availableFunds: 13095,
  resultingFunds: 2095,
} as unknown as SpendingImpact;

export const lowImpact: SpendingImpact = {
  ...highImpact,
  plannedAmount: 500,
  percentOfFunds: 3.8,
  impactBand: 'Low Impact',
  funds: { before: 13095, after: 12595 },
  periodExpenses: { before: 8400, after: 8900 },
  resultingFunds: 12595,
} as unknown as SpendingImpact;

/**
 * Price context is counted from the owner's own records, never written by the
 * model — which is exactly why it has to survive the AI being unreachable.
 */
export const priceContext: PurchasePriceContext = {
  categoryId: 10,
  categoryName: 'Stock',
  recordCount: 6,
  typicalAmount: 9200,
  smallestAmount: 7800,
  largestAmount: 12400,
  multipleOfTypical: 1.2,
  comparison: 'higher',
  similar: [
    { description: 'Chest freezer', amount: 9400, date: '2026-05-02' },
    { description: 'Second-hand chiller', amount: 8800, date: '2026-02-18' },
  ],
  windowDays: 365,
} as unknown as PurchasePriceContext;

export const purchaseReview = {
  summary: 'A display fridge is equipment the business keeps and uses.',
  kind: 'asset',
  questions: ['Where will it sit?', 'What does it cost to run each month?'],
} as unknown as PurchaseReview;
