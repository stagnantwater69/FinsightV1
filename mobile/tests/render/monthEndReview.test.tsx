import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecoveryMonthEndReview } from '../../src/lib/types';

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
const withTheme = (node: React.ReactNode) => <ThemeProvider initialMode="light">{node}</ThemeProvider>;

const REVIEWABLE: RecoveryMonthEndReview = {
  status: 'reviewable',
  month: '2026-07',
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

async function renderScreen(navigation: any = { navigate: vi.fn() }) {
  const { MonthEndReviewScreen } = await import('../../src/screens/MonthEndReviewScreen');
  return render(withTheme(<MonthEndReviewScreen navigation={navigation} />));
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
});

describe('MonthEndReviewScreen — not yet reviewable', () => {
  it('shows a plain, non-alarming message for the current/future month', async () => {
    apiGet.mockResolvedValue(NOT_YET);
    const queries = await renderScreen();
    await queries.findByText(/isn't over yet/i);
    expect(queries.queryByText(/surplus/i)).toBeNull();
    expect(queries.queryByText(/shortfall/i)).toBeNull();
  });
});

describe('MonthEndReviewScreen — reviewable', () => {
  it('frames a shortfall as a positive peso amount with the word "shortfall", never a negative-looking figure', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    const line = await queries.findByText('PHP 3,800 shortfall');
    const text = [line.props.children].flat().join('');
    expect(text).not.toMatch(/-/);
    expect(text).toMatch(/3,800/);
  });

  it('frames a surplus with the word "surplus"', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, surplusOrShortfall: 1500 });
    const queries = await renderScreen();
    const line = await queries.findByText(/surplus/i);
    const text = [line.props.children].flat().join('');
    expect(text).not.toMatch(/-/);
  });

  it('renders the strongest and weakest open day with date and amount', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText('2026-07-14');
    await queries.findByText('2026-07-02');
  });

  it('phrases the missing/provisional count as "N of M open days"', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText('3 of 26 open days missing or still provisional');
  });

  it('handles a null finalAdjustedDailyTarget with an explanation rather than a blank', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, finalAdjustedDailyTarget: null });
    const queries = await renderScreen();
    await queries.findByText(/not available/i);
  });

  it('does not show the baseline callout when false', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText(/Coverage for/);
    expect(queries.queryByText(/may not match the sales pattern/i)).toBeNull();
  });

  it('shows a neutral baseline callout only when baselineAppearsOffFromPattern is true', async () => {
    apiGet.mockResolvedValue({ ...REVIEWABLE, baselineAppearsOffFromPattern: true });
    const queries = await renderScreen();
    await queries.findByText(/may not match the sales pattern/i);
  });

  it('renders suggested questions as plain read-only text, with no per-question interactive element mutating a setting', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    for (const q of REVIEWABLE.suggestedQuestionsForNextMonth) {
      await queries.findByText(q);
    }
    // Only one interactive element in the questions area should exist: the
    // generic "Edit business profile" link. Nothing calls api.put/patch/post
    // when tapping anywhere near a question.
    const buttons = queries.queryAllByRole('button');
    const questionButtons = buttons.filter((b) =>
      REVIEWABLE.suggestedQuestionsForNextMonth.some((q) => b.props.accessibilityLabel === q),
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
    expect(navigate).toHaveBeenCalledWith('More', { screen: 'BusinessProfileForm' });
    expect(apiPut).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('MonthEndReviewScreen — month picker', () => {
  it('defaults to last month and refetches with a new month when the picker is moved', async () => {
    apiGet.mockResolvedValue(REVIEWABLE);
    const queries = await renderScreen();
    await queries.findByText(/Coverage for/);

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
