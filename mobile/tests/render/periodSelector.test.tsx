import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * This week | Month | All time, the same three choices web offers.
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

const { PeriodSelector } = await import('../../src/components/PeriodSelector');
const { ReportingPeriodScope, useReportingPeriod } = await import('../../src/context/ReportingPeriodContext');
const { invalidateServerState } = await import('../../src/lib/serverStateCache');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

let seen: unknown[] = [];

/** Records what the rest of the screen would read, alongside the selector. */
function Reader() {
  const { selection } = useReportingPeriod();
  seen.push(selection);
  return null;
}

async function mountSelector(months: string[] | Error) {
  apiGet.mockImplementation(async (path: string) => {
    if (path !== '/records/months') throw new Error(`unexpected GET ${path}`);
    if (months instanceof Error) throw months;
    return { months };
  });
  return render(
    <ThemeProvider initialMode="light">
      <ReportingPeriodScope>
        <PeriodSelector />
        <Reader />
      </ReportingPeriodScope>
    </ThemeProvider>,
  );
}

function checkedLabel(queries: Awaited<ReturnType<typeof mountSelector>>): string | undefined {
  const checked = queries.getAllByRole('radio').filter((node) => node.props.accessibilityState?.checked === true);
  expect(checked, 'exactly one period should be selected').toHaveLength(1);
  return checked[0]!.props.accessibilityLabel;
}

beforeEach(() => {
  apiGet.mockReset();
  seen = [];
});

describe('PeriodSelector', () => {
  it('offers exactly three choices and opens on the newest month with records', async () => {
    const queries = await mountSelector(['2026-09', '2026-08', '2025-12']);
    await waitFor(() => expect(checkedLabel(queries)).toBe('September 2026'));
    expect(queries.getAllByRole('radio').map((node) => node.props.accessibilityLabel)).toEqual([
      'This week',
      'September 2026',
      'All time',
    ]);
    expect(seen.at(-1)).toEqual({ kind: 'month', month: '2026-09' });
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('lists only the months the business has records in, newest first', async () => {
    const queries = await mountSelector(['2026-09', '2026-08', '2025-12']);
    await waitFor(() => expect(checkedLabel(queries)).toBe('September 2026'));

    await fireEvent.press(queries.getByRole('radio', { name: 'September 2026' }));
    for (const name of ['September 2026', 'August 2026', 'December 2025']) {
      expect(queries.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(queries.queryByText('January 2026')).toBeNull();

    await fireEvent.press(queries.getAllByText('December 2025').at(-1)!);
    await waitFor(() => expect(checkedLabel(queries)).toBe('December 2025'));
    expect(seen.at(-1)).toEqual({ kind: 'month', month: '2025-12' });
  });

  it('reaches every choice from every other, including back from all time', async () => {
    const queries = await mountSelector(['2026-09']);
    await waitFor(() => expect(checkedLabel(queries)).toBe('September 2026'));

    await fireEvent.press(queries.getByRole('radio', { name: 'All time' }));
    expect(checkedLabel(queries)).toBe('All time');
    await fireEvent.press(queries.getByRole('radio', { name: 'This week' }));
    expect(checkedLabel(queries)).toBe('This week');
    expect(seen.at(-1)).toEqual({ kind: 'week' });
  });

  it('opens on this week, with Month unavailable, when there are no records', async () => {
    const queries = await mountSelector([]);
    await waitFor(() => expect(checkedLabel(queries)).toBe('This week'));
    expect(queries.getByRole('radio', { name: 'Month' }).props.accessibilityState.disabled).toBe(true);
  });

  it('still opens, on this week, when the month list cannot be read', async () => {
    const queries = await mountSelector(new Error('offline'));
    await waitFor(() => expect(checkedLabel(queries)).toBe('This week'));
    expect(await queries.findByText("Couldn't load this")).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(queries.getByRole('radio', { name: 'Month' }).props.accessibilityHint).toBe(
      "Months couldn't be loaded. Use Try again below",
    );
    expect(queries.queryByText('No months with records yet.')).toBeNull();
  });

  it('keeps known months available and offers retry after a mutation refresh fails', async () => {
    apiGet
      .mockResolvedValueOnce({ months: ['2026-09', '2026-08'] })
      .mockRejectedValueOnce(new Error('Could not refresh months.'));
    const queries = await render(
      <ThemeProvider initialMode="light">
        <ReportingPeriodScope>
          <PeriodSelector />
          <Reader />
        </ReportingPeriodScope>
      </ThemeProvider>,
    );
    await waitFor(() => expect(checkedLabel(queries)).toBe('September 2026'));

    await act(async () => {
      invalidateServerState({
        businessProfileId: fixtures.businessProfile.id,
        pathPrefixes: ['/records'],
      });
    });

    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText(/Could not refresh months\./)).toBeTruthy();
    expect(queries.getByRole('radio', { name: 'September 2026' }).props.accessibilityState.disabled).toBe(false);
    expect(queries.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
