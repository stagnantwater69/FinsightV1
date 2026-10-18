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
vi.mock('../../src/components/HomeHeader', () => ({
  HomeHeader: ({ unreadCount }: { unreadCount: number }) => <Text>{`Unread alerts: ${unreadCount}`}</Text>,
}));
vi.mock('../../src/components/GreetingHero', () => ({ GreetingHero: () => null }));
vi.mock('../../src/components/PeriodSelector', () => ({ PeriodSelector: () => null, PeriodPill: () => null, PeriodStatus: () => null }));
// RecordCard (Recent records on Home) swipes; the harness has no native gesture module.
vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../src/components/AskFinSight', () => ({ AskFinSight: () => null }));
vi.mock('../../src/components/AskFinSightFab', () => ({
  AskFinSightFab: () => null,
  FAB_CLEARANCE: 0,
}));
vi.mock('../../src/components/charts', () => ({
  CashflowChart: ({ data }: { data: unknown[] }) => <Text>{`Cashflow points: ${data.length}`}</Text>,
  CategoryComparison: () => null,
}));

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
  unreadAlertCount: 0,
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

describe('Dashboard unread badge', () => {
  const alert = (id: number) => ({
    id, businessProfileId: 1, expenseRecordId: null, type: 'Needs Review',
    message: `Alert ${id}`, dateCreated: '2026-08-20T00:00:00.000Z', readStatus: false,
  });

  function serve(dashboard: unknown) {
    apiGet.mockImplementation((path: string) => {
      if (path === '/dashboard/summary') return Promise.resolve(dashboard);
      if (path === '/insights/expense-overview') return Promise.resolve(overview);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  }

  it("shows the server's unread total, not the ten alerts it sent", async () => {
    // The ten newest are read; four older unread alerts sit outside the list.
    serve({ ...summary, alerts: Array.from({ length: 10 }, (_, i) => ({ ...alert(i + 1), readStatus: true })), unreadAlertCount: 4 });
    const queries = await render(
      <ThemeProvider initialMode="light"><DashboardScreen navigation={navigation} /></ThemeProvider>,
    );

    expect(await queries.findByText('Unread alerts: 4')).toBeTruthy();
  });

  it('counts the alert rows when a cached summary has no total', async () => {
    const { unreadAlertCount: _omitted, ...older } = summary;
    serve({ ...older, alerts: [alert(1), alert(2)] });
    const queries = await render(
      <ThemeProvider initialMode="light"><DashboardScreen navigation={navigation} /></ThemeProvider>,
    );

    expect(await queries.findByText('Unread alerts: 2')).toBeTruthy();
  });
});

describe('Dashboard cached overview refresh', () => {
  it('opens flagged review with a Dashboard origin and a retained RecordsList base', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/dashboard/summary') return Promise.resolve({ ...summary, recordsNeedingReview: 3 });
      if (path === '/insights/expense-overview') return Promise.resolve(overview);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await render(
      <ThemeProvider initialMode="light"><DashboardScreen navigation={navigation} /></ThemeProvider>,
    );
    await fireEvent.press(await queries.findByRole('button', { name: '3 to review' }));
    expect(navigation.navigate).toHaveBeenLastCalledWith('Records', {
      screen: 'FlaggedRecords', initial: false, params: { from: 'Dashboard' },
    });
  });

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
      name: 'Save on Stock',
    });
    failOverview = true;
    invalidateServerState({ pathPrefixes: ['/insights/expense-overview'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(opportunityCard).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Save on Stock' })).toBeTruthy();
  });

  it('shows one "Where it went" card in place of More charts, linking to the trend screens', async () => {
    beginServerStateSession('dashboard-where-it-went');
    navigation.navigate.mockReset();
    apiGet.mockImplementation((path: string) => {
      if (path === '/dashboard/summary') return Promise.resolve(summary);
      if (path === '/insights/expense-overview') return Promise.resolve(overview);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const queries = await render(
      <ThemeProvider initialMode="light">
        <DashboardScreen navigation={navigation} />
      </ThemeProvider>,
    );

    await queries.findByRole('button', { name: 'Save on Stock' });
    expect(queries.queryByRole('button', { name: 'More charts' })).toBeNull();
    // Home no longer loads the cashflow series; its own screen does.
    expect(apiGet.mock.calls.some((call) => call[0] === '/dashboard/cashflow')).toBe(false);
    expect(queries.getByText('Where it went')).toBeTruthy();
    await fireEvent.press(queries.getByRole('link', { name: 'Money in and out' }));
    expect(navigation.navigate).toHaveBeenCalledWith('MoneyFlow');
    await fireEvent.press(queries.getByRole('link', { name: 'Spending trends' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Insights', { screen: 'ExpenseBehavior' });
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
    expect(queries.getByRole('progressbar', { name: 'Monthly expenses covered by sales' })).toBeTruthy();
    expect(queries.getByText('0%')).toBeTruthy();
    // Both explanations are one tap away rather than paragraphs on Home.
    await fireEvent.press(queries.getByRole('button', { name: 'How the monthly target is worked out' }));
    await fireEvent.press(queries.getByRole('button', { name: 'How available funds are worked out' }));
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

it('binds the dashboard view to its own reporting period scope', () => {
  const wrapper = DashboardScreen({});
  expect(wrapper.props.scope).toBe('dashboard');
  expect(typeof wrapper.props.children.type).toBe('function');
});
