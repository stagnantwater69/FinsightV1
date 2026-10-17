import React from 'react';
import { TextInput } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as fixtures from './support/fixtures';

const apiGet = vi.fn();
const business = { ...fixtures.businessProfile, timezone: 'Asia/Manila' };
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock('../../src/lib/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed.',
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ selected: business, profiles: [business], categories: fixtures.categories }),
}));
vi.mock('../../src/components/DateField', () => ({
  DateField: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) =>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} />,
}));

const { OperatingScheduleScreen } = await import('../../src/screens/OperatingScheduleScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const path = `/business-profiles/${business.id}/operating-overrides`;
const cursor = 'older-special-dates';
const firstRows = Array.from({ length: 50 }, (_, index) => ({
  id: index + 1, businessProfileId: business.id,
  date: new Date(Date.UTC(2026, 9, index + 3)).toISOString().slice(0, 10),
  type: 'CLOSED', reason: `Closure ${index + 1}`,
}));
const olderRows = [
  { ...firstRows[0]!, reason: 'Updated overlapping closure' },
  { id: 52, businessProfileId: business.id, date: '2026-10-02', type: 'OPEN', reason: 'Older opening' },
  { id: 51, businessProfileId: business.id, date: '2026-10-01', type: 'CLOSED', reason: 'Older closure' },
];
function mockPages(failFirstContinuation = false) {
  let continuationAttempts = 0;
  apiGet.mockImplementation(async (requestPath: string, query?: { cursor?: string }) => {
    if (requestPath.endsWith('/operating-schedule')) return [];
    if (requestPath !== path) throw new Error(`Unexpected path ${requestPath}`);
    if (!query?.cursor) return { items: [...firstRows].reverse(), nextCursor: cursor };
    if (query.cursor !== cursor) throw new Error('Unexpected cursor');
    continuationAttempts += 1;
    if (failFirstContinuation && continuationAttempts === 1) throw new Error('Could not load older special dates.');
    return { items: olderRows, nextCursor: null };
  });
}
function mount() {
  return render(<ThemeProvider initialMode="light"><OperatingScheduleScreen /></ThemeProvider>);
}
function visibleDates(screen: Awaited<ReturnType<typeof render>>) {
  return screen.getAllByText(/^2026-\d{2}-\d{2}$/).map((node) => node.props.children);
}

beforeEach(() => {
  apiGet.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T16:30:00.000Z'));
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Operating schedule special-date pages', () => {
  it('loads 50 dates, appends the older page once, and deduplicates in calendar order', async () => {
    mockPages();
    const screen = await mount();
    const loadMore = await screen.findByRole('button', { name: 'Load more special dates' });
    expect(apiGet).toHaveBeenCalledWith(path, {
      pageSize: 50, from: '2026-10-01', to: '2026-11-30', cursor: undefined,
    });
    expect(visibleDates(screen)).toEqual(firstRows.map((row) => row.date));
    await fireEvent.press(loadMore);
    await waitFor(() => expect(visibleDates(screen)).toHaveLength(52));
    expect(apiGet).toHaveBeenLastCalledWith(path, {
      pageSize: 50, from: '2026-10-01', to: '2026-11-30', cursor,
    });
    expect(visibleDates(screen)).toEqual(['2026-10-01', '2026-10-02', ...firstRows.map((row) => row.date)]);
    expect(screen.getAllByText('2026-10-03')).toHaveLength(1);
    expect(screen.getByText('Closed · Updated overlapping closure')).toBeTruthy();
    expect(screen.queryByText('Closed · Closure 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more special dates' })).toBeNull();
    expect(apiGet.mock.calls.filter(([requestPath]) => requestPath === path)).toHaveLength(2);
  });

  it('retains loaded dates after an older-page failure and retries the same continuation', async () => {
    mockPages(true);
    const screen = await mount();
    await fireEvent.press(await screen.findByRole('button', { name: 'Load more special dates' }));
    expect(await screen.findByText('Could not load older special dates.')).toBeTruthy();
    expect(visibleDates(screen)).toEqual(firstRows.map((row) => row.date));
    expect(screen.queryByText('No special dates yet')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry special dates' }));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith(path, {
      pageSize: 50, from: '2026-10-01', to: '2026-11-30', cursor,
    }));
    await waitFor(() => expect(visibleDates(screen)).toHaveLength(52));
    expect(visibleDates(screen)).toEqual(['2026-10-01', '2026-10-02', ...firstRows.map((row) => row.date)]);
    expect(screen.queryByText('Could not load older special dates.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more special dates' })).toBeNull();
  });
});
