import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import * as fixtures from './support/fixtures';
import type { DashboardExpenseOverview } from '../../src/lib/expenseOverview';
import type { DashboardSummary, ReductionOpportunity } from '../../src/lib/types';

const apiGet = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Something went wrong.',
}));

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ preferences: { showDashboardMascotMessage: false } }),
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    selected: fixtures.businessProfile,
    profiles: [fixtures.businessProfile],
    categories: fixtures.categories,
    error: null,
    refresh: vi.fn(),
    selectProfile: vi.fn(),
  }),
}));

vi.mock('../../src/context/ReportingPeriodContext', () => ({
  ReportingPeriodScope: ({ children }: { children: React.ReactNode }) => children,
  useReportingPeriod: () => ({
    selection: { kind: 'month', month: '2026-08' },
    setSelection: vi.fn(),
    ready: true,
  }),
}));

vi.mock('../../src/context/TourContext', () => ({ useTourHomeStage: vi.fn() }));
vi.mock('../../src/components/tour/targets', () => ({
  useTourScrollView: () => ({}),
  useTourTarget: () => ({}),
}));
vi.mock('../../src/components/HomeHeader', () => ({ HomeHeader: () => null }));
vi.mock('../../src/components/GreetingHero', () => ({ GreetingHero: () => null }));
vi.mock('../../src/components/PeriodSelector', () => ({ PeriodSelector: () => null }));
vi.mock('../../src/components/AskFinSight', () => ({ AskFinSight: () => null }));
vi.mock('../../src/components/AskFinSightFab', () => ({
  AskFinSightFab: () => null,
  FAB_CLEARANCE: 0,
}));
vi.mock('../../src/components/charts', () => ({
  CashflowChart: ({ data }: { data: unknown[] }) => <Text>{`Cashflow points: ${data.length}`}</Text>,
}));
vi.mock('../../src/components/SpendingBreakdownCard', () => ({ SpendingBreakdownCard: () => null }));

const { DashboardScreen } = await import('../../src/screens/DashboardScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const {
  beginServerStateSession,
  clearServerStateCache,
  invalidateServerState,
} = await import('../../src/lib/serverStateCache');

const navigation = { navigate: vi.fn() };

const summary: DashboardSummary = {
  periodDays: 31,
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  overview: { availableFunds: 5000, totalExpenses: 2000, totalSalesReference: 7000 },
  expenseCategoryBreakdown: [
    { categoryId: 10, categoryName: 'Stock', total: 2000, percent: 100 },
  ],
  recoveryStatus: {
    expectedMonthlyExpenses: 30000,
    operatingDays: 26,
    dailyNeededTarget: 1000,
    salesThisMonth: 10000,
    remainingTarget: 20000,
    daysInMonth: 31,
    calendarDaysLeftInMonth: 10,
    remainingOperatingDays: 8,
    remainingOperatingDaysIsApproximated: false,
    adjustedDailyTarget: 2500,
    todaysTarget: 1000,
    todaysSales: 1200,
    todaysGap: 0,
    todaysStatus: 'above',
    monthCoveragePercent: 33,
    onTrack: true,
    status: 'on_pace',
  },
  recordsNeedingReview: 0,
  alerts: [],
  lifetime: { recordCount: 2, latestRecordDate: '2026-08-20' },
};

const recordDerivedZeroSummary: DashboardSummary = {
  ...summary,
  overview: {
    ...summary.overview,
    availableFunds: 7200,
    availableFundsCalculation: {
      calculatedAmount: 7200,
      baselineAmount: 5000,
      baselineAt: '2026-08-01T00:00:00.000Z',
      baselineDate: '2026-08-01',
      confirmedSalesAdded: 3000,
      confirmedExpensesDeducted: 800,
      confirmedSalesRecordCount: 2,
      confirmedExpenseRecordCount: 1,
      asOfDate: '2026-10-15',
    },
  },
  recoveryStatus: {
    ...summary.recoveryStatus,
    expectedMonthlyExpenses: 0,
    monthlyExpenseBasis: {
      amount: 0,
      source: 'previous_complete_month',
      sourceMonth: '2026-09',
      ownerEstimate: 30000,
      eligibleRecordCount: 0,
      recordsCompleteThroughMonth: '2026-09',
      recordsCompleteThroughConfirmedAt: '2026-10-01T04:00:00.000Z',
    },
    dailyNeededTarget: 0,
    remainingTarget: 0,
    adjustedDailyTarget: 0,
    todaysTarget: 0,
    todaysGap: 1200,
    monthCoveragePercent: 0,
    needsSetup: false,
    onTrack: true,
    status: 'covered',
    contractVersion: 2,
  },
};

const opportunity: ReductionOpportunity = {
  id: 'dashboard-opportunity',
  type: 'CATEGORY_PRESSURE',
  categoryId: 10,
  categoryName: 'Stock',
  priority: 'high',
  confidence: 'strong',
  observation: 'Stock costs rose against the previous period.',
  rationale: 'Stock accounts for most expenses in this period.',
  evidence: {
    currentAmount: 2000,
    previousAmount: 1500,
    changeAmount: 500,
    changePercent: 33,
    expenseSharePercent: 100,
    recordCount: 2,
    unusualRecordCount: 0,
    possibleDuplicateCount: 0,
  },
  costBehavior: 'variable',
  suggestedChecks: [],
  relatedRecordIds: [1, 2],
  limitations: [],
};

const overview: DashboardExpenseOverview = {
  view: 'dashboard',
  comparison: {
    status: 'available',
    data: { totals: { current: 2000, previous: 1500 }, categoryTrends: [] },
  },
  topOpportunity: { status: 'available', data: opportunity },
};

beforeEach(() => {
  clearServerStateCache();
  apiGet.mockReset();
  navigation.navigate.mockReset();
});

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe('Dashboard cached overview refresh', () => {
  it('keeps the opportunity visible and names the failed refresh', async () => {
    beginServerStateSession('dashboard-refresh');
    let failOverview = false;
    apiGet.mockImplementation((path: string) => {
      if (path === '/dashboard/summary') return Promise.resolve(summary);
      if (path === '/insights/expense-overview') {
        return failOverview
          ? Promise.reject(new Error('Could not refresh expense opportunities.'))
          : Promise.resolve(overview);
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const queries = await render(
      <ThemeProvider initialMode="light">
        <DashboardScreen navigation={navigation} />
      </ThemeProvider>,
    );

    const opportunityCard = await queries.findByRole('button', {
      name: /Reduction opportunity: Stock/,
    });
    failOverview = true;
    invalidateServerState({ pathPrefixes: ['/insights/expense-overview'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(opportunityCard).toBeTruthy();
    expect(queries.getByRole('button', { name: /Reduction opportunity: Stock/ })).toBeTruthy();
  });

  it('keeps the cached cashflow chart visible and names its failed refresh', async () => {
    beginServerStateSession('dashboard-cashflow-refresh');
    let failCashflow = false;
    apiGet.mockImplementation((path: string) => {
      if (path === '/dashboard/summary') return Promise.resolve(summary);
      if (path === '/insights/expense-overview') return Promise.resolve(overview);
      if (path === '/dashboard/cashflow') {
        return failCashflow
          ? Promise.reject(new Error('Could not refresh cashflow details.'))
          : Promise.resolve({
              granularity: 'daily',
              points: [
                { date: '2026-08-20', sales: 900, expenses: 400 },
                { date: '2026-08-21', sales: 1200, expenses: 600 },
              ],
            });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const queries = await render(
      <ThemeProvider initialMode="light">
        <DashboardScreen navigation={navigation} />
      </ThemeProvider>,
    );

    await queries.findByRole('button', { name: /Reduction opportunity: Stock/ });
    await fireEvent.press(queries.getByRole('button', { name: 'View detailed charts' }));
    expect(await queries.findByText('Cashflow points: 2')).toBeTruthy();

    failCashflow = true;
    invalidateServerState({ pathPrefixes: ['/dashboard/cashflow'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText('Cashflow points: 2')).toBeTruthy();
  });
});

describe('Dashboard record-derived financial figures', () => {
  it('keeps a confirmed zero-expense month valid and shows both provenance trails', async () => {
    beginServerStateSession('dashboard-record-derived-zero');
    apiGet.mockImplementation((path: string) => {
      if (path === '/dashboard/summary') return Promise.resolve(recordDerivedZeroSummary);
      if (path === '/insights/expense-overview') return Promise.resolve(overview);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const queries = await render(
      <ThemeProvider initialMode="light">
        <DashboardScreen navigation={navigation} />
      </ThemeProvider>,
    );

    expect(await queries.findByText('Target reached')).toBeTruthy();
    expect(queries.getByText('Monthly expense coverage')).toBeTruthy();
    expect(queries.getByText('0%')).toBeTruthy();
    expect(
      queries.getByText('Using 0 eligible expense records from September 2026.'),
    ).toBeTruthy();
    expect(
      queries.getByText(
        'Started at PHP 5,000 on Aug 1, 2026. Added PHP 3,000 from 2 confirmed sales. Deducted PHP 800 from 1 confirmed expense.',
      ),
    ).toBeTruthy();
    expect(
      queries.queryByText(
        'Add a starting monthly expense estimate to calculate a daily sales target and recovery pace.',
      ),
    ).toBeNull();

    const action = queries.getByRole('button', { name: 'View recovery plan' });
    await fireEvent.press(action);
    expect(navigation.navigate).toHaveBeenCalledWith('Insights', { screen: 'RecoveryTarget' });
  });
});
