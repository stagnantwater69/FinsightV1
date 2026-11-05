import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as fixtures from './support/fixtures';
import { testScreen } from './support/screen';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const business = { ...fixtures.businessProfile, timezone: 'Asia/Manila' };

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: vi.fn(),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'Request failed.'),
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ selected: business, profiles: [business], categories: fixtures.categories }),
}));
vi.mock('../../src/components/AskFinSightFab', () => ({ AskFinSightFab: () => null, FAB_CLEARANCE: 0 }));

const { PaymentCalendarScreen: Typed } = await import('../../src/screens/PaymentCalendarScreen');
const PaymentCalendarScreen = testScreen(Typed);
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { clearServerStateCache } = await import('../../src/lib/serverStateCache');

const rent = {
  id: 7, businessProfileId: 1, categoryId: 11, categoryName: 'Utilities', label: 'Shop rent', vendor: 'Landlord',
  intervalDays: 30, expectedAmount: 12000, amountTolerance: 0.15, nextDueDate: '2026-11-05T00:00:00.000Z',
  lastRecordedDate: null, isActive: true, sourcePatternId: null, dueState: 'DUE_SOON',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};
const water = {
  id: 3, description: 'Water bill', vendor: null, intervalDays: 30, expectedAmount: 800, confidence: 0.8,
  nextExpectedDate: '2026-11-12T00:00:00.000Z', status: 'CANDIDATE', category: { name: 'Utilities' },
};

function serve({ schedules = [rent], patterns = [water] }: { schedules?: unknown[]; patterns?: unknown[] } = {}) {
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/insights/recurring-schedules') return schedules;
    if (path === '/insights/recurring-patterns') return patterns;
    if (path.endsWith('/operating-schedule')) return [];
    if (path.endsWith('/operating-overrides')) return { items: [], nextCursor: null };
    throw new Error(`Unexpected path ${path}`);
  });
}

function mount() {
  const navigation = { navigate: vi.fn(), setParams: vi.fn() };
  const screen = render(
    <ThemeProvider initialMode="light">
      <PaymentCalendarScreen navigation={navigation} route={{ params: undefined }} />
    </ThemeProvider>,
  );
  return { navigation, screen };
}

beforeEach(() => {
  clearServerStateCache();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  // 10:00 on 5 November in Manila.
  vi.setSystemTime(new Date('2026-11-05T02:00:00.000Z'));
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

describe('Payment calendar', () => {
  it('opens on today and lists the payment due', async () => {
    serve();
    const { screen } = mount();
    const q = await screen;
    expect(await q.findByText('November 2026')).toBeTruthy();
    expect(q.getByText('Thursday, November 5')).toBeTruthy();
    expect(q.getByText('Shop rent')).toBeTruthy();
    expect(q.getByRole('button', { name: /Thursday, November 5, today, 1 payment/ })).toBeTruthy();
  });

  it('records a due payment through the expense form, filled in from the schedule', async () => {
    serve();
    const { navigation, screen } = mount();
    const q = await screen;
    await fireEvent.press(await q.findByRole('button', { name: 'Record payment for Shop rent' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Records', {
      screen: 'AddExpense',
      initial: false,
      params: {
        prefill: { description: 'Shop rent', vendor: 'Landlord', categoryId: 11, amount: 12000 },
        from: 'PaymentCalendar',
      },
    });
  });

  it('asks before recording a second payment in the same cycle', async () => {
    serve({ schedules: [{ ...rent, lastRecordedDate: '2026-10-30T00:00:00.000Z' }] });
    const { navigation, screen } = mount();
    const q = await screen;
    await fireEvent.press(await q.findByRole('button', { name: 'Record payment for Shop rent' }));
    expect(q.getByText('Already paid?')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole('button', { name: 'Record another' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Records', expect.objectContaining({ screen: 'AddExpense' }));
  });

  it('skips a cycle by moving the due date one interval on', async () => {
    serve();
    apiPatch.mockResolvedValue({});
    const { screen } = mount();
    const q = await screen;
    await fireEvent.press(await q.findByRole('button', { name: 'Skip this time: Shop rent' }));
    await fireEvent.press(q.getByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/insights/recurring-schedules/7', { nextDueDate: '2026-12-05' }, { cacheScope: { businessProfileId: 1 } }),
    );
  });

  it('shows a suggestion on its day and watches it on request', async () => {
    serve();
    apiPost.mockResolvedValue({});
    const { screen } = mount();
    const q = await screen;
    await fireEvent.press(await q.findByRole('button', { name: /Thursday, November 12, 1 payment/ }));
    expect(q.getByText('Water bill')).toBeTruthy();
    expect(q.getByText('Suggested by FinSight')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Watch Water bill' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/insights/recurring-patterns/3/confirm', undefined, { cacheScope: { businessProfileId: 1 } }),
    );
  });

  it('pages to the next month and back', async () => {
    serve();
    const { screen } = mount();
    const q = await screen;
    await fireEvent.press(await q.findByRole('button', { name: 'Next month' }));
    expect(q.getByText('December 2026')).toBeTruthy();
    // The watched rent is projected, not due, a cycle later.
    await fireEvent.press(q.getByRole('button', { name: /Saturday, December 5, 1 payment/ }));
    expect(q.getByText('Pays the Nov 5 payment first.')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Back to this month' }));
    expect(q.getByText('November 2026')).toBeTruthy();
  });

  it('offers to add a payment when there is nothing to show', async () => {
    serve({ schedules: [], patterns: [] });
    const { navigation, screen } = mount();
    const q = await screen;
    expect(await q.findByText('No payments to show yet')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Add a recurring payment' }));
    expect(navigation.navigate).toHaveBeenCalledWith('RecurringSchedule', {});
  });
});
