import { testScreen } from './support/screen';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';

import * as fixtures from './support/fixtures';
import type { BusinessProfile, RecordItem, RecurringSchedule } from '../../src/lib/types';

const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const apiPost = vi.fn();
const goBack = vi.fn();
const businessA = fixtures.businessProfile;
const businessB = { ...fixtures.businessProfile, id: 2, name: 'Second business' } as BusinessProfile;
let currentBusinessProfile: BusinessProfile = businessA;

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('@react-native-community/datetimepicker', () => ({ default: () => null }));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Something went wrong.',
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [businessA, businessB],
    selected: currentBusinessProfile,
    categories: fixtures.categories,
    categoriesLoading: false,
    categoriesError: null,
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories: vi.fn(),
    createCategory: vi.fn(),
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { EditRecordScreen: TypedEditRecordScreen } = await import('../../src/screens/records/EditRecordScreen');
const EditRecordScreen = testScreen(TypedEditRecordScreen);
const { RecurringScheduleScreen: TypedRecurringScheduleScreen } = await import('../../src/screens/RecurringScheduleScreen');
const RecurringScheduleScreen = testScreen(TypedRecurringScheduleScreen);
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const recordA: RecordItem = {
  id: 71,
  type: 'expense',
  businessProfileId: 1,
  categoryId: fixtures.categories[0]!.id,
  duplicateOfRecordId: null,
  date: '2026-09-12',
  description: 'Business A private record',
  vendor: 'A-only vendor',
  amount: 1800,
  source: 'MANUAL_ENTRY',
  reviewStatus: 'Needs Review',
  duplicateStatus: 'Flagged',
  largeExpenseFlag: false,
  createdAt: '2026-09-12T02:00:00.000Z',
};

const scheduleA: RecurringSchedule = {
  id: 91,
  businessProfileId: 1,
  categoryId: fixtures.categories[1]!.id,
  categoryName: 'Utilities',
  label: 'Business A private schedule',
  vendor: 'A-only utility',
  intervalDays: 30,
  expectedAmount: 2400,
  amountTolerance: 0.15,
  nextDueDate: '2026-10-15T00:00:00.000Z',
  lastRecordedDate: null,
  isActive: true,
  sourcePatternId: null,
  dueState: 'SCHEDULED',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function editRecordTree() {
  return (
    <ThemeProvider initialMode="light">
      <EditRecordScreen route={{ params: { record: recordA } }} navigation={{ goBack }} />
    </ThemeProvider>
  );
}

function recurringTree() {
  return (
    <ThemeProvider initialMode="light">
      <RecurringScheduleScreen route={{ params: { scheduleId: scheduleA.id } }} navigation={{ goBack }} />
    </ThemeProvider>
  );
}

function pressHandler(node: { unstable_fiber?: any }): () => unknown {
  let fiber = node.unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onPress === 'function') return fiber.memoizedProps.onPress;
    fiber = fiber.return;
  }
  throw new Error('Button has no press handler');
}

beforeEach(() => {
  currentBusinessProfile = businessA;
  apiGet.mockReset();
  apiPatch.mockReset().mockResolvedValue(undefined);
  apiDelete.mockReset().mockResolvedValue(undefined);
  apiPost.mockReset().mockResolvedValue(undefined);
  goBack.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('mounted detail screen business isolation', () => {
  it('hides an A record immediately under B and rejects stale PATCH and DELETE callbacks', async () => {
    apiGet.mockResolvedValue({ origin: null });
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const queries = await render(editRecordTree());

    expect((await queries.findByLabelText('Description')).props.value).toBe('Business A private record');
    const staleSave = pressHandler(queries.getByRole('button', { name: 'Save changes' }));
    await fireEvent.press(queries.getByRole('button', { name: 'Delete record' }));
    const destructive = (alert.mock.calls[0]?.[2] ?? []).find((button) => button.style === 'destructive');

    currentBusinessProfile = businessB;
    await queries.rerender(editRecordTree());

    expect(queries.getByText('Record unavailable')).toBeTruthy();
    expect(queries.queryByLabelText('Description')).toBeNull();
    expect(queries.queryByLabelText('Vendor')).toBeNull();
    expect(queries.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(queries.queryByRole('button', { name: 'Delete record' })).toBeNull();

    await act(async () => {
      await staleSave();
      await destructive?.onPress?.();
    });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('invalidates a native record-delete callback when the keyed navigator unmounts', async () => {
    apiGet.mockResolvedValue({ origin: null });
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const queries = await render(editRecordTree());
    expect((await queries.findByLabelText('Description')).props.value).toBe('Business A private record');
    await fireEvent.press(queries.getByRole('button', { name: 'Delete record' }));
    const destructive = (alert.mock.calls[0]?.[2] ?? []).find((button) => button.style === 'destructive');

    await queries.unmount();
    await act(async () => {
      await destructive?.onPress?.();
    });
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('never re-renders an A schedule while B is loading or after B reports it missing', async () => {
    let resolveBusinessB: (rows: RecurringSchedule[]) => void = () => {};
    const businessBResult = new Promise<RecurringSchedule[]>((resolve) => {
      resolveBusinessB = resolve;
    });
    apiGet.mockImplementation(
      (_path: string, query?: { businessProfileId?: number }) =>
        query?.businessProfileId === 1 ? Promise.resolve([scheduleA]) : businessBResult,
    );
    const queries = await render(recurringTree());

    expect((await queries.findByLabelText('What is it')).props.value).toBe('Business A private schedule');
    const staleSave = pressHandler(queries.getByRole('button', { name: 'Save changes' }));
    await fireEvent.press(queries.getByRole('button', { name: 'Remove this payment' }));
    const staleRemove = pressHandler(queries.getByRole('button', { name: 'Remove' }));

    currentBusinessProfile = businessB;
    await queries.rerender(recurringTree());
    expect(queries.queryByLabelText('What is it')).toBeNull();
    expect(queries.queryByLabelText('Paid to (optional)')).toBeNull();
    expect(queries.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(queries.queryByRole('button', { name: 'Remove this payment' })).toBeNull();

    await act(async () => {
      resolveBusinessB([]);
      await businessBResult;
    });
    expect(await queries.findByText('Repeating payment unavailable')).toBeTruthy();
    expect(queries.queryByLabelText('What is it')).toBeNull();

    await act(async () => {
      await staleSave();
      staleRemove();
    });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('does not restore A schedule fields when the B fetch fails', async () => {
    apiGet.mockImplementation(
      (_path: string, query?: { businessProfileId?: number }) =>
        query?.businessProfileId === 1
          ? Promise.resolve([scheduleA])
          : Promise.reject(new Error('Could not load B schedule.')),
    );
    const queries = await render(recurringTree());
    expect((await queries.findByLabelText('What is it')).props.value).toBe('Business A private schedule');

    currentBusinessProfile = businessB;
    await queries.rerender(recurringTree());

    expect(await queries.findByText('Could not load B schedule.')).toBeTruthy();
    expect(queries.queryByLabelText('What is it')).toBeNull();
    expect(queries.queryByLabelText('Paid to (optional)')).toBeNull();
  });
});
