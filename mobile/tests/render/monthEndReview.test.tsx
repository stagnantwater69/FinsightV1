import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecoveryMonthEndReview } from '../../src/lib/types';
import { chartReadout, hoverChart, tapChart } from './support/chartInteractions';

/**
 * Rendered coverage for the month-end review screen — Recovery Target
 * Improvement Plan §10.9/§11 Phase 7.
 *
 * Follows the same mocking shape as recoveryScenario.test.tsx/
 * operatingSchedule.test.tsx: useFocusEffect stands in for a mount effect
 * since there is no NavigationContainer in this harness, and api.get is
 * routed by path.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    put: (...args: unknown[]) => apiPut(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: fixtures.businessProfile,
    categories: fixtures.categories,
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories: vi.fn(),
    createCategory: vi.fn(),
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { ThemeProvider } = await import('../../src/context/ThemeContext');
const {
  beginServerStateSession,
  clearServerStateCache,
  invalidateServerState,
} = await import('../../src/lib/serverStateCache');
const withTheme = (node: React.ReactNode) => <ThemeProvider initialMode="light">{node}</ThemeProvider>;

const REVIEWABLE: RecoveryMonthEndReview = {
  status: 'reviewable',
  month: '2026-07',
  monthlyExpenseBasis: {
    amount: 50_000,
    source: 'owner_estimate',
    sourceMonth: null,
    ownerEstimate: 50_000,
    recordsCompleteThroughMonth: null,
    recordsCompleteThroughConfirmedAt: null,
    eligibleRecordCount: 0,
  },
  coveragePercent: 92.4,
  surplusOrShortfall: -3800,
  strongestOpenDay: { date: '2026-07-14', sales: 5200 },
  weakestOpenDay: { date: '2026-07-02', sales: 400 },
  missingOrProvisionalDayCount: 3,
  openDayCount: 26,
  originalDailyTarget: 1900,
  finalAdjustedDailyTarget: 2100,
  baselineAppearsOffFromPattern: false,
  suggestedQuestionsForNextMonth: [
    'Was expected monthly expenses set realistically for this month?',
    'Did any single day drive most of the shortfall?',
  ],
  operatingScheduleConfigured: true,
};

const NOT_YET: RecoveryMonthEndReview = { status: 'not_yet_reviewable', month: '2026-08' };

describe('Month-end ring values', () => {
  it('selects exact expense basis, coverage and shortfall without treating surplus as profit', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, monthlyExpenseBasis: { ...REVIEWABLE.monthlyExpenseBasis!, amount: 50000.25 }, surplusOrShortfall: -3800.75 });
    const q = await renderScreen();
    await q.findByRole('progressbar');
    await tapChart(q, 'Month-end sales coverage');
    const name = chartReadout(q, 'Month-end sales coverage').props.accessibilityLabel;
    expect(name).toContain('Expense basis: PHP 50,000.25'); expect(name).toContain('Shortfall: PHP 3,800.75');
    expect(name).toContain('not a measure of profit');
    await fireEvent.press(q.getByRole('button', { name: 'Clear Month-end sales coverage value' }));
    await hoverChart(q, 'Month-end sales coverage', 150);
    expect(chartReadout(q, 'Month-end sales coverage').props.accessibilityLabel).toContain('92.4%');
  });
});

async function renderScreen(navigation: any = { navigate: vi.fn() }) {
  const { MonthEndReviewScreen } = await import('../../src/screens/MonthEndReviewScreen');
  return render(withTheme(<MonthEndReviewScreen navigation={navigation} />));
}

beforeEach(() => {
  clearServerStateCache();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
});

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe('MonthEndReviewScreen — not yet reviewable', () => {
  it('shows a plain, non-alarming message for the current/future month', async () => {
    apiGet.mockResolvedValue(NOT_YET);
    const queries = await renderScreen();
    await queries.findByRole('header', { name: "August 2026 isn't ready to review" });
    expect(queries.queryByText(/surplus/i)).toBeNull();
    expect(queries.queryByText(/shortfall/i)).toBeNull();
  });
});

describe('MonthEndReviewScreen — reviewable', () => {
  it('keeps sales coverage at its supplied percentage with a centered SVG rotation', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    const progress = await queries.findByRole('progressbar', { name: 'Sales coverage for July 2026: 92.4% covered' });
    const svg = progress.children.find((child) => typeof child !== 'string' && child.props.viewBox === '0 0 116 116');
    expect(svg).toBeTruthy();
    if (!svg || typeof svg === 'string') throw new Error('Sales coverage SVG is absent');
    expect(svg.props.accessible).toBe(false);
    const ring = svg.children.find((child) => typeof child !== 'string' && child.props.strokeDasharray);
    expect(ring).toBeTruthy();
    if (!ring || typeof ring === 'string') throw new Error('Sales coverage ring is absent');
    expect(ring.props.transform).toBe('rotate(-90 58 58)');
    expect(ring.props.origin).toBeUndefined();
    expect(ring.props.rotation).toBeUndefined();
    expect(ring.props.strokeDashoffset).toBeCloseTo(2 * Math.PI * 50 * (1 - 0.924), 10);
    expect(progress.props.accessibilityValue.now).toBe(92.4);
    expect(queries.getByText('PHP 3,800.00')).toBeTruthy();
  });

  it('preserves coverage above 100 percent while bounding the progress indicator', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, coveragePercent: 127.3, surplusOrShortfall: 13650 });
    const queries = await renderScreen();
    expect(await queries.findByText('127.3%')).toBeTruthy();
    const progress = queries.getByRole('progressbar', { name: 'Sales coverage for July 2026: 127.3% covered' });
    expect(progress.props.accessibilityValue.now).toBe(100);
    expect(progress.props.accessibilityValue.text).toContain('127.3%');
    expect(queries.getByText('PHP 13,650.00')).toBeTruthy();
    expect(queries.getByText('Above expense basis')).toBeTruthy();
    expect(queries.queryByRole('header', { name: /^profit$/i })).toBeNull();
  });

  it('explains an exact zero difference as a covered expense basis', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, coveragePercent: 100, surplusOrShortfall: 0 });
    const queries = await renderScreen();
    expect(await queries.findByText('Expense basis covered')).toBeTruthy();
    expect(queries.getByText('Covered')).toBeTruthy();
    expect(queries.queryByText('still to cover')).toBeNull();
    expect(queries.queryByText('Above expense basis')).toBeNull();
  });

  it('keeps absent open days and a missing final rate explicit without inventing sales', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, strongestOpenDay: null, weakestOpenDay: null, openDayCount: 0, missingOrProvisionalDayCount: 0, finalAdjustedDailyTarget: null });
    const queries = await renderScreen();
    await queries.findByText('Sales coverage');
    expect(queries.getAllByText('No open days this month').length).toBeGreaterThanOrEqual(2);
    expect(queries.queryByText('PHP 5,200.00')).toBeNull();
    expect(queries.queryByText('PHP 400.00')).toBeNull();
    expect(queries.getByText(/Not available/i)).toBeTruthy();
    expect(queries.queryByText(/Sales records are complete for all 0/)).toBeNull();
  });

  it('reports complete open-day records when the server has no missing or provisional days', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, missingOrProvisionalDayCount: 0 });
    const queries = await renderScreen();
    expect(await queries.findByText('Sales records are complete for all 26 open days.')).toBeTruthy();
    expect(queries.queryByText(/open days need complete sales records/)).toBeNull();
  });

  it('keeps the cached review visible and explains a failed refresh', async () => {
    beginServerStateSession('month-end-refresh');
    let failRefresh = false;
    apiGet.mockImplementation((path: string) => {
      if (path !== '/insights/recovery/month-end-review') {
        return Promise.reject(new Error(`unexpected path ${path}`));
      }
      return failRefresh
        ? Promise.reject(new Error('Could not refresh this month-end review.'))
        : Promise.resolve(REVIEWABLE);
    });

    const queries = await renderScreen();
    expect(await queries.findByText('Sales coverage')).toBeTruthy();
    expect(queries.getByText('Updated just now')).toBeTruthy();

    failRefresh = true;
    invalidateServerState({ pathPrefixes: ['/insights/recovery/month-end-review'] });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText('Sales coverage')).toBeTruthy();
    expect(queries.getByText(/Could not refresh this month-end review/)).toBeTruthy();

    failRefresh = false;
    fireEvent.press(queries.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(queries.queryByText("Couldn't refresh")).toBeNull());
    expect(queries.getByText('Sales coverage')).toBeTruthy();
  });

  it('frames a shortfall as a positive peso amount still to cover', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    const line = await queries.findByText(/PHP 3,800(?:\.00)?$/);
    expect(queries.getByText('still to cover')).toBeTruthy();
    const text = [line.props.children].flat().join('');
    expect(text).not.toMatch(/-/);
    expect(text).toMatch(/3,800/);
  });

  it('shows the owner-estimate basis and explains its provenance', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText(/PHP 50,000(?:\.00)?$/);
    await fireEvent.press(queries.getByRole('button', { name: 'How this is calculated' }));
    expect(queries.getByText(/using your starting estimate/i)).toBeTruthy();
  });

  it('shows the complete-month basis and source month', async () => {
    apiGet.mockResolvedValue({
      ...REVIEWABLE,
      monthlyExpenseBasis: {
        amount: 80_000,
        source: 'previous_complete_month',
        sourceMonth: '2026-06',
        ownerEstimate: 50_000,
        recordsCompleteThroughMonth: '2026-06',
        recordsCompleteThroughConfirmedAt: '2026-07-01T02:30:00.000Z',
        eligibleRecordCount: 12,
      },
    });
    const queries = await renderScreen();
    await queries.findByText(/PHP 80,000(?:\.00)?$/);
    await fireEvent.press(queries.getByRole('button', { name: 'How this is calculated' }));
    expect(queries.getByText(/12 eligible expense records from June 2026/i)).toBeTruthy();
  });

  it('frames a surplus as an amount above the expense basis', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, surplusOrShortfall: 1500 });
    const queries = await renderScreen();
    const line = await queries.findByText(/PHP 1,500(?:\.00)?$/);
    expect(queries.getByText('Above expense basis')).toBeTruthy();
    const text = [line.props.children].flat().join('');
    expect(text).not.toMatch(/-/);
  });

  it('renders the strongest and weakest open day with date and amount', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByLabelText('Strongest day: Jul 14, 2026, PHP 5,200.00 recorded sales');
    await queries.findByLabelText('Weakest day: Jul 2, 2026, PHP 400.00 recorded sales');
  });

  it('phrases the missing/provisional count as "N of M open days"', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText('3 of 26 open days need complete sales records');
  });

  it('handles a null finalAdjustedDailyTarget with an explanation rather than a blank', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, finalAdjustedDailyTarget: null });
    const queries = await renderScreen();
    await queries.findByText(/not available/i);
  });

  it('does not show the baseline callout when false', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText('Sales coverage');
    expect(queries.queryByText(/may not match the sales pattern/i)).toBeNull();
  });

  it('shows a neutral baseline callout only when baselineAppearsOffFromPattern is true', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, baselineAppearsOffFromPattern: true });
    const queries = await renderScreen();
    await queries.findByText(/may not match the sales pattern/i);
  });

  it('renders suggested questions as plain read-only text, with no per-question interactive element mutating a setting', async () => {
    const questions = [...REVIEWABLE.suggestedQuestionsForNextMonth, 'Did weekend deliveries affect your open-day sales?'];
    apiGet.mockResolvedValue({ ...REVIEWABLE, suggestedQuestionsForNextMonth: questions });
    const queries = await renderScreen();
    for (const q of questions) {
      await queries.findByText(q);
    }
    // Only one interactive element in the questions area should exist: the
    // generic "Edit business profile" link. Nothing calls api.put/patch/post
    // when tapping anywhere near a question.
    const buttons = queries.queryAllByRole('button');
    const questionButtons = buttons.filter((b) =>
      questions.some((q) => b.props.accessibilityLabel === q),
    );
    expect(questionButtons).toHaveLength(0);
    expect(apiPut).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('the only call-to-action near suggestions is a plain link to the business profile edit screen', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const navigate = vi.fn();
    const queries = await renderScreen({ navigate });
    const editLink = await queries.findByText('Edit business profile');
    fireEvent.press(editLink);
    expect(navigate).toHaveBeenCalledWith('More', {
      screen: 'BusinessProfileForm',
      params: { profile: fixtures.businessProfile },
    });
    expect(apiPut).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('MonthEndReviewScreen — month picker', () => {
  it('defaults to last month and refetches with a new month when the picker is moved', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText('Sales coverage');

    const [, firstQuery] = apiGet.mock.calls[0];
    const firstMonth = (firstQuery as { month: string }).month;

    const next = await queries.findByLabelText('Next month');
    apiGet.mockClear();
    apiGet.mockResolvedValue(REVIEWABLE);
    fireEvent.press(next);

    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const [, secondQuery] = apiGet.mock.calls[0];
    expect((secondQuery as { month: string }).month).not.toBe(firstMonth);
  });
});
