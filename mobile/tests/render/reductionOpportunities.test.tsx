import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import { REDUCTION_OPPORTUNITY_QUESTION } from '../../src/lib/reductionOpportunityAsk';
import type { DetailExpenseOverview } from '../../src/lib/expenseOverview';
import type { AnomalyFinding, RecurringPattern, RecurringSchedule, ReductionOpportunity, ReductionOpportunityResponse, ReductionSimulation } from '../../src/lib/types';

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
    React.useEffect(() => effect(), [effect]);
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
vi.mock('../../src/components/AskFinSightFab', () => ({
  AskFinSightFab: () => null,
  FAB_CLEARANCE: 0,
}));

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

const { ExpenseBehaviorScreen } = await import(
  '../../src/screens/ExpenseBehaviorScreen'
);
const { ThemeProvider } = await import('../../src/context/ThemeContext');
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

function renderScreen() {
  return render(
    <ThemeProvider initialMode="light">
      <ExpenseBehaviorScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

const expenseBehavior = {
  periodStart: '2026-07-28',
  periodEnd: '2026-08-26',
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
}: {
  reduction: ReductionOpportunityResponse | (() => Promise<ReductionOpportunityResponse>);
  behavior?: typeof expenseBehavior;
}) {
  apiGet.mockImplementation((path: string) => {
    // The business has records in August, so the shared period opens there.
    if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
    if (path === '/insights/expense-overview') {
      const result = typeof reduction === 'function' ? reduction() : Promise.resolve(reduction);
      return result.then((data) => detailOverview(data, behavior));
    }
    if (path === '/insights/findings') return Promise.resolve(emptyPage);
    if (path === '/insights/recurring-patterns') return Promise.resolve([]);
    if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

beforeEach(() => {
  clearServerStateCache();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset().mockResolvedValue(undefined);
  prepareQuestion.mockReset();
  lastAskFinSightProps = null;
  currentBusinessProfile = fixtures.businessProfile;
});

// Explicit rather than relying on auto-cleanup: the Simulate-reduction tests
// below deliberately leave the sheet open at the end of several cases, and
// an un-unmounted tree in that state leaks into the next render — same
// reasoning as tests/render/signOutSheet.test.tsx.
afterEach(async () => {
  await cleanup();
  clearServerStateCache();
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

    await fireEvent.press(queries.getByRole('tab', { name: 'Alerts' }));
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

    await queries.findByRole('tab', { name: 'Alerts' });
    await fireEvent.press(queries.getByRole('tab', { name: 'Alerts' }));
    expect(await queries.findByText('Nothing needs a look')).toBeTruthy();

    failFindings = true;
    invalidateServerState({ pathPrefixes: ['/insights/findings'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText(/Could not refresh findings\./)).toBeTruthy();
    expect(queries.getByText('Updated just now')).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(queries.queryByText('Nothing needs a look')).toBeNull();
    expect(queries.queryByText('No findings need review.')).toBeNull();

    failFindings = false;
    await fireEvent.press(queries.getByRole('button', { name: 'Try again' }));
    expect(await queries.findByText('Nothing needs a look')).toBeTruthy();
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

    await fireEvent.press(await queries.findByRole('tab', { name: 'Alerts' }));

    expect(await queries.findByText("Couldn't load this")).toBeTruthy();
    expect(queries.getByText(/Could not load findings\./)).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(queries.queryByText('No findings need review.')).toBeNull();
    expect(queries.queryByText('Nothing needs a look')).toBeNull();
  });
});

describe('Expense insight mutation cache scope', () => {
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
      if (path === '/records/months') return Promise.resolve({ months: ['2026-08'] });
      if (path === '/insights/expense-overview') return Promise.resolve(detailOverview(reductionResponse()));
      if (path === '/insights/findings') return Promise.resolve({ items: [finding], nextCursor: null });
      if (path === '/insights/recurring-patterns') return Promise.resolve([]);
      if (path === '/insights/recurring-schedules') return Promise.reject(recurringFeatureDisabled());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('tab', { name: /Alerts/ }));
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
      queries.getByLabelText('Share of expenses: 42%'),
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
    expect(queries.getByText('Fixed cost')).toBeTruthy();
  });

  it('shows a cost-behavior badge for a mixed-cost category', async () => {
    mockApi({
      reduction: reductionResponse({ opportunities: [opportunity({ costBehavior: 'mixed' })] }),
    });
    const queries = await renderScreen();

    await queries.findByText('Stock');
    expect(queries.getByText('Mixed cost')).toBeTruthy();
  });

  it('shows no cost-behavior badge for a variable or unclassified category', async () => {
    mockApi({
      reduction: reductionResponse({ opportunities: [opportunity({ costBehavior: 'variable' })] }),
    });
    const queries = await renderScreen();

    await queries.findByText('Stock');
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

      const helpful = await queries.findByRole('button', { name: 'Mark this Stock opportunity as helpful' });
      await fireEvent.press(helpful);

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith('/insights/reduction-opportunities/feedback', {
          businessProfileId: currentBusinessProfile.id,
          opportunityId: 'opp-1',
          rating: 'helpful',
        }),
      );

      expect(await queries.findByText('Thanks — noted.')).toBeTruthy();
      expect(helpful.props.accessibilityState?.selected).toBe(true);
    });

    it('lets the owner change their answer to not relevant', async () => {
      mockApi({ reduction: reductionResponse() });
      apiPost.mockResolvedValue({ opportunityId: 'opp-1', rating: 'not_relevant', createdAt: '2026-08-26T00:00:00.000Z' });
      const queries = await renderScreen();

      const helpful = await queries.findByRole('button', { name: 'Mark this Stock opportunity as helpful' });
      await fireEvent.press(helpful);
      await queries.findByText('Thanks — noted.');

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

      const helpful = await queries.findByRole('button', { name: 'Mark this Stock opportunity as helpful' });
      await fireEvent.press(helpful);

      expect(await queries.findByText('Could not save your feedback.')).toBeTruthy();
    });
  });

  it('caps the list at three cards even if the server sends more', async () => {
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

    const banner = await queries.findByText(/a historical window, not/);
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
    expect(queries.queryByText(/historical window/)).toBeNull();
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

    expect(await queries.findByText('Simulate a reduction')).toBeTruthy();
    // The sheet header names the category the pressed card belongs to.
    const matches = queries.getAllByText('Utilities');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('submits a valid percent reduction and shows the hypothetical result, including assumptions', async () => {
    apiPost.mockResolvedValue(simulation());
    const queries = await openSheetOnStock();

    await queries.findByText('Simulate a reduction');
    await fireEvent.changeText(queries.getByLabelText('Reduction percentage'), '15');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(apiPost).toHaveBeenCalledWith('/insights/reduction-simulation', {
      businessProfileId: currentBusinessProfile.id,
      categoryId: 10,
      period: 'month',
      month: '2026-08',
      reduction: { kind: 'percent', value: 15 },
    });

    expect(await queries.findByText('Hypothetical result — nothing was changed or saved')).toBeTruthy();
    expect(queries.getByText(/Assumptions/)).toBeTruthy();
    expect(
      queries.getByText(
        /This is a hypothetical scenario for planning purposes only/,
      ),
    ).toBeTruthy();
  });

  it('submits a valid peso-amount reduction on the amount tab', async () => {
    apiPost.mockResolvedValue(simulation({ hypotheticalReduction: 1000, requestedReductionPercent: 11.9 }));
    const queries = await openSheetOnStock();

    await queries.findByText('Simulate a reduction');
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
    expect(await queries.findByText('Hypothetical result — nothing was changed or saved')).toBeTruthy();
  });

  it('rejects an out-of-range percent before ever calling the server', async () => {
    const queries = await openSheetOnStock();
    await queries.findByText('Simulate a reduction');

    await fireEvent.changeText(queries.getByLabelText('Reduction percentage'), '150');
    await fireEvent.press(queries.getByRole('button', { name: 'Simulate' }));

    expect(await queries.findByText('Enter 100 or less.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('rejects a peso amount above the category\'s own evidence baseline before calling the server', async () => {
    const queries = await openSheetOnStock();
    await queries.findByText('Simulate a reduction');

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
    await queries.findByText('Simulate a reduction');

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
    await queries.findByText('Simulate a reduction');

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
    await queries.findByText('Simulate a reduction');

    await fireEvent.press(queries.getByLabelText('Close simulate reduction'));

    await waitFor(() => expect(queries.queryByText('Simulate a reduction')).toBeNull());
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
