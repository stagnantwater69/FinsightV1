import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import * as fixtures from './support/fixtures';

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

vi.mock('../../src/components/charts', () => ({
  CashflowChart: ({ data }: { data: unknown[] }) => <Text>{`Cashflow points: ${data.length}`}</Text>,
}));

const { MoneyFlowScreen } = await import('../../src/screens/MoneyFlowScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { beginServerStateSession, clearServerStateCache, invalidateServerState } = await import('../../src/lib/serverStateCache');

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

function mount() {
  return render(
    <ThemeProvider initialMode="light">
      <MoneyFlowScreen />
    </ThemeProvider>,
  );
}

describe('MoneyFlowScreen', () => {
  it('keeps the cached chart visible and names its failed refresh', async () => {
    beginServerStateSession('money-flow-refresh');
    let fail = false;
    apiGet.mockImplementation((path: string) => {
      if (path !== '/dashboard/cashflow') return Promise.reject(new Error(`unexpected path ${path}`));
      return fail
        ? Promise.reject(new Error('Could not refresh cashflow details.'))
        : Promise.resolve({ granularity: 'daily', points: [
            { date: '2026-08-20', sales: 900, expenses: 400 },
            { date: '2026-08-21', sales: 1200, expenses: 600 },
          ] });
    });
    const queries = await mount();
    expect(await queries.findByText('Cashflow points: 2')).toBeTruthy();

    fail = true;
    invalidateServerState({ pathPrefixes: ['/dashboard/cashflow'] });
    expect(await queries.findByText("Couldn't refresh")).toBeTruthy();
    expect(queries.getByText('Cashflow points: 2')).toBeTruthy();
  });

  it('says nothing was recorded instead of drawing a flat line at zero', async () => {
    beginServerStateSession('money-flow-empty');
    apiGet.mockImplementation(() => Promise.resolve({ granularity: 'monthly', points: [
      { date: '2026-09-01', sales: 0, expenses: 0 },
      { date: '2026-10-01', sales: 0, expenses: 0 },
    ] }));
    const queries = await mount();
    expect(await queries.findByText('Nothing recorded · last 6 months')).toBeTruthy();
    expect(queries.queryByText('Switch to Monthly to see earlier money in and out.')).toBeNull();
    expect(queries.queryByText(/Cashflow points/)).toBeNull();
    expect(queries.getByRole('button', { name: 'Monthly view. Change cashflow range.' })).toBeTruthy();
  });

  it('asks for the monthly series by default', async () => {
    beginServerStateSession('money-flow-default');
    apiGet.mockImplementation(() => Promise.resolve({ granularity: 'monthly', points: [
      { date: '2026-10-01', sales: 900, expenses: 400 },
    ] }));
    const queries = await mount();
    expect(await queries.findByText('Cashflow points: 1')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/dashboard/cashflow', expect.objectContaining({ granularity: 'monthly' }));
  });
});
