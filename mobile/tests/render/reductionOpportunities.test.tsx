import { testScreen } from './support/screen';
import React from 'react';
import { Dimensions, Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor, fireEvent } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import { chartReadout, hoverChart, tapChart } from './support/chartInteractions';
import { REDUCTION_OPPORTUNITY_QUESTION } from '../../src/lib/reductionOpportunityAsk';
import type { DetailExpenseOverview } from '../../src/lib/expenseOverview';
import type { AnomalyFinding, CategoryTrend, ExpenseBehavior, RecordItem, RecurringPattern, RecurringSchedule, ReductionOpportunity, ReductionOpportunityResponse, ReductionSimulation } from '../../src/lib/types';

/**
 * Rendered coverage for the "Reduction opportunities" section on Expense
 * insight — Expense Reduction Opportunities plan §14.3.
 *
 * Mirrors render/spendingImpact.test.tsx's mocking shape: the business
 * profile and Ask FinSight surfaces are stubbed so a query for one card or
 * progressbar stays unambiguous, and `api.get` is routed by path since this
 * screen loads the shared expense-overview envelope alongside the independent
 * findings, recurring-pattern, recurring-schedule, and available-month reads.
 *
 * Camera/permission/lifecycle behaviour is out of scope everywhere in this
 * app and is not touched by this feature.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
let currentBusinessProfile = fixtures.businessProfile;
let screenFocused = true;

/*
 * `useFocusEffect` is the only export this screen (via itself and
 * useInsight.ts) pulls from @react-navigation/native, and the harness has no
 * NavigationContainer mounted around it here — there is no navigator for the
 * real implementation to ask "am I focused?" of. Standing in for it with a
 * plain mount effect gets the same "fetch on mount, again when deps change"
 * behaviour this screen actually relies on, without requiring a full
 * navigation tree just to read a fetch result.
 */
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const focused = screenFocused;
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: vi.fn(),
  },
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong.',
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [currentBusinessProfile],
    selected: currentBusinessProfile,
    categories: fixtures.categories,
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories: vi.fn(),
    createCategory: vi.fn(),
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

/**
 * Captured rather than swallowed, unlike render/spendingImpact.test.tsx's
 * stand-in — Phase 3's whole point is that a card can open this sheet with a
 * specific question and context queued, and that is only provable by reading
 * what it was actually mounted with.
 */
let lastAskFinSightProps: { visible: boolean; module: string } | null = null;
vi.mock('../../src/components/AskFinSight', () => ({
  AskFinSight: (props: { visible: boolean; module: string }) => {
    lastAskFinSightProps = props;
    return null;
  },
}));
vi.mock('../../src/components/AskFinSightFab', async () => {
  const { Pressable } = await import('react-native');
  return {
    // A plain button standing in for the floating Fin, so the general conversation can still be opened.
    AskFinSightFab: ({ onPress }: { onPress: () => void }) => (
      <Pressable accessibilityRole="button" accessibilityLabel="Ask FinSight" onPress={onPress} />
    ),
    FAB_CLEARANCE: 0,
  };
});

const prepareQuestion = vi.fn();
vi.mock('../../src/context/AiChatContext', () => ({
  useAiChat: () => ({
    input: '',
    setInput: vi.fn(),
    prepareQuestion,
    messages: [],
    conversations: [],
    sending: false,
    error: null,
    send: vi.fn(),
    subscribe: vi.fn(),
    getState: vi.fn(),
  }),
  AiChatProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { ExpenseBehaviorScreen: TypedExpenseBehaviorScreen } = await import('../../src/screens/ExpenseBehaviorScreen');
const ExpenseBehaviorScreen = testScreen(TypedExpenseBehaviorScreen);
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { PeriodSelector } = await import('../../src/components/PeriodSelector');
const { ReportingPeriodScope, useReportingPeriod } = await import('../../src/context/ReportingPeriodContext');
const {
  beginServerStateSession,
  clearServerStateCache,
  invalidateServerState,
} = await import('../../src/lib/serverStateCache');

const navigation = { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() };

const recurringFeatureDisabled = () => Object.assign(new Error('Not found'), { status: 404 });

function recurringSchedule(overrides: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 31,
    businessProfileId: fixtures.businessProfile.id,
    categoryId: 10,
    categoryName: 'Utilities',
    label: 'Shop rent',
    vendor: null,
    intervalDays: 30,
    expectedAmount: 12000,
    amountTolerance: 0.15,
    nextDueDate: '2026-09-05T00:00:00.000Z',
    lastRecordedDate: null,
    isActive: true,
    sourcePatternId: null,
    dueState: 'SCHEDULED',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function pagedFinding(id: number, expenseRecordId: number | null = null): AnomalyFinding {
  return { id, expenseRecordId, type: 'AMOUNT_OUTLIER', severity: 'MEDIUM', score: 0.8,
    title: `Review finding ${id}`, reasons: [`Evidence for finding ${id}`], status: 'OPEN',
    detectedAt: '2026-08-20T02:00:00.000Z', feedback: null };
}

function pagedFlag(id: number, type: RecordItem['type'] = 'expense'): RecordItem {
  return { id, type, businessProfileId: currentBusinessProfile.id, categoryId: 10,
    duplicateOfRecordId: 9, date: '2026-08-20', description: `Review flag ${id}`, amount: 500 + id,
    source: 'MANUAL_ENTRY', reviewStatus: 'Needs Review', duplicateStatus: 'Flagged', largeExpenseFlag: false,
    createdAt: '2026-08-20T02:00:00.000Z' };
}

function pagedCandidate(id: number): RecurringPattern {
  return { id, description: `Candidate payment ${id}`, vendor: null, intervalDays: 30, expectedAmount: 600 + id,
    confidence: 0.88, nextExpectedDate: '2026-09-20', status: 'CANDIDATE', category: { name: 'Utilities' } };
}

function renderScreen() {
  return render(
    <ThemeProvider initialMode="light">
      <ExpenseBehaviorScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

const expenseBehavior: ExpenseBehavior = {
  periodStart: '2026-07-28',
  periodEnd: '2026-08-26',
  periodDays: 30,
  previousPeriodStart: '2026-06-28',
  previousPeriodEnd: '2026-07-27',
  dailyTotals: [],
  totals: { current: 20000, previous: 15000 },
  categoryTrends: [],
  unusualExpenses: [],
  insufficientHistoryCategories: [],
  latestExpenseDate: '2026-08-25',
};

const emptyPage = { items: [], nextCursor: null };

function opportunity(overrides: Partial<ReductionOpportunity> = {}): ReductionOpportunity {
  return {
    id: 'opp-1',
    type: 'CATEGORY_PRESSURE',
    categoryId: 10,
    categoryName: 'Stock',
    priority: 'high',
    confidence: 'strong',
    observation: 'Stock rose sharply against the period before.',
    rationale: 'Stock is 42% of expenses this period, up from 28%.',
    evidence: {
      currentAmount: 8400,
      previousAmount: 5200,
      changeAmount: 3200,
      changePercent: 61.5,
      expenseSharePercent: 42,
      recordCount: 9,
      unusualRecordCount: 0,
      possibleDuplicateCount: 0,
    },
    costBehavior: 'unclassified',
    suggestedChecks: ['Review the records contributing most to this category.'],
    relatedRecordIds: [101, 102],
    limitations: ['Based on a single prior period.'],
    ...overrides,
  };
}

function reductionResponse(
  overrides: Partial<ReductionOpportunityResponse> = {},
): ReductionOpportunityResponse {
  return {
    period: { days: 30, start: '2026-07-28', end: '2026-08-26' },
    dataQuality: {
      status: 'sufficient',
      currentRecordCount: 20,
      previousRecordCount: 18,
      message: null,
    },
    opportunities: [opportunity()],
    detectorVersion: 'v1',
    ...overrides,
  };
}

function detailOverview(
  reduction: ReductionOpportunityResponse,
  behavior = expenseBehavior,
): DetailExpenseOverview {
  return {
    view: 'detail',
    behavior: { status: 'available', data: behavior },
    opportunities: { status: 'available', data: reduction },
  };
}

/** Routes `api.get` by path, the way this screen actually calls it. */
function mockApi({
  reduction,
  behavior = expenseBehavior,
  months = ['2026-08'],
  schedules,
}: {
  reduction: ReductionOpportunityResponse | (() => Promise<ReductionOpportunityResponse>);
  behavior?: typeof expenseBehavior;
  months?: string[];
  schedules?: RecurringSchedule[];
}) {
  apiGet.mockImplementation((path: string) => {
    if (path === '/records/months') return Promise.resolve({ months });
    if (path === '/insights/expense-overview') {
      const result = typeof reduction === 'function' ? reduction() : Promise.resolve(reduction);
      return result.then((data) => detailOverview(data, behavior));
    }
    if (path === '/insights/findings') return Promise.resolve(emptyPage);
    if (path === '/records/flagged') return Promise.resolve(emptyPage);
    if (path === '/records/flagged/count') return Promise.resolve({ expenses: 0, sales: 0, total: 0 });
    if (path === '/insights/recurring-patterns') return Promise.resolve([]);
    if (path === '/insights/recurring-schedules') {
      return schedules ? Promise.resolve(schedules) : Promise.reject(recurringFeatureDisabled());
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

beforeEach(() => {
  Dimensions.set({ window: { width: 1024, height: 768, scale: 1, fontScale: 1 }, screen: { width: 1024, height: 768, scale: 1, fontScale: 1 } });
  clearServerStateCache();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset().mockResolvedValue(undefined);
  prepareQuestion.mockReset();
  lastAskFinSightProps = null;
  currentBusinessProfile = fixtures.businessProfile;
  screenFocused = true;
  navigation.navigate.mockReset();
});

// Explicit rather than relying on auto-cleanup: the Simulate-reduction tests
// below deliberately leave the sheet open at the end of several cases, and
// an un-unmounted tree in that state leaks into the next render — same
// reasoning as tests/render/signOutSheet.test.tsx.
afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe('Expense insight Review tab — large expense flags', () => {
  it('lists the newest flagged expenses with why each was flagged, and opens the full review', async () => {
    const flagged = Array.from({ length: 6 }, (_, i) => ({
      id: 100 + i,
      type: 'expense',
      description: `Flagged purchase ${i + 1}`,
      amount: 500 + i,
      date: `2026-08-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`,
      categoryId: 10,
      duplicateStatus: 'Flagged',
      duplicateOfRecordId: 9,
      reviewStatus: 'Reviewed',
    }));
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 7, sales: 0, total: 7 });
      if (path === '/records/flagged') return Promise.resolve({ items: flagged, nextCursor: null });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: '7 expenses to review.' }));
    expect(navigation.navigate).toHaveBeenLastCalledWith('Records', {
      screen: 'FlaggedRecords', initial: false, params: { from: 'ExpenseBehavior' },
    });
    await fireEvent.press(await queries.findByRole('tab', { name: /^Review/ }));
    expect(await queries.findByText('Large expense flags')).toBeTruthy();
    expect(await queries.findByText('7 flagged')).toBeTruthy();
    expect(await queries.findByText('Flagged purchase 1')).toBeTruthy();
    expect(queries.getAllByText(/possible duplicate of #9/).length).toBe(5);
    expect(queries.queryByText('Flagged purchase 6')).toBeNull();

    await fireEvent.press(queries.getByRole('button', { name: 'Next page' }));
    expect(queries.getByText('Flagged purchase 6')).toBeTruthy();

    await fireEvent.press(queries.getByRole('button', { name: 'Review all 7 flagged' }));
    expect(navigation.navigate).toHaveBeenLastCalledWith('Records', {
      screen: 'FlaggedRecords', initial: false, params: { from: 'ExpenseBehavior' },
    });
  });
});

/** The period pill on the overview's card, and the sheet it opens — as on Home and Recovery. */
type Queries = Awaited<ReturnType<typeof render>>;
const periodPill = (q: Queries) => q.getByRole('button', { name: /Change period/ });
async function choosePeriod(q: Queries, name: string) {
  await fireEvent.press(periodPill(q));
  await fireEvent.press(q.getAllByText(name).at(-1)!);
}
const expectPill = (q: Queries, label: string) =>
  expect(periodPill(q).props.accessibilityLabel).toBe(`Period: ${label}. Change period`);

describe('Expense reporting periods', () => {
  it('opens on the newest recorded month and allows only week or recorded-month comparisons', async () => {
    mockApi({ reduction: reductionResponse(), months: ['2026-09', '2026-08'] });
    const queries = await renderScreen();

    await queries.findByText('Reduction opportunities');
    expectPill(queries, 'September 2026');
    expect(apiGet).toHaveBeenCalledWith('/insights/expense-overview', {
      businessProfileId: currentBusinessProfile.id,
      period: 'month',
      month: '2026-09',
      view: 'detail',
    });
    expect(apiGet.mock.calls.filter(([path]) => path === '/insights/expense-overview')
      .every(([, params]) => params.period === 'month' && params.month === '2026-09')).toBe(true);

    // The sheet offers this week and the recorded months, and never All time.
    await fireEvent.press(periodPill(queries));
    expect(queries.getAllByText('This week').length).toBeGreaterThan(0);
    expect(queries.getAllByText('August 2026').length).toBeGreaterThan(0);
    expect(queries.queryByText('All time')).toBeNull();
    await fireEvent.press(queries.getAllByText('This week').at(-1)!);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/insights/expense-overview', {
      businessProfileId: currentBusinessProfile.id,
      period: 'week',
      view: 'detail',
    }));
    expectPill(queries, 'This week');

    await choosePeriod(queries, 'August 2026');
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/insights/expense-overview', {
      businessProfileId: currentBusinessProfile.id,
      period: 'month',
      month: '2026-08',
      view: 'detail',
    }));
    expectPill(queries, 'August 2026');
    expect(queries.queryByText('All time')).toBeNull();
  });

  it('opens Expense Insight on its own recorded month after another screen selects All time', async () => {
    mockApi({ reduction: reductionResponse() });
    function SharedPeriodJourney() {
      const [expensesOpen, setExpensesOpen] = React.useState(false);
      return expensesOpen ? <ExpenseBehaviorScreen navigation={navigation} /> : (
        <>
          <PeriodSelector />
          <Pressable accessibilityRole="button" onPress={() => setExpensesOpen(true)}>
            <Text>Open Expenses</Text>
          </Pressable>
        </>
      );
    }
    const queries = await render(
      <ThemeProvider initialMode="light">
        <ReportingPeriodScope>
          <SharedPeriodJourney />
        </ReportingPeriodScope>
      </ThemeProvider>,
    );
    await queries.findByRole('radio', { name: 'August 2026' });
    await fireEvent.press(queries.getByRole('radio', { name: 'All time' }));
    expect(queries.getByRole('radio', { name: 'All time' }).props.accessibilityState.checked).toBe(true);
    await fireEvent.press(queries.getByRole('button', { name: 'Open Expenses' }));

    await queries.findByText('Reduction opportunities');
    const expenseRequests = apiGet.mock.calls.filter(([path]) => path === '/insights/expense-overview');
    expect(expenseRequests.length).toBeGreaterThan(0);
    expect(expenseRequests.every(([, params]) => params.period === 'month' && params.month === '2026-08')).toBe(true);
    expectPill(queries, 'August 2026');
    expect(queries.queryByText('All time')).toBeNull();
    expect(queries.queryByRole('button', { name: 'Show all time' })).toBeNull();
  });

  it('preserves another screen’s All time selection when the retained expense screen regains focus', async () => {
    mockApi({ reduction: reductionResponse() });
    function SharedPeriodControl() {
      const { selection, setSelection } = useReportingPeriod();
      return (
        <>
          <Text>{`Shared selection: ${selection.kind}`}</Text>
          <Pressable accessibilityRole="button" onPress={() => setSelection({ kind: 'all' })}>
            <Text>Select all records on another screen</Text>
          </Pressable>
        </>
      );
    }
    const retainedScreen = () => (
      <ThemeProvider initialMode="light">
        <ReportingPeriodScope>
          <SharedPeriodControl />
          <ExpenseBehaviorScreen navigation={navigation} />
        </ReportingPeriodScope>
      </ThemeProvider>
    );
    const queries = await render(retainedScreen());
    await queries.findByText('Reduction opportunities');

    screenFocused = false;
    await queries.rerender(retainedScreen());
    await fireEvent.press(queries.getByRole('button', { name: 'Select all records on another screen' }));
    expect(queries.getByText('Shared selection: all')).toBeTruthy();

    screenFocused = true;
    await queries.rerender(retainedScreen());
    await queries.findByText('Shared selection: all');
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      '/insights/expense-overview',
      expect.objectContaining({ period: 'month', month: '2026-08' }),
    ));
    expect(apiGet.mock.calls.filter(([path]) => path === '/insights/expense-overview')
      .some(([, params]) => params.period === 'all')).toBe(false);
  });

  it('keeps an empty recorded period within week and month choices', async () => {
    mockApi({
      reduction: reductionResponse({ opportunities: [] }),
      behavior: { ...expenseBehavior, totals: { current: 0, previous: 0 } },
      months: ['2026-09', '2026-08'],
    });
    const queries = await renderScreen();

    expect(await queries.findByText(/No expenses in September 2026/)).toBeTruthy();
    expect(queries.queryByText('All time')).toBeNull();
    expect(queries.queryByRole('button', { name: 'Show all time' })).toBeNull();
    expectPill(queries, 'September 2026');
    await fireEvent.press(queries.getByRole('button', { name: 'View August 2026' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      '/insights/expense-overview',
      expect.objectContaining({ period: 'month', month: '2026-08' }),
    ));
    expectPill(queries, 'August 2026');
  });

  it('keeps findings and recurring payments independent of the overview period', async () => {
    mockApi({ reduction: reductionResponse(), schedules: [recurringSchedule()] });
    const queries = await renderScreen();

    await queries.findByText('Reduction opportunities');
    await choosePeriod(queries, 'This week');
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      '/insights/expense-overview',
      expect.objectContaining({ period: 'week' }),
    ));
    // The period belongs to the overview only, so the other tabs carry no control for it.
    await fireEvent.press(queries.getByRole('tab', { name: 'Review' }));
    expect(queries.queryByRole('button', { name: /Change period/ })).toBeNull();
    await fireEvent.press(queries.getByRole('tab', { name: 'Recurring' }));
    expect(await queries.findByText('Shop rent')).toBeTruthy();
    expect(queries.queryByRole('button', { name: /Change period/ })).toBeNull();

    for (const path of ['/insights/findings', '/insights/recurring-patterns', '/insights/recurring-schedules']) {
      const requests = apiGet.mock.calls.filter(([requestedPath]) => requestedPath === path);
      expect(requests.length).toBeGreaterThan(0);
      for (const [, params] of requests) {
        expect(params.businessProfileId).toBe(currentBusinessProfile.id);
        expect(params).not.toHaveProperty('period');
        expect(params).not.toHaveProperty('month');
      }
    }

    await fireEvent.press(queries.getByRole('tab', { name: 'Overview' }));
    expectPill(queries, 'This week');
  });
});

describe('Expense category disclosure', () => {
  it('opens a category’s records and resets its expanded list when the period or business changes', async () => {
    const categoryTrends: CategoryTrend[] = Array.from({ length: 8 }, (_, index) => ({
      categoryId: index + 1,
      categoryName: `Category ${index + 1}`,
      current: (8 - index) * 100,
      previous: 100,
      change: (7 - index) * 100,
      direction: index === 7 ? 'flat' : 'up',
      percentChange: (7 - index) * 100,
      recordCount: 1,
    }));
    mockApi({
      reduction: reductionResponse({ opportunities: [] }),
      behavior: { ...expenseBehavior, totals: { current: 3600, previous: 800 }, categoryTrends },
    });
    const queries = await renderScreen();

    const expand = await queries.findByRole('button', { name: 'All 8 categories' });
    expect(expand.props.accessibilityState.expanded).toBe(false);
    expect(queries.queryByRole('button', { name: /Category 8,.*View these records/ })).toBeNull();
    await fireEvent.press(expand);
    expect(queries.getByRole('button', { name: 'Show fewer' }).props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(queries.getByRole('button', { name: /Category 8,.*View these records/ }));
    expect(navigation.navigate).toHaveBeenLastCalledWith('Records', {
      screen: 'RecordsList',
      params: { categoryId: 8, type: 'expense' },
    });

    await choosePeriod(queries, 'This week');
    expect(await queries.findByRole('button', { name: 'All 8 categories' })).toBeTruthy();
    expect(queries.queryByRole('button', { name: /Category 8,.*View these records/ })).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'All 8 categories' }));

    currentBusinessProfile = { ...fixtures.businessProfile, id: 99, name: 'Second business' };
    await queries.rerender(
      <ThemeProvider initialMode="light">
        <ExpenseBehaviorScreen navigation={navigation} />
      </ThemeProvider>,
    );
    expect(await queries.findByRole('button', { name: 'All 8 categories' })).toBeTruthy();
    expect(queries.queryByRole('button', { name: /Category 8,.*View these records/ })).toBeNull();
    expect(apiGet).toHaveBeenCalledWith(
      '/insights/expense-overview',
      expect.objectContaining({ businessProfileId: 99 }),
    );
  });
});

describe('Expense insight cached refresh failures', () => {
  it('keeps the cached overview visible and names a failed refresh on Overview and Alerts', async () => {
    beginServerStateSession('expense-overview-refresh');
    let failOverview = false;
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') {
        return failOverview
          ? Promise.reject(new Error('Could not refresh expense insights.'))
          : Promise.resolve(detailOverview(reductionResponse()));
      }
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    expect(await queries.findByText('Stock')).toBeTruthy();
    failOverview = true;
    invalidateServerState({ pathPrefixes: ['/insights/expense-overview'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText('Stock')).toBeTruthy();
    expect(queries.queryByLabelText('Loading expense insight')).toBeNull();

    await fireEvent.press(queries.getByRole('tab', { name: 'Review' }));
    expect(queries.getByText("Couldn't refresh")).toBeTruthy();
  });

  it('keeps cached recurring suggestions visible and names their failed refresh', async () => {
    beginServerStateSession('recurring-pattern-refresh');
    const candidate: RecurringPattern = {
      id: 7,
      description: 'Power bill',
      vendor: 'Electric cooperative',
      intervalDays: 30,
      expectedAmount: 1800,
      confidence: 0.9,
      nextExpectedDate: '2026-09-15',
      status: 'CANDIDATE',
      category: { name: 'Utilities' },
    };
    let failPatterns = false;
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') {
        return failPatterns
          ? Promise.reject(new Error('Could not refresh recurring suggestions.'))
          : Promise.resolve([candidate]);
      }
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await queries.findByRole('tab', { name: 'Recurring' });
    await fireEvent.press(queries.getByRole('tab', { name: 'Recurring' }));
    expect(await queries.findByText('Power bill')).toBeTruthy();

    failPatterns = true;
    invalidateServerState({ pathPrefixes: ['/insights/recurring-patterns'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText('Power bill')).toBeTruthy();
  });

  it('keeps the cached recurring agenda visible with a retry after a transient refresh failure', async () => {
    beginServerStateSession('recurring-schedule-refresh');
    let failSchedules = false;
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') {
        return failSchedules
          ? Promise.reject(Object.assign(new Error('Could not refresh repeating payments.'), { status: 503 }))
          : Promise.resolve([recurringSchedule()]);
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('tab', { name: 'Recurring' }));
    expect(await queries.findByText('Shop rent')).toBeTruthy();

    failSchedules = true;
    invalidateServerState({ pathPrefixes: ['/insights/recurring-schedules'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText('Shop rent')).toBeTruthy();

    failSchedules = false;
    await fireEvent.press(queries.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(queries.queryByText("Couldn't refresh")).toBeNull());
    expect(queries.getByText('Shop rent')).toBeTruthy();
  });

  it('does not report a clean Alerts state when an empty cached findings refresh fails', async () => {
    beginServerStateSession('finding-refresh');
    let failFindings = false;
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/flagged') return Promise.resolve(emptyPage);
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 0, sales: 0, total: 0 });
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') {
        return failFindings
          ? Promise.reject(new Error('Could not refresh findings.'))
          : Promise.resolve(emptyPage);
      }
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await queries.findByRole('tab', { name: 'Review' });
    await fireEvent.press(queries.getByRole('tab', { name: 'Review' }));
    expect(await queries.findByText('Nothing needs review')).toBeTruthy();

    failFindings = true;
    invalidateServerState({ pathPrefixes: ['/insights/findings'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText(/Could not refresh findings\./)).toBeTruthy();
    expect(queries.getByText('Updated just now')).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(queries.queryByText('Nothing needs review')).toBeNull();
    expect(queries.queryByText('No findings need review.')).toBeNull();

    failFindings = false;
    await fireEvent.press(queries.getByRole('button', { name: 'Try again' }));
    expect(await queries.findByText('Nothing needs review')).toBeTruthy();
  });

  it('does not render a false findings empty state when the first findings load fails', async () => {
    beginServerStateSession('finding-initial-failure');
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.reject(new Error('Could not load findings.'));
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('tab', { name: 'Review' }));

    expect(await queries.findByText("Couldn't load this")).toBeTruthy();
    expect(queries.getByText(/Could not load findings\./)).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(queries.queryByText('No findings need review.')).toBeNull();
    expect(queries.queryByText('Nothing needs review')).toBeNull();
  });
});

describe('Expense insight mutation cache scope', () => {
  it('opens the general expense conversation from the floating Ask button while reviewing findings', async () => {
    mockApi({ reduction: reductionResponse() });
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: /^Review/ }));
    expect(lastAskFinSightProps).toEqual(expect.objectContaining({ visible: false }));
    await fireEvent.press(queries.getByRole('button', { name: 'Ask FinSight' }));
    await waitFor(() => expect(lastAskFinSightProps).toEqual(expect.objectContaining({
      visible: true, module: 'Expense Insights',
    })));
    expect(prepareQuestion).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('reveals every finding reason and displays the actual unusual amount beside its category mean', async () => {
    const finding: AnomalyFinding = {
      id: 77, expenseRecordId: 101, type: 'POSSIBLE_DUPLICATE', severity: 'MEDIUM',
      score: 0.8, title: 'Possible duplicate purchase',
      reasons: ['Same amount and date', 'Same vendor', 'Descriptions match', 'Recorded two minutes apart'],
      status: 'OPEN', detectedAt: '2026-08-20T02:00:00.000Z', feedback: null,
    };
    mockApi({ reduction: reductionResponse(), behavior: {
      ...expenseBehavior,
      unusualExpenses: [{ id: 88, description: 'Bulk stock purchase', amount: 3500,
        date: '2026-08-20', categoryId: 10, categoryName: 'Stock', zScore: 3,
        categoryMean: 1000, categoryStdDev: 500 }],
    } });
    const route = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, ...args: unknown[]) => path === '/insights/findings'
      ? Promise.resolve({ items: [finding], nextCursor: null }) : route(path, ...args));
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: /^Review/ }));
    expect(await queries.findByText('Possible duplicate purchase')).toBeTruthy();
    expect(queries.queryByText('Same amount and date')).toBeNull();
    expect(queries.queryByText('Recorded two minutes apart')).toBeNull();
    const disclosure = queries.getByRole('button', { name: 'Evidence for Possible duplicate purchase' });
    expect(disclosure.props.accessibilityState.expanded).toBe(false);
    await fireEvent.press(disclosure);
    for (const reason of finding.reasons) expect(queries.getByText(reason)).toBeTruthy();
    expect(queries.getByText(/Detected .*Finding #77 · Record #101/)).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Evidence for Possible duplicate purchase' }).props.accessibilityState.expanded).toBe(true);
    expect(queries.getByText('This expense')).toBeTruthy();
    expect(queries.getByText('PHP 3,500.00')).toBeTruthy();
    expect(queries.getByText('Category average')).toBeTruthy();
    expect(queries.getByText('PHP 1,000.00')).toBeTruthy();
    expect(queries.getByText(/3\.5× the category average/)).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Evidence for Possible duplicate purchase' }));
    expect(queries.queryByText('Same amount and date')).toBeNull();
    expect(queries.queryByText('Recorded two minutes apart')).toBeNull();
    expect(queries.queryByText(/Finding #77 · Record #101/)).toBeNull();
  });

  it.each([
    ['Yes — this was unusual', 'CONFIRMED_UNUSUAL', 'CONFIRMED'],
    ['This is normal for my business', 'EXPECTED_TRANSACTION', 'DISMISSED'],
    ['It is a duplicate', 'DUPLICATE', 'CONFIRMED'],
    ['Wrong match — these are different', 'INCORRECT_MATCH', 'DISMISSED'],
    ['No longer relevant', 'NO_LONGER_RELEVANT', 'RESOLVED'],
  ])('keeps the full finding answer "%s" reachable and submits its intended result', async (label, feedback, status) => {
    const finding: AnomalyFinding = {
      id: 77, expenseRecordId: 101, type: 'POSSIBLE_DUPLICATE', severity: 'MEDIUM',
      score: 0.8, title: 'Possible duplicate purchase', reasons: ['Same amount and date'],
      status: 'OPEN', detectedAt: '2026-08-20T02:00:00.000Z', feedback: null,
    };
    mockApi({ reduction: reductionResponse() });
    const route = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, ...args: unknown[]) => path === '/insights/findings'
      ? Promise.resolve({ items: [finding], nextCursor: null }) : route(path, ...args));
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: /^Review/ }));
    await fireEvent.press(await queries.findByRole('button', { name: 'Other answers for Possible duplicate purchase' }));
    await queries.findByRole('header', { name: 'What was this, really?' });
    const options = queries.getAllByRole('button', { name: label });
    await fireEvent.press(options[options.length - 1]!);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/insights/findings/77/review', { status, feedback },
      { cacheScope: { businessProfileId: currentBusinessProfile.id } },
    ));
  });

  it('keeps finding review scope local to the selected business and off the request body', async () => {
    const finding: AnomalyFinding = {
      id: 77,
      expenseRecordId: 101,
      type: 'POSSIBLE_DUPLICATE',
      severity: 'MEDIUM',
      score: 0.8,
      title: 'Possible duplicate purchase',
      reasons: ['Same amount and date'],
      status: 'OPEN',
      detectedAt: '2026-08-20T02:00:00.000Z',
      feedback: null,
    };
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/flagged') return Promise.resolve(emptyPage);
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 0, sales: 0, total: 0 });
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.resolve({ items: [finding], nextCursor: null });
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('tab', { name: /^Review/ }));
    await fireEvent.press(await queries.findByRole('button', { name: 'It is a duplicate' }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/insights/findings/77/review',
      { status: 'CONFIRMED', feedback: 'DUPLICATE' },
      { cacheScope: { businessProfileId: currentBusinessProfile.id } },
    ));
  });
});

describe('Reduction opportunities — loading', () => {
  it('shows a layout-stable skeleton while the fetch is in flight', async () => {
    let resolve: (value: ReductionOpportunityResponse) => void = () => {};
    mockApi({
      reduction: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });

    const queries = await renderScreen();

    expect(
      await queries.findByLabelText('Loading expense insight'),
    ).toBeTruthy();

    resolve(reductionResponse());
    await waitFor(() =>
      expect(
        queries.queryByLabelText('Loading expense insight'),
      ).toBeNull(),
    );
  });
});

describe('Reduction opportunities — populated', () => {
  it('renders a card with a text priority label, evidence figures and all three actions', async () => {
    mockApi({ reduction: reductionResponse() });
    const queries = await renderScreen();

    expect(await queries.findByText('Reduction opportunities')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(
      '/insights/expense-overview',
      expect.objectContaining({ businessProfileId: currentBusinessProfile.id, view: 'detail' }),
    );
    expect(apiGet).not.toHaveBeenCalledWith('/insights/expense-behavior', expect.anything());
    expect(apiGet).not.toHaveBeenCalledWith('/insights/reduction-opportunities', expect.anything());
    expect(await queries.findByText('High priority')).toBeTruthy();
    expect(queries.getByText('Strong confidence')).toBeTruthy();
    expect(queries.getByText('Stock')).toBeTruthy();
    expect(
      queries.getByText('Stock rose sharply against the period before.'),
    ).toBeTruthy();

    // Evidence figures carry readable labels, not bare numbers.
    expect(
      queries.getByText('42.0%'),
    ).toBeTruthy();

    // Phase 2's and Phase 3's actions, still there, plus Phase 4's.
    expect(
      queries.getByRole('button', { name: 'View related records for Stock' }),
    ).toBeTruthy();
    expect(
      queries.getByRole('button', { name: 'Ask FinSight about this Stock opportunity' }),
    ).toBeTruthy();
    expect(
      queries.getByRole('button', { name: 'Simulate a reduction for Stock' }),
    ).toBeTruthy();
  });

  /**
   * Cost-behavior badge — plan §5.2/§15 Phase 5. Only "fixed" and "mixed" get
   * a badge (see COST_BEHAVIOR_BADGE in ReductionOpportunitiesSection.tsx —
   * the backend's own suggested-check catalogue adds nothing for "variable"
   * or "unclassified", so there is nothing extra worth surfacing for those).
   */
  it('shows a cost-behavior badge for a fixed-cost category', async () => {
    mockApi({
      reduction: reductionResponse({ opportunities: [opportunity({ costBehavior: 'fixed' })] }),
    });
    const queries = await renderScreen();

    await queries.findByText('Stock');
    await fireEvent.press(queries.getByRole('button', { name: 'Details for Stock' }));
    expect(queries.getByText('Fixed cost')).toBeTruthy();
  });

  it('shows a cost-behavior badge for a mixed-cost category', async () => {
    mockApi({
      reduction: reductionResponse({ opportunities: [opportunity({ costBehavior: 'mixed' })] }),
    });
    const queries = await renderScreen();

    await queries.findByText('Stock');
    await fireEvent.press(queries.getByRole('button', { name: 'Details for Stock' }));
    expect(queries.getByText('Mixed cost')).toBeTruthy();
  });

  it('shows no cost-behavior badge for a variable or unclassified category', async () => {
    mockApi({
      reduction: reductionResponse({ opportunities: [opportunity({ costBehavior: 'variable' })] }),
    });
    const queries = await renderScreen();

    await queries.findByText('Stock');
    await fireEvent.press(queries.getByRole('button', { name: 'Details for Stock' }));
    expect(queries.queryByText('Fixed cost')).toBeNull();
    expect(queries.queryByText('Mixed cost')).toBeNull();
  });

  /**
   * "Was this helpful?" — plan §15 Phase 5. `POST
   * /insights/reduction-opportunities/feedback`, idempotent: resubmitting is
   * "changing your answer", not an error, so the second press is allowed too.
   */
  describe('feedback', () => {
    it('submits helpful feedback with the card\'s own opportunity id and shows a confirmed state', async () => {
      mockApi({ reduction: reductionResponse() });
      apiPost.mockResolvedValue({ opportunityId: 'opp-1', rating: 'helpful', createdAt: '2026-08-26T00:00:00.000Z' });
      const queries = await renderScreen();

      // Feedback sits under Details, with the reasons it is feedback on.
      await fireEvent.press(await queries.findByRole('button', { name: 'Details for Stock' }));
      const helpful = await queries.findByRole('button', { name: 'Mark this Stock opportunity as helpful' });
      await fireEvent.press(helpful);

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith('/insights/reduction-opportunities/feedback', {
          businessProfileId: currentBusinessProfile.id,
          opportunityId: 'opp-1',
          rating: 'helpful',
        }),
      );

      expect(await queries.findByText('Feedback saved.')).toBeTruthy();
      expect(helpful.props.accessibilityState?.selected).toBe(true);
    });

    it('lets the owner change their answer to not relevant', async () => {
      mockApi({ reduction: reductionResponse() });
      apiPost.mockResolvedValue({ opportunityId: 'opp-1', rating: 'not_relevant', createdAt: '2026-08-26T00:00:00.000Z' });
      const queries = await renderScreen();

      // Feedback sits under Details, with the reasons it is feedback on.
      await fireEvent.press(await queries.findByRole('button', { name: 'Details for Stock' }));
      const helpful = await queries.findByRole('button', { name: 'Mark this Stock opportunity as helpful' });
      await fireEvent.press(helpful);
      await queries.findByText('Feedback saved.');

      const notRelevant = queries.getByRole('button', { name: 'Mark this Stock opportunity as not relevant' });
      await fireEvent.press(notRelevant);

      await waitFor(() =>
        expect(apiPost).toHaveBeenLastCalledWith('/insights/reduction-opportunities/feedback', {
          businessProfileId: currentBusinessProfile.id,
          opportunityId: 'opp-1',
          rating: 'not_relevant',
        }),
      );
      expect(notRelevant.props.accessibilityState?.selected).toBe(true);
    });

    it('shows an inline error when the feedback request fails', async () => {
      mockApi({ reduction: reductionResponse() });
      apiPost.mockRejectedValue(new Error('Could not save your feedback.'));
      const queries = await renderScreen();

      // Feedback sits under Details, with the reasons it is feedback on.
      await fireEvent.press(await queries.findByRole('button', { name: 'Details for Stock' }));
      const helpful = await queries.findByRole('button', { name: 'Mark this Stock opportunity as helpful' });
      await fireEvent.press(helpful);

      expect(await queries.findByText('Could not save your feedback.')).toBeTruthy();
    });
  });

  it('previews three opportunities and makes every remaining server result reachable', async () => {
    mockApi({
      reduction: reductionResponse({
        opportunities: [
          opportunity({ id: 'a', categoryName: 'Stock' }),
          opportunity({ id: 'b', categoryName: 'Utilities' }),
          opportunity({ id: 'c', categoryName: 'Transport' }),
          opportunity({ id: 'd', categoryName: 'Rent' }),
        ],
      }),
    });
    const queries = await renderScreen();

    await queries.findByText('Stock');
    expect(queries.getByText('Utilities')).toBeTruthy();
    expect(queries.getByText('Transport')).toBeTruthy();
    expect(queries.queryByText('Rent')).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Show all 4 opportunities' }));
    expect(queries.getByText('Rent')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Show fewer opportunities' }));
    expect(queries.queryByText('Rent')).toBeNull();
  });

  it('navigates to the records list filtered by the card\'s category', async () => {
    mockApi({ reduction: reductionResponse() });
    const queries = await renderScreen();

    const action = await queries.findByRole('button', {
      name: 'View related records for Stock',
    });
    await fireEvent.press(action);

    expect(navigation.navigate).toHaveBeenCalledWith('Records', {
      screen: 'RecordsList',
      params: { categoryId: 10, type: 'expense' },
    });
  });

  /**
  /**
   * Phase 3 — plan §11.1. "Ask FinSight about this" has to open the SAME
   * "Expense Insights" sheet the FAB does (§5.4/§11.1: no new module), with
   * the plan's exact question and the SELECTED card's own structured object
   * — not a summary of all three, and not free-form prose assembled
   * client-side from what happens to be on screen.
   */
  it('queues the plan\'s question and the selected opportunity itself, then opens Ask FinSight', async () => {
    const target = opportunity({ id: 'opp-1', categoryId: 10, categoryName: 'Stock' });
    mockApi({
      reduction: reductionResponse({
        opportunities: [
          target,
          opportunity({ id: 'opp-2', categoryId: 11, categoryName: 'Utilities' }),
        ],
      }),
    });
    const queries = await renderScreen();

    const action = await queries.findByRole('button', {
      name: 'Ask FinSight about this Stock opportunity',
    });
    await fireEvent.press(action);

    expect(prepareQuestion).toHaveBeenCalledTimes(1);
    expect(prepareQuestion).toHaveBeenCalledWith(
      REDUCTION_OPPORTUNITY_QUESTION,
      target,
    );
    // Not the other card's opportunity.
    expect(prepareQuestion).not.toHaveBeenCalledWith(
      REDUCTION_OPPORTUNITY_QUESTION,
      expect.objectContaining({ categoryName: 'Utilities' }),
    );

    expect(lastAskFinSightProps).toMatchObject({ visible: true, module: 'Expense Insights' });
  });
});

describe('Reduction opportunity evidence', () => {
  async function renderOpportunity(target: ReductionOpportunity) {
    const { ReductionOpportunitiesSection } = await import('../../src/components/ReductionOpportunitiesSection');
    return render(
      <ThemeProvider initialMode="light">
        <ReductionOpportunitiesSection
          state={{ data: reductionResponse({ opportunities: [target] }), loading: false, error: null, load: vi.fn() }}
          businessProfileId={currentBusinessProfile.id}
          onViewRecords={vi.fn()}
          onAskAboutThis={vi.fn()}
          onSimulate={vi.fn()}
          historical={false}
        />
      </ThemeProvider>,
    );
  }

  it('selects opportunity comparison values with exact amounts and share', async () => {
    const q = await renderOpportunity(opportunity({ evidence: { ...opportunity().evidence, currentAmount: 8400.25, previousAmount: 5200.75 } }));
    await tapChart(q, 'Stock opportunity comparison');
    const name = chartReadout(q, 'Stock opportunity comparison').props.accessibilityLabel;
    expect(name).toContain('This period: PHP 8,400.25');
    expect(name).toContain('Previous period: PHP 5,200.75');
    expect(name).toContain('Share of expenses: 42.0%');
    const plots = q.getAllByLabelText('Stock opportunity comparison plot', { includeHiddenElements: true });
    await fireEvent(plots[0]!, 'hoverOut');
    expect(chartReadout(q, 'Stock opportunity comparison')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Clear Stock opportunity comparison value' }));
    await hoverChart(q, 'Stock opportunity comparison', 150);
    expect(chartReadout(q, 'Stock opportunity comparison').props.accessibilityLabel).toContain('PHP 5,200.75');
  });

  it.each<ReductionOpportunity['type']>([
    'CATEGORY_PRESSURE', 'FREQUENT_PURCHASE_ACCUMULATION', 'RECORD_REVIEW_FIRST',
  ])('preserves the evidence appropriate to %s with a precise spending share', async (type) => {
    const target = opportunity({ type, evidence: { ...opportunity().evidence, expenseSharePercent: 42.37, possibleDuplicateCount: 2, unusualRecordCount: 3 } });
    const q = await renderOpportunity(target);
    expect(q.getByText('42.4%')).toBeTruthy();
    expect(q.getByText('61.5% higher')).toBeTruthy();
    expect(q.getByLabelText('This period, PHP 8,400.00')).toBeTruthy();
    expect(q.getByLabelText('Previous period, PHP 5,200.00')).toBeTruthy();
    if (type === 'FREQUENT_PURCHASE_ACCUMULATION') expect(q.getByText('9 records this period')).toBeTruthy();
    else expect(q.queryByText('9 records this period')).toBeNull();
    if (type === 'RECORD_REVIEW_FIRST') expect(q.getByText('2 possible duplicates · 3 unusual records')).toBeTruthy();
    else expect(q.queryByText('2 possible duplicates · 3 unusual records')).toBeNull();
  });

  it.each([
    { amount: 4200, percentage: -19.23, label: '19.2% lower', explanation: 'Stock was PHP 1,000.00 lower than the previous period.' },
    { amount: 5200, percentage: 0, label: '0% · unchanged', explanation: 'Stock stayed the same.' },
  ])('explains $label from exact category amounts', async ({ amount, percentage, label, explanation }) => {
    const q = await renderOpportunity(opportunity({ evidence: { ...opportunity().evidence, currentAmount: amount, changePercent: percentage, changeAmount: amount - 5200 } }));
    expect(q.getByText(label)).toBeTruthy();
    expect(q.getByText(explanation)).toBeTruthy();
    expect(q.queryByText(/% higher/)).toBeNull();
  });

  it('keeps a recorded zero previous total without claiming a percentage comparison', async () => {
    const q = await renderOpportunity(opportunity({ evidence: { ...opportunity().evidence, previousAmount: 0, changeAmount: 8400, changePercent: null } }));
    expect(q.getByLabelText('Previous period, PHP 0.00')).toBeTruthy();
    expect(q.getByText('No earlier comparison')).toBeTruthy();
    expect(q.getByText('Stock was PHP 8,400.00 higher than the previous period.')).toBeTruthy();
    expect(q.queryByText(/% higher/)).toBeNull();
  });

  it('does not fabricate a previous amount when earlier data is absent', async () => {
    const q = await renderOpportunity(opportunity({ evidence: { ...opportunity().evidence, previousAmount: null, changeAmount: null, changePercent: null } }));
    expect(q.getByText('No earlier comparison')).toBeTruthy();
    expect(q.queryByLabelText(/^Previous period,/)).toBeNull();
    expect(q.queryByText('Compared with last period')).toBeNull();
    expect(q.queryByText(/Stock was PHP/)).toBeNull();
  });

  it('reveals and hides reasons, checks, limitations and feedback while keeping provenance visible', async () => {
    const target = opportunity();
    const q = await renderOpportunity(target);
    expect(q.getByText('Based on your recorded expenses')).toBeTruthy();
    expect(q.queryByText(target.rationale)).toBeNull();
    expect(q.queryByRole('button', { name: 'Mark this Stock opportunity as helpful' })).toBeNull();
    const details = q.getByRole('button', { name: 'Details for Stock' });
    expect(details.props.accessibilityState.expanded).toBe(false);
    await fireEvent.press(details);
    expect(q.getByText(target.rationale)).toBeTruthy();
    target.suggestedChecks.forEach((check) => expect(q.getByText(check)).toBeTruthy());
    target.limitations.forEach((limitation) => expect(q.getByText(limitation)).toBeTruthy());
    expect(q.getByRole('button', { name: 'Mark this Stock opportunity as helpful' })).toBeTruthy();
    const hide = q.getByRole('button', { name: 'Hide details for Stock' });
    expect(hide.props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(hide);
    expect(q.queryByText(target.rationale)).toBeNull();
    expect(q.getByText('Based on your recorded expenses')).toBeTruthy();
  });
});

describe('Reduction opportunities — no material opportunities', () => {
  it('says so, distinctly from insufficient history', async () => {
    mockApi({ reduction: reductionResponse({ opportunities: [] }) });
    const queries = await renderScreen();

    expect(await queries.findByText('No material opportunities found')).toBeTruthy();
  });
});

describe('Reduction opportunities — insufficient history', () => {
  it('shows the server-supplied explanation', async () => {
    mockApi({
      reduction: reductionResponse({
        opportunities: [],
        dataQuality: {
          status: 'insufficient',
          currentRecordCount: 1,
          previousRecordCount: 0,
          message: 'Not enough expense history yet — add a few more records to see opportunities.',
        },
      }),
    });
    const queries = await renderScreen();

    expect(
      await queries.findByText(
        'Not enough expense history yet — add a few more records to see opportunities.',
      ),
    ).toBeTruthy();
    expect(queries.queryByText('No material opportunities found')).toBeNull();
  });
});

describe('Reduction opportunities — independently unavailable panels', () => {
  it('shows an unavailable opportunity panel with a retry that refetches the overview', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') {
        return Promise.resolve({
          view: 'detail',
          behavior: { status: 'available', data: expenseBehavior },
          opportunities: { status: 'unavailable', data: null },
        } satisfies DetailExpenseOverview);
      }
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    expect(
      await queries.findByText('Reduction opportunities are unavailable right now.'),
    ).toBeTruthy();

    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') {
        return Promise.resolve(detailOverview(reductionResponse()));
      }
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await fireEvent.press(queries.getByRole('button', { name: 'Try again' }));

    expect(await queries.findByText('High priority')).toBeTruthy();
    expect(queries.getByText('Strong confidence')).toBeTruthy();
  });

  it('keeps available opportunities usable when expense behavior is unavailable', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') {
        return Promise.resolve({
          view: 'detail',
          behavior: { status: 'unavailable', data: null },
          opportunities: { status: 'available', data: reductionResponse() },
        } satisfies DetailExpenseOverview);
      }
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const queries = await renderScreen();

    expect(await queries.findByText('Expense analysis is unavailable right now.')).toBeTruthy();
    expect(await queries.findByText('High priority')).toBeTruthy();
    expect(queries.getByText('Strong confidence')).toBeTruthy();
    expect(
      queries.getByRole('button', { name: 'View related records for Stock' }),
    ).toBeTruthy();
  });
});

describe('Reduction opportunities — historical window', () => {
  /*
   * Mounted directly rather than through the whole screen's period picker:
   * driving DropdownPill/OptionSheet to reach the anchor-month option would
   * make this test about that control's mechanics rather than about what the
   * section does with `historical`, which is the actual contract being
   * proven here — the screen names its period in the shared selector
   * and that wiring is a one-line fact, not one worth a second harness pass.
   */
  it('labels the period as historical, using the response\'s own period, when the window is not "now"', async () => {
    const { ReductionOpportunitiesSection } = await import(
      '../../src/components/ReductionOpportunitiesSection'
    );
    const { ThemeProvider } = await import('../../src/context/ThemeContext');

    const queries = await render(
      <ThemeProvider initialMode="light">
        <ReductionOpportunitiesSection
          state={{
            data: reductionResponse({ period: { days: 30, start: '2026-01-05', end: '2026-02-04' } }),
            loading: false,
            error: null,
            load: vi.fn(),
          }}
          businessProfileId={currentBusinessProfile.id}
          onViewRecords={vi.fn()}
          onAskAboutThis={vi.fn()}
          onSimulate={vi.fn()}
          historical
        />
      </ThemeProvider>,
    );

    const banner = await queries.findByText(/Historical period:/);
    expect(banner).toBeTruthy();
    expect(queries.getByText(/2026-01-05 to 2026-02-04/)).toBeTruthy();
  });

  it('says nothing about a historical window for the current period', async () => {
    const { ReductionOpportunitiesSection } = await import(
      '../../src/components/ReductionOpportunitiesSection'
    );
    const { ThemeProvider } = await import('../../src/context/ThemeContext');

    const queries = await render(
      <ThemeProvider initialMode="light">
        <ReductionOpportunitiesSection
          state={{ data: reductionResponse(), loading: false, error: null, load: vi.fn() }}
          businessProfileId={currentBusinessProfile.id}
          onViewRecords={vi.fn()}
          onAskAboutThis={vi.fn()}
          onSimulate={vi.fn()}
          historical={false}
        />
      </ThemeProvider>,
    );

    await queries.findByText('High priority');
    expect(queries.getByText('Strong confidence')).toBeTruthy();
    expect(queries.queryByText(/Historical period:/)).toBeNull();
  });
});

/**
 * "Simulate reduction" — Phase 4, plan §12. Opened from the card, scoped to
 * that card's own category, and never referencing `availableFunds` anywhere
 * — the simulation endpoint never touches it (§12.1).
 */
describe('Reduction opportunities — Simulate reduction', () => {
  function simulation(overrides: Partial<ReductionSimulation> = {}): ReductionSimulation {
    return {
      categoryId: 10,
      categoryName: 'Stock',
      period: { days: 30, start: '2026-07-28', end: '2026-08-26' },
      categoryExpenses: { before: 8400, after: 7140 },
      totalExpenses: { before: 20000, after: 18740 },
      hypotheticalReduction: 1260,
      requestedReductionPercent: 15,
      assumptions: [
        'This is a hypothetical scenario for planning purposes only — no expense record is created, edited, or deleted.',
      ],
      ...overrides,
    };
  }

  async function openSheetOnStock() {
    mockApi({ reduction: reductionResponse() });
    const queries = await renderScreen();
    const trigger = await queries.findByRole('button', { name: 'Simulate a reduction for Stock' });
    await fireEvent.press(trigger);
    return queries;
  }

  it('explores before/after simulation bars without issuing another mutation', async () => {
    apiPost.mockResolvedValue(simulation({ totalExpenses: { before: 20000.25, after: 18740.75 } }));
    const q = await openSheetOnStock();
    await fireEvent.changeText(q.getByLabelText('Reduction percentage'), '15');
    await fireEvent.press(q.getByRole('button', { name: 'Simulate' }));
    await q.findByRole('header', { name: 'Hypothetical result' });
    await tapChart(q, 'Total recorded expenses reduction simulation');
    const name = chartReadout(q, 'Total recorded expenses reduction simulation').props.accessibilityLabel;
    expect(name).toContain('Before: PHP 20,000.25. After (hypothetical): PHP 18,740.75');
    expect(name).toContain('Nothing has been saved or changed');
    await fireEvent.press(q.getByRole('button', { name: 'Clear Total recorded expenses reduction simulation value' }));
    await hoverChart(q, 'Total recorded expenses reduction simulation', 150);
    expect(chartReadout(q, 'Total recorded expenses reduction simulation')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('opens the modal scoped to the category on the pressed card, not another one', async () => {
    mockApi({
      reduction: reductionResponse({
        opportunities: [
          opportunity({ id: 'opp-1', categoryId: 10, categoryName: 'Stock' }),
          opportunity({ id: 'opp-2', categoryId: 11, categoryName: 'Utilities' }),
        ],
      }),
    });
    const queries = await renderScreen();

    const trigger = await queries.findByRole('button', { name: 'Simulate a reduction for Utilities' });
    await fireEvent.press(trigger);

    expect(await queries.findByRole('header', { name: 'Simulate a reduction' })).toBeTruthy();
    // The sheet header names the category the pressed card belongs to.
    const matches = queries.getAllByText('Utilities');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('submits a valid percent reduction and shows the hypothetical result, including assumptions', async () => {
    apiPost.mockResolvedValue(simulation());
    const queries = await openSheetOnStock();

    await queries.findByRole('header', { name: 'Simulate a reduction' });
    await fireEvent.changeText(queries.getByLabelText('Reduction percentage'), '15');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(apiPost).toHaveBeenCalledWith('/insights/reduction-simulation', {
      businessProfileId: currentBusinessProfile.id,
      categoryId: 10,
      period: 'month',
      month: '2026-08',
      reduction: { kind: 'percent', value: 15 },
    });

    expect(await queries.findByRole('header', { name: 'Hypothetical result' })).toBeTruthy();
    expect(queries.getByText(/Nothing was changed or saved\./)).toBeTruthy();
    const assumptions = queries.getByRole('button', { name: 'Simulation assumptions' });
    expect(assumptions.props.accessibilityState.expanded).toBe(false);
    await fireEvent.press(assumptions);
    for (const assumption of simulation().assumptions) expect(queries.getByText(assumption)).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Simulation assumptions' }).props.accessibilityState.expanded).toBe(true);
    expect(
      queries.getByText(
        /This is a hypothetical scenario for planning purposes only/,
      ),
    ).toBeTruthy();
  });

  it('submits a valid peso-amount reduction on the amount tab', async () => {
    apiPost.mockResolvedValue(simulation({ hypotheticalReduction: 1000, requestedReductionPercent: 11.9 }));
    const queries = await openSheetOnStock();

    await queries.findByRole('header', { name: 'Simulate a reduction' });
    await fireEvent.press(queries.getByRole('button', { name: 'Reduce by, Peso amount' }));
    await fireEvent.changeText(queries.getByLabelText('Reduction amount, in Philippine pesos'), '1000');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(apiPost).toHaveBeenCalledWith('/insights/reduction-simulation', {
      businessProfileId: currentBusinessProfile.id,
      categoryId: 10,
      period: 'month',
      month: '2026-08',
      reduction: { kind: 'amount', value: 1000 },
    });
    expect(await queries.findByRole('header', { name: 'Hypothetical result' })).toBeTruthy();
    expect(queries.getByText(/Nothing was changed or saved\./)).toBeTruthy();
  });

  it('rejects an out-of-range percent before ever calling the server', async () => {
    const queries = await openSheetOnStock();
    await queries.findByRole('header', { name: 'Simulate a reduction' });

    await fireEvent.changeText(queries.getByLabelText('Reduction percentage'), '150');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(await queries.findByText('Enter 100 or less.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('rejects a peso amount above the category\'s own evidence baseline before calling the server', async () => {
    const queries = await openSheetOnStock();
    await queries.findByRole('header', { name: 'Simulate a reduction' });

    await fireEvent.press(queries.getByRole('button', { name: 'Reduce by, Peso amount' }));
    // The Stock card's own evidence total is 8400.
    await fireEvent.changeText(queries.getByLabelText('Reduction amount, in Philippine pesos'), '9000');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(
      await queries.findByText("Enter an amount no greater than this category's period total."),
    ).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('rejects an empty value with a clear inline message', async () => {
    const queries = await openSheetOnStock();
    await queries.findByRole('header', { name: 'Simulate a reduction' });

    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(await queries.findByText('Enter a percentage.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows the server\'s 400 message for a zero-baseline category rather than a generic failure', async () => {
    // A plain Error stands in for the real ApiError here — the mocked
    // `../../src/lib/api` module above declares `ApiError` as a bare
    // `class ApiError extends Error {}` with no constructor override, so
    // constructing it with the real (status, message) signature would have
    // the default derived constructor forward `status` as `message` to
    // `Error`. `errorMessage`'s own mock treats any `Error` identically, so
    // this exercises the same code path this sheet actually takes.
    apiPost.mockRejectedValue(
      new Error(
        'No expenses were recorded for this category in the selected period, so a reduction cannot be simulated.',
      ),
    );
    const queries = await openSheetOnStock();
    await queries.findByRole('header', { name: 'Simulate a reduction' });

    await fireEvent.changeText(queries.getByLabelText('Reduction percentage'), '20');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(
      await queries.findByText(
        'No expenses were recorded for this category in the selected period, so a reduction cannot be simulated.',
      ),
    ).toBeTruthy();
  });

  it('closes and clears without calling the server when dismissed', async () => {
    const queries = await openSheetOnStock();
    await queries.findByRole('header', { name: 'Simulate a reduction' });

    await fireEvent.press(queries.getByLabelText('Close simulate reduction'));

    await waitFor(() => expect(queries.queryByRole('header', { name: 'Simulate a reduction' })).toBeNull());
    expect(apiPost).not.toHaveBeenCalled();
  });
});

/**
 * A grep-checkable guarantee rather than a rendered assertion: `availableFunds`
 * must never appear in the source of this phase's new files, since the
 * simulation calculation never touches it (plan §12.1) and referencing it
 * anywhere here — even in a comment that implies it factors in — would
 * misrepresent what was actually calculated.
 */
describe('Reduction simulation — availableFunds is never referenced', () => {
  it('is absent from ReductionSimulationSheet.tsx and reductionSimulationForm.ts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const files = [
      path.resolve(__dirname, '../../src/components/ReductionSimulationSheet.tsx'),
      path.resolve(__dirname, '../../src/lib/reductionSimulationForm.ts'),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/availableFunds/i);
    }
  });
});

describe('Expense insight overview — repeating payments', () => {
  it('keeps Recurring discoverable when the agenda is unavailable and retries without exposing unsupported actions', async () => {
    mockApi({ reduction: reductionResponse() });
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: 'Recurring' }));

    expect(await queries.findByText('Repeating payments unavailable')).toBeTruthy();
    expect(queries.getByRole('tab', { name: 'Recurring' }).props.accessibilityState.selected).toBe(true);
    expect(queries.queryByText('No repeating payments yet')).toBeNull();
    expect(queries.queryByRole('button', { name: 'Add a repeating payment' })).toBeNull();
    expect(queries.queryByRole('button', { name: 'Confirm' })).toBeNull();

    const readsBeforeRetry = apiGet.mock.calls.filter(([path]) => path === '/insights/recurring-schedules').length;
    await fireEvent.press(queries.getByRole('button', { name: 'Retry repeating payments' }));
    await waitFor(() => expect(apiGet.mock.calls.filter(([path]) => path === '/insights/recurring-schedules').length).toBeGreaterThan(readsBeforeRetry));
    expect(await queries.findByText('Repeating payments unavailable')).toBeTruthy();
    expect(queries.getByRole('tab', { name: 'Recurring' }).props.accessibilityState.selected).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('shows a real empty agenda with the working add route when schedules are enabled', async () => {
    mockApi({ reduction: reductionResponse(), schedules: [] });
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: 'Recurring' }));

    expect(await queries.findByText('No repeating payments yet')).toBeTruthy();
    expect(queries.queryByText('Repeating payments unavailable')).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Add a repeating payment' }));
    expect(navigation.navigate).toHaveBeenLastCalledWith('RecurringSchedule', {});
  });

  it('withholds candidate confirmation until agenda availability is verified and preserves dismissal after 404', async () => {
    const candidate: RecurringPattern = {
      id: 8, description: 'Water bill', vendor: null, intervalDays: 30,
      expectedAmount: 640, confidence: 0.88, nextExpectedDate: '2026-09-20',
      status: 'CANDIDATE', category: { name: 'Utilities' },
    };
    let rejectSchedules: (error: Error) => void = () => {};
    const pendingSchedules = new Promise<RecurringSchedule[]>((_resolve, reject) => { rejectSchedules = reject; });
    mockApi({ reduction: reductionResponse() });
    const route = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, ...args: unknown[]) => {
      if (path === '/insights/recurring-patterns') return Promise.resolve([candidate]);
      if (path === '/insights/recurring-schedules') return pendingSchedules;
      return route(path, ...args);
    });
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: 'Recurring' }));
    expect(await queries.findByText('Water bill')).toBeTruthy();
    expect(queries.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(queries.queryByRole('button', { name: 'Add a repeating payment' })).toBeNull();

    rejectSchedules(recurringFeatureDisabled());
    expect(await queries.findByText('Repeating payments unavailable')).toBeTruthy();
    expect(queries.queryByRole('button', { name: 'Confirm' })).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Not recurring' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/insights/recurring-patterns/8', { status: 'DISMISSED' },
      { cacheScope: { businessProfileId: currentBusinessProfile.id } },
    ));
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('opens a declared payment and keeps confirm and dismiss actions scoped to the candidate', async () => {
    const candidate: RecurringPattern = {
      id: 8, description: 'Water bill', vendor: null, intervalDays: 30,
      expectedAmount: 640, confidence: 0.88, nextExpectedDate: '2026-09-20',
      status: 'CANDIDATE', category: { name: 'Utilities' },
    };
    mockApi({ reduction: reductionResponse(), schedules: [recurringSchedule()] });
    const route = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, ...args: unknown[]) => path === '/insights/recurring-patterns'
      ? Promise.resolve([candidate]) : route(path, ...args));
    apiPost.mockResolvedValue({});
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('tab', { name: 'Recurring' }));
    await fireEvent.press(await queries.findByText('Shop rent'));
    expect(navigation.navigate).toHaveBeenLastCalledWith('RecurringSchedule', { scheduleId: 31 });
    await fireEvent.press(queries.getByRole('button', { name: 'Add a repeating payment' }));
    expect(navigation.navigate).toHaveBeenLastCalledWith('RecurringSchedule', {});
    await fireEvent.press(queries.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      '/insights/recurring-patterns/8/confirm', undefined,
      { cacheScope: { businessProfileId: currentBusinessProfile.id } },
    ));
    await fireEvent.press(queries.getByRole('button', { name: 'Not recurring' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/insights/recurring-patterns/8', { status: 'DISMISSED' },
      { cacheScope: { businessProfileId: currentBusinessProfile.id } },
    ));
  });

  it('keeps repeating payments off the overview and lists them on the Recurring tab', async () => {
    beginServerStateSession('recurring-on-overview');
    const candidate: RecurringPattern = {
      id: 8,
      description: 'Water bill',
      vendor: null,
      intervalDays: 30,
      expectedAmount: 640,
      confidence: 0.88,
      nextExpectedDate: '2026-09-20',
      status: 'CANDIDATE',
      category: { name: 'Utilities' },
    };
    apiGet.mockImplementation((path: string) => {
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.resolve(emptyPage);
      if (path === '/insights/recurring-patterns') return Promise.resolve([candidate]);
      if (path === '/insights/recurring-schedules') return Promise.resolve([recurringSchedule()]);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    // Overview has loaded, and shows neither the schedule nor the new-repeat prompt.
    await queries.findByText('Where does the money go?');
    expect(queries.queryByText('Repeating payments')).toBeNull();
    expect(queries.queryByText('Shop rent')).toBeNull();
    expect(queries.queryByRole('button', { name: /FinSight found 1 possible repeating payment/ })).toBeNull();

    // Both are on the Recurring tab.
    await fireEvent.press(queries.getByRole('tab', { name: /Recurring/ }));
    expect(await queries.findByText('Shop rent')).toBeTruthy();
    expect(await queries.findByText('Water bill')).toBeTruthy();
  });
});

it('binds the expense-insight view to its own reporting period scope', () => {
  const wrapper = TypedExpenseBehaviorScreen({} as never);
  expect(wrapper.props.scope).toBe('expense-insight');
  expect(typeof wrapper.props.children.type).toBe('function');
});

function paginationApi({ flags = [], findings = [], unusual = [], schedules = [], candidates = [], history = [] }: {
  flags?: RecordItem[]; findings?: AnomalyFinding[]; unusual?: ExpenseBehavior['unusualExpenses'];
  schedules?: RecurringSchedule[]; candidates?: RecurringPattern[]; history?: ExpenseBehavior['insufficientHistoryCategories'];
}) {
  mockApi({ reduction: reductionResponse(), schedules, behavior: { ...expenseBehavior, unusualExpenses: unusual, insufficientHistoryCategories: history } });
  const fallback = apiGet.getMockImplementation()!;
  apiGet.mockImplementation((path: string, ...args: unknown[]) => {
    if (path === '/records/flagged') return Promise.resolve({ items: flags, nextCursor: null });
    if (path === '/records/flagged/count') return Promise.resolve({ expenses: flags.filter((row) => row.type === 'expense').length, sales: 0, total: flags.length });
    if (path === '/insights/findings') return Promise.resolve({ items: findings, nextCursor: null });
    if (path === '/insights/recurring-patterns') return Promise.resolve(candidates);
    return fallback(path, ...args);
  });
}

const visibleReviewNames = (q: Queries) => q.queryAllByText(/^(Review flag \d+|Review finding \d+|Unmatched expense \d+)$/).map((row) => row.props.children);
const unusualRow = (id: number): ExpenseBehavior['unusualExpenses'][number] => ({ id, description: `Unmatched expense ${id}`, amount: 3500, date: '2026-08-20', categoryId: 10, categoryName: 'Stock', zScore: 3, categoryMean: 1000, categoryStdDev: 500 });

describe('Unusual expense comparison values', () => {
  it('selects and previews exact expense/average figures without reviewing a finding', async () => {
    const { ExpenseAlertsSection } = await import('../../src/components/ExpenseAlertsSection');
    const review = vi.fn();
    const q = await render(<ThemeProvider initialMode="light"><ExpenseAlertsSection unusualExpenses={[{ ...unusualRow(88), amount: 3500.25, categoryMean: 1000.75 }]} insufficientHistoryCategories={[]} openFindings={0} findingState={{ data: { items: [], nextCursor: null }, loading: false, error: null }} findingNotice={null} refreshFindings={vi.fn()} findingsRefreshing={false} findingsUpdatedAt={null} feedbackError={null} reviewFinding={review} onOtherAnswers={vi.fn()} /></ThemeProvider>);
    await tapChart(q, 'Unmatched expense 88 comparison');
    const name = chartReadout(q, 'Unmatched expense 88 comparison').props.accessibilityLabel;
    expect(name).toContain('This expense: PHP 3,500.25. Category average: PHP 1,000.75');
    expect(name).toContain('Stock');
    await fireEvent.press(q.getByRole('button', { name: 'Clear Unmatched expense 88 comparison value' }));
    await hoverChart(q, 'Unmatched expense 88 comparison', 150);
    expect(chartReadout(q, 'Unmatched expense 88 comparison')).toBeTruthy();
    expect(review).not.toHaveBeenCalled();
  });
});

describe('Expense insight combined pagination', () => {
  it('jumps directly among known Recurring pages with selected and boundary controls', async () => {
    paginationApi({ candidates: Array.from({ length: 20 }, (_, index) => pagedCandidate(index + 1)) });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Recurring/ }));
    await q.findByText('Candidate payment 1');
    expect(q.getByRole('button', { name: 'Go to page 1' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 3' }));
    expect(await q.findByText('Candidate payment 11')).toBeTruthy();
    expect(q.queryAllByText(/^Candidate payment \d+$/)).toHaveLength(5);
    expect(q.getByRole('button', { name: 'Go to page 3' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Last page' }));
    expect(await q.findByText('Candidate payment 20')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Go to page 4' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('button', { name: 'Last page' }).props.accessibilityState.disabled).toBe(true);
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'First page' }));
    expect(await q.findByText('Candidate payment 1')).toBeTruthy();
    expect(q.getByRole('button', { name: 'First page' }).props.accessibilityState.disabled).toBe(true);
  });

  it.each(['Review', 'Recurring'])('does not invent a page count for empty %s results', async (tab) => {
    paginationApi({});
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: tab }));
    await q.findByText('No items to show');
    expect(q.queryByText(/^Page \d+( of \d+)?$/)).toBeNull();
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
  });

  it.each([20, 23])('shows actual page totals for %i combined Recurring items', async (total) => {
    paginationApi({ schedules: Array.from({ length: 12 }, (_, index) => recurringSchedule({ id: index + 1, label: `Payment ${index + 1}`, dueState: index < 4 ? 'OVERDUE' : 'SCHEDULED' })), candidates: Array.from({ length: total - 12 }, (_, index) => pagedCandidate(index + 101)) });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Recurring/ }));
    await q.findByText('Payment 1');
    const visible = () => q.queryAllByText(/^(Payment \d+|Candidate payment \d+)$/);
    expect(q.queryByRole('button', { name: /page size:/ })).toBeNull();
    const pages = Math.ceil(total / 5);
    for (let page = 0; page < pages - 1; page += 1) {
      expect(q.getByText(`Page ${page + 1} of ${pages}`)).toBeTruthy();
      expect(visible()).toHaveLength(5);
      expect(q.getAllByRole('button', { name: 'Next page' })).toHaveLength(1);
      expect(q.getByRole('tab', { name: 'Recurring, 4 needing review' })).toBeTruthy();
      await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    }
    expect(visible()).toHaveLength(total % 5 || 5);
    expect(q.getByText(`Page ${pages} of ${pages}`)).toBeTruthy();
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Previous page' }));
    expect(visible()).toHaveLength(5);
    expect(q.getByText(`Page ${pages - 1} of ${pages}`)).toBeTruthy();
  });

  it('limits Review to five total rows across flags, findings and unmatched unusual expenses', async () => {
    paginationApi({ flags: [pagedFlag(1), pagedFlag(2)], findings: [pagedFinding(11, 301), pagedFinding(12)], unusual: [unusualRow(301), unusualRow(302), unusualRow(303)] });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review flag 1');
    expect(visibleReviewNames(q)).toEqual(['Review flag 1', 'Review flag 2', 'Unmatched expense 301', 'Review finding 12', 'Unmatched expense 302']);
    expect(q.queryByText('Unmatched expense 303')).toBeNull();
    expect(q.getByText('Page 1 of 2')).toBeTruthy();
    expect(q.getAllByText('Unmatched expense 301')).toHaveLength(1);
    expect(q.getAllByRole('button', { name: 'Next page' })).toHaveLength(1);
    expect(q.getByRole('button', { name: 'Previous page' }).props.accessibilityState.disabled).toBe(true);
    expect(q.getByRole('tab', { name: 'Review, 2 needing review' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    expect(await q.findByText('Unmatched expense 303')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(['Unmatched expense 303']);
    expect(q.getByText('Page 2 of 2')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    expect(q.getByRole('tab', { name: 'Review, 2 needing review' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Previous page' }));
    expect(visibleReviewNames(q)).toHaveLength(5);
  });

  it('keeps Review at five combined items per page through the partial last page', async () => {
    paginationApi({ flags: [pagedFlag(1), pagedFlag(2), pagedFlag(3)], findings: Array.from({ length: 12 }, (_, index) => pagedFinding(10 + index)), unusual: Array.from({ length: 8 }, (_, index) => unusualRow(30 + index)) });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review flag 1');
    expect(q.queryByRole('button', { name: /page size:/ })).toBeNull();
    for (let page = 0; page < 4; page += 1) {
      expect(q.getByText(`Page ${page + 1} of 5`)).toBeTruthy();
      expect(visibleReviewNames(q)).toHaveLength(5);
      expect(q.getAllByRole('button', { name: 'Next page' })).toHaveLength(1);
      await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    }
    expect(visibleReviewNames(q)).toEqual(['Unmatched expense 35', 'Unmatched expense 36', 'Unmatched expense 37']);
    expect(q.getByText('Page 5 of 5')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
  });

  it('retains separate pages when moving between Review and Recurring', async () => {
    paginationApi({ findings: Array.from({ length: 12 }, (_, index) => pagedFinding(index + 1)), candidates: Array.from({ length: 7 }, (_, index) => pagedCandidate(index + 1)) });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review finding 1');
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    expect(await q.findByText('Review finding 6')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(Array.from({ length: 5 }, (_, index) => `Review finding ${6 + index}`));
    await fireEvent.press(q.getByRole('tab', { name: /^Recurring/ }));
    await q.findByText('Candidate payment 1');
    expect(q.queryByRole('button', { name: /page size:/ })).toBeNull();
    expect(q.queryAllByText(/^Candidate payment \d+$/)).toHaveLength(5);
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    expect(await q.findByText('Candidate payment 6')).toBeTruthy();
    await fireEvent.press(q.getByRole('tab', { name: /^Review/ }));
    expect(q.queryByRole('button', { name: /page size:/ })).toBeNull();
    expect(visibleReviewNames(q)).toEqual(Array.from({ length: 5 }, (_, index) => `Review finding ${6 + index}`));
    await fireEvent.press(q.getByRole('tab', { name: /^Recurring/ }));
    expect(q.queryAllByText(/^Candidate payment \d+$/).map((row) => row.props.children)).toEqual(['Candidate payment 6', 'Candidate payment 7']);
  });

  it('uses one Recurring pager for grouped schedules followed by candidates, preserving overdue counts and actions', async () => {
    const schedules = [
      recurringSchedule({ id: 1, label: 'Scheduled payment', dueState: 'SCHEDULED' }),
      recurringSchedule({ id: 2, label: 'Overdue payment 1', dueState: 'OVERDUE' }),
      recurringSchedule({ id: 3, label: 'Paused payment', isActive: false }),
      recurringSchedule({ id: 4, label: 'Overdue payment 2', dueState: 'OVERDUE' }),
    ];
    paginationApi({ schedules, candidates: [pagedCandidate(8), pagedCandidate(9), pagedCandidate(10)] });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Recurring/ }));
    await q.findByText('Overdue payment 1');
    expect(q.getAllByRole('button', { name: /\. Edit this payment\.$/ }).map((row) => row.props.accessibilityLabel.split(',')[0])).toEqual(['Overdue payment 1', 'Overdue payment 2', 'Scheduled payment', 'Paused payment']);
    expect(q.getByText('Candidate payment 8')).toBeTruthy();
    expect(q.queryByText('Candidate payment 9')).toBeNull();
    expect(q.getByRole('tab', { name: 'Recurring, 2 needing review' })).toBeTruthy();
    expect(q.getAllByRole('button', { name: 'Next page' })).toHaveLength(1);
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    expect(await q.findByText('Candidate payment 9')).toBeTruthy();
    expect(q.getByText('Candidate payment 10')).toBeTruthy();
    expect(q.queryByText('Overdue payment 1')).toBeNull();
    expect(q.getByRole('tab', { name: 'Recurring, 2 needing review' })).toBeTruthy();
    await fireEvent.press(q.getAllByRole('button', { name: 'Not recurring' })[0]!);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/insights/recurring-patterns/9', { status: 'DISMISSED' }, { cacheScope: { businessProfileId: currentBusinessProfile.id } }));
  });
});

describe('Expense insight Review cursor pagination', () => {
  it('jumps to the last known Review page through unvisited flag cursors and returns to cached pages', async () => {
    paginationApi({});
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 77, sales: 0, total: 77 });
      if (path === '/records/flagged') {
        const offset = Number(query?.cursor ?? 0);
        return Promise.resolve({ items: Array.from({ length: Math.min(20, 77 - offset) }, (_, index) => pagedFlag(offset + index + 1)), nextCursor: offset + 20 < 77 ? String(offset + 20) : null });
      }
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review flag 1');
    expect(q.getByText('Page 1 of 16')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Last page' }).props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 16' }));
    expect(await q.findByText('Review flag 77')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(['Review flag 76', 'Review flag 77']);
    expect(q.getByRole('button', { name: 'Go to page 16' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    expect(apiGet.mock.calls.filter((call) => call[0] === '/records/flagged').map((call) => call[1].cursor)).toEqual([undefined, '20', '40', '60']);
    await fireEvent.press(q.getByRole('button', { name: 'First page' }));
    expect(await q.findByText('Review flag 1')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 2' }));
    expect(await q.findByText('Review flag 6')).toBeTruthy();
    expect(visibleReviewNames(q)).toHaveLength(5);
    expect(q.getByRole('button', { name: 'Go to page 2' }).props.accessibilityState.selected).toBe(true);
    expect(apiGet.mock.calls.filter((call) => call[0] === '/records/flagged')).toHaveLength(4);
  });

  it('uses a fresh expense count for four Review pages while mixed-record flag cursors remain unfinished', async () => {
    paginationApi({});
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 20, sales: 20, total: 40 });
      if (path === '/records/flagged') return Promise.resolve(query?.cursor
        ? { items: [...Array.from({ length: 10 }, (_, index) => pagedFlag(11 + index)), ...Array.from({ length: 10 }, (_, index) => pagedFlag(11 + index, 'sales'))], nextCursor: null }
        : { items: [...Array.from({ length: 10 }, (_, index) => pagedFlag(1 + index)), ...Array.from({ length: 10 }, (_, index) => pagedFlag(1 + index, 'sales'))], nextCursor: 'mixed-next' });
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review flag 1');
    expect(q.getByText('Page 1 of 4')).toBeTruthy();
    expect(q.getByText(/^Showing 1–5 of 20/)).toBeTruthy();
    expect(apiGet.mock.calls.filter((call) => call[0] === '/records/flagged')).toHaveLength(1);
    for (let page = 0; page < 3; page += 1) {
      expect(q.getByText(`Page ${page + 1} of 4`)).toBeTruthy();
      expect(visibleReviewNames(q)).toHaveLength(5);
      await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    }
    expect(visibleReviewNames(q)).toEqual(Array.from({ length: 5 }, (_, index) => `Review flag ${16 + index}`));
    expect(q.getByText('Page 4 of 4')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    expect(apiGet).toHaveBeenCalledWith('/records/flagged', expect.objectContaining({ businessProfileId: 1, limit: 20, cursor: 'mixed-next' }));
  });

  it('counts complete findings and unmatched unusual records in the upfront Review page total', async () => {
    paginationApi({ findings: [pagedFinding(11, 301), pagedFinding(12)], unusual: [unusualRow(301), unusualRow(302)] });
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 20, sales: 0, total: 20 });
      if (path === '/records/flagged') return Promise.resolve({ items: Array.from({ length: 10 }, (_, index) => pagedFlag(index + 1)), nextCursor: 'remaining-flags' });
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review flag 1');
    expect(q.getByText('Page 1 of 5')).toBeTruthy();
    expect(q.getByText(/^Showing 1–5 of 23/)).toBeTruthy();
    expect(visibleReviewNames(q)).toHaveLength(5);
    expect(apiGet.mock.calls.filter((call) => call[0] === '/records/flagged')).toHaveLength(1);
  });

  it('places the combined pager before history guidance and avoids reporting a partial cursor feed as its total', async () => {
    paginationApi({ history: [{ categoryId: 10, categoryName: 'Stock', historyCount: 2 }] });
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/records/flagged/count') return Promise.reject(new Error('Flagged count unavailable'));
      if (path === '/records/flagged') return Promise.resolve(query?.cursor
        ? { items: [pagedFlag(21), pagedFlag(22), pagedFlag(23)], nextCursor: null }
        : { items: Array.from({ length: 20 }, (_, index) => pagedFlag(index + 1)), nextCursor: 'more-flags' });
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review flag 1');
    expect(q.getAllByText(/^Showing .+|^More history needed$/).map((element) => element.props.children)).toEqual(['Showing 1–5 · More available', 'More history needed']);
    expect(q.queryByText(/of 20 loaded/)).toBeNull();
    expect(q.getByText('Page 1')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Last page' }).props.accessibilityState.disabled).toBe(true);
    expect(q.queryByText(/^Page \d+ of \d+$/)).toBeNull();
    expect(q.getAllByRole('button', { name: 'Next page' })).toHaveLength(1);
    for (let page = 0; page < 4; page += 1) {
      expect(q.getByText(`Page ${page + 1}`)).toBeTruthy();
      expect(q.queryByText(/^Page \d+ of \d+$/)).toBeNull();
      await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    }
    expect(await q.findByText('Review flag 23')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(['Review flag 21', 'Review flag 22', 'Review flag 23']);
    expect(q.getByText('Showing 21–23 of 23')).toBeTruthy();
    expect(q.getByText('Page 5 of 5')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    expect(apiGet).toHaveBeenCalledWith('/records/flagged', expect.objectContaining({ businessProfileId: 1, limit: 20, cursor: 'more-flags' }));
  });

  it('walks mixed-record string cursors and finding numeric cursors without losing overlapping rows', async () => {
    paginationApi({});
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/records/flagged/count') return Promise.resolve({ expenses: 6, sales: 20, total: 26 });
      if (path === '/records/flagged') return Promise.resolve(query?.cursor
        ? { items: Array.from({ length: 6 }, (_, index) => pagedFlag(index + 1)), nextCursor: null }
        : { items: Array.from({ length: 20 }, (_, index) => pagedFlag(index + 1, 'sales')), nextCursor: 'expense-page' });
      if (path === '/insights/findings') return Promise.resolve(query?.cursorId
        ? { items: [pagedFinding(20), pagedFinding(21)], nextCursor: null }
        : { items: Array.from({ length: 20 }, (_, index) => pagedFinding(index + 1)), nextCursor: 20 });
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    expect(await q.findByText('Review flag 1')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(['Review flag 1', 'Review flag 2', 'Review flag 3', 'Review flag 4', 'Review flag 5']);
    expect(q.getByText('Page 1')).toBeTruthy();
    expect(q.queryByText(/^Page \d+ of \d+$/)).toBeNull();
    expect(apiGet).toHaveBeenCalledWith('/records/flagged', expect.objectContaining({ businessProfileId: 1, limit: 20, cursor: 'expense-page' }));
    for (let page = 0; page < 5; page += 1) {
      expect(visibleReviewNames(q)).toHaveLength(5);
      await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    }
    expect(await q.findByText('Review finding 21')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(['Review finding 20', 'Review finding 21']);
    expect(apiGet).toHaveBeenCalledWith('/insights/findings', expect.objectContaining({ businessProfileId: 1, status: 'OPEN', take: 20, cursorId: 20 }));
    expect(q.getAllByText('Review finding 20')).toHaveLength(1);
    expect(q.getByText('Page 6 of 6')).toBeTruthy();
  });

  it('keeps the current page on a failed cursor fetch and advances only after a successful retry', async () => {
    paginationApi({ flags: [], findings: Array.from({ length: 5 }, (_, index) => pagedFinding(index + 1)) });
    const fallback = apiGet.getMockImplementation()!;
    let failTail = true;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/insights/findings') {
        if (!query?.cursorId) return Promise.resolve({ items: Array.from({ length: 5 }, (_, index) => pagedFinding(index + 1)), nextCursor: 5 });
        return failTail ? Promise.reject(new Error('Could not load the next findings.')) : Promise.resolve({ items: [pagedFinding(6)], nextCursor: null });
      }
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review finding 1');
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    expect(await q.findByRole('button', { name: 'Retry next page' })).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(Array.from({ length: 5 }, (_, index) => `Review finding ${index + 1}`));
    expect(q.queryByText('Nothing needs review')).toBeNull();
    failTail = false;
    await fireEvent.press(q.getByRole('button', { name: 'Retry next page' }));
    expect(await q.findByText('Review finding 6')).toBeTruthy();
    expect(visibleReviewNames(q)).toEqual(['Review finding 6']);
    expect(q.queryByRole('button', { name: 'Retry next page' })).toBeNull();
  });

  it('clamps the page after reviewing its last finding and sends the displayed finding identifier', async () => {
    let findings = Array.from({ length: 6 }, (_, index) => pagedFinding(index + 1));
    paginationApi({});
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, ...args: unknown[]) => path === '/insights/findings'
      ? Promise.resolve({ items: findings, nextCursor: null }) : fallback(path, ...args));
    apiPatch.mockImplementation(async () => { findings = findings.filter((finding) => finding.id !== 6); });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review finding 1');
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    await q.findByText('Review finding 6');
    await fireEvent.press(q.getByRole('button', { name: 'This is normal for my business' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/insights/findings/6/review', { status: 'DISMISSED', feedback: 'EXPECTED_TRANSACTION' }, { cacheScope: { businessProfileId: 1 } }));
    expect(await q.findByText('Review finding 1')).toBeTruthy();
    expect(visibleReviewNames(q)).toHaveLength(5);
    expect(q.getByRole('button', { name: 'Go to page 1' }).props.accessibilityState.selected).toBe(true);
    expect(q.queryByRole('button', { name: 'Go to page 2' })).toBeNull();
    expect(q.getByRole('button', { name: 'Previous page' }).props.accessibilityState.disabled).toBe(true);
  });

  it('ignores an old business cursor response after switching businesses', async () => {
    let finish!: (page: { items: AnomalyFinding[]; nextCursor: null }) => void;
    const pending = new Promise<{ items: AnomalyFinding[]; nextCursor: null }>((resolve) => { finish = resolve; });
    paginationApi({});
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === '/insights/findings') {
        if (query?.businessProfileId === 2) return Promise.resolve({ items: [{ ...pagedFinding(51), title: 'Business B finding' }], nextCursor: null });
        return query?.cursorId ? pending : Promise.resolve({ items: Array.from({ length: 5 }, (_, index) => pagedFinding(index + 1)), nextCursor: 5 });
      }
      return fallback(path, query);
    });
    const q = await renderScreen();
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    await q.findByText('Review finding 1');
    await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
    currentBusinessProfile = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await q.rerender(<ThemeProvider initialMode="light"><ExpenseBehaviorScreen navigation={navigation} /></ThemeProvider>);
    await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
    expect(await q.findByText('Business B finding')).toBeTruthy();
    await act(async () => { finish({ items: [{ ...pagedFinding(6), title: 'Late business A finding' }], nextCursor: null }); await pending; });
    expect(q.queryByText('Late business A finding')).toBeNull();
    expect(q.getByText('Business B finding')).toBeTruthy();
  });
});

it('ignores an old next-page response after the same business refreshes its review list', async () => {
  let finish!: (page: { items: AnomalyFinding[]; nextCursor: null }) => void;
  const pending = new Promise<{ items: AnomalyFinding[]; nextCursor: null }>((resolve) => { finish = resolve; });
  let refreshed = false;
  paginationApi({});
  const fallback = apiGet.getMockImplementation()!;
  apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
    if (path === '/insights/findings') {
      if (query?.cursorId) return pending;
      return Promise.resolve(refreshed ? { items: [{ ...pagedFinding(51), title: 'Refreshed finding' }], nextCursor: null } : { items: Array.from({ length: 5 }, (_, index) => pagedFinding(index + 1)), nextCursor: 5 });
    }
    return fallback(path, query);
  });
  const q = await renderScreen();
  await fireEvent.press(await q.findByRole('tab', { name: /^Review/ }));
  await q.findByText('Review finding 1');
  await fireEvent.press(q.getByRole('button', { name: 'Next page' }));
  refreshed = true;
  await act(async () => { invalidateServerState({ businessProfileId: 1, pathPrefixes: ['/insights/findings'] }); });
  expect(await q.findByText('Refreshed finding')).toBeTruthy();
  await act(async () => { finish({ items: [{ ...pagedFinding(6), title: 'Stale cursor finding' }], nextCursor: null }); await pending; });
  expect(q.queryByText('Stale cursor finding')).toBeNull();
  expect(q.getByText('Refreshed finding')).toBeTruthy();
});
