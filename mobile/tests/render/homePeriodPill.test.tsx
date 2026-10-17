import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * Home's period control: the pill on the money panel and the "Viewing … ·
 * Back to now" strip.
 *
 * WHY THIS FILE EXISTS: the Month list must be the business's own months with
 * records (never January to December), the default must be the newest of
 * them, and every choice must stay one tap from every other — including the
 * way back from All time, which once had no control at all.
 *
 * Driven, not read off source: this is about a control's state after presses.
 */

const apiGet = vi.fn();

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
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
  }),
}));

const { PeriodPill, PeriodStatus } = await import('../../src/components/PeriodSelector');
const { ReportingPeriodScope, useReportingPeriod } = await import('../../src/context/ReportingPeriodContext');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

let seen: unknown[] = [];

function Reader() {
  const { selection } = useReportingPeriod();
  seen.push(selection);
  return null;
}

async function mountHomeControls(months: string[]) {
  apiGet.mockImplementation(async (path: string) => {
    if (path !== '/records/months') throw new Error(`unexpected GET ${path}`);
    return { months };
  });
  return render(
    <ThemeProvider initialMode="light">
      <ReportingPeriodScope>
        <PeriodStatus />
        <PeriodPill />
        <Reader />
      </ReportingPeriodScope>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  seen = [];
  // Only the clock is faked, so "now" is October 2026 whatever day the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 11, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Home period pill', () => {
  it('names the period and shows no reminder while on the current month', async () => {
    const queries = await mountHomeControls(['2026-10', '2026-09']);
    expect(await queries.findByRole('button', { name: 'Period: October 2026. Change period' })).toBeTruthy();
    expect(queries.queryByText('Back to now')).toBeNull();
  });

  it('offers every period in one sheet: this week, each month with records, and all time', async () => {
    const queries = await mountHomeControls(['2026-10', '2026-09']);
    await fireEvent.press(await queries.findByRole('button', { name: /Change period/ }));
    expect(queries.getByText('Show numbers for')).toBeTruthy();
    for (const name of ['This week', 'September 2026', 'All time', 'This month', 'Since your first record']) {
      expect(queries.getAllByText(name).length).toBeGreaterThan(0);
    }
    // Fixed choices first, then the months.
    // lastIndexOf: the sheet renders after the pill, which also says "October 2026".
    const tree = JSON.stringify(queries.toJSON());
    const positions = ['"This week"', '"All time"', '"October 2026"', '"September 2026"'].map((name) => tree.lastIndexOf(name));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    await fireEvent.press(queries.getAllByText('All time').at(-1)!);
    await waitFor(() => expect(seen.at(-1)).toEqual({ kind: 'all' }));
  });

  it('reminds the owner when Home shows a past month, and goes back to this month in one tap', async () => {
    const queries = await mountHomeControls(['2026-10', '2026-09']);
    await fireEvent.press(await queries.findByRole('button', { name: /Change period/ }));
    await fireEvent.press(queries.getAllByText('September 2026').at(-1)!);
    expect(await queries.findByText('Back to now')).toBeTruthy();
    // Named in the strip and on the pill.
    expect(queries.getAllByText('September 2026')).toHaveLength(2);
    await fireEvent.press(queries.getByRole('button', { name: 'Back to now: October 2026' }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ kind: 'month', month: '2026-10' }));
    expect(queries.queryByText('Back to now')).toBeNull();
  });

  it('goes back to this week when the current month has no records yet', async () => {
    const queries = await mountHomeControls(['2026-09', '2026-08']);
    // The default is the newest month with records, which here is not the current one.
    expect(await queries.findByText('Back to now')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Back to now: this week' }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ kind: 'week' }));
    expect(queries.queryByText('Back to now')).toBeNull();
  });

  it('treats this week as now', async () => {
    const queries = await mountHomeControls(['2026-10']);
    await fireEvent.press(await queries.findByRole('button', { name: /Change period/ }));
    await fireEvent.press(queries.getAllByText('This week').at(-1)!);
    await waitFor(() => expect(seen.at(-1)).toEqual({ kind: 'week' }));
    expect(queries.queryByText('Back to now')).toBeNull();
  });
});
