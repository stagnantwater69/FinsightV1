import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import * as fixtures from './support/fixtures';
import type { RecordItem } from '../../src/lib/types';

const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const navigate = vi.fn();
const setParams = vi.fn();
const setParentParams = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({
    children,
    renderLeftActions,
    renderRightActions,
  }: {
    children: React.ReactNode;
    renderLeftActions?: () => React.ReactNode;
    renderRightActions?: () => React.ReactNode;
  }) => (
    <>
      {renderLeftActions?.()}
      {children}
      {renderRightActions?.()}
    </>
  ),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  default: () => null,
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
    post: vi.fn(),
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Something went wrong.',
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: fixtures.businessProfile,
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

const { RecordsScreen } = await import('../../src/screens/records/RecordsListScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { beginServerStateSession, clearServerStateCache } = await import('../../src/lib/serverStateCache');

const navigation = {
  navigate,
  setParams,
  getParent: () => ({ setParams: setParentParams }),
};
const route = { params: {} };

function record(id: number, description: string): RecordItem {
  return {
    id,
    type: 'expense',
    businessProfileId: fixtures.businessProfile.id,
    categoryId: fixtures.categories[0]!.id,
    duplicateOfRecordId: null,
    date: '2026-08-20',
    description,
    amount: 1200,
    source: 'MANUAL_ENTRY',
    reviewStatus: 'Needs Review',
    duplicateStatus: 'Flagged',
    largeExpenseFlag: true,
    createdAt: '2026-08-20T02:00:00.000Z',
  };
}

function searchCalls() {
  return apiGet.mock.calls.filter((call) => call[0] === '/records/search');
}

function routePages() {
  apiGet.mockImplementation(async (path: string, query?: Record<string, unknown>) => {
    if (path !== '/records/search') throw new Error(`Unexpected path ${path}`);
    if (query?.cursor === 'cursor-1') {
      return { items: [record(2, 'Second page purchase')], nextCursor: null };
    }
    return { items: [record(1, 'First page purchase')], nextCursor: 'cursor-1' };
  });
}

async function renderScreen() {
  return render(
    <ThemeProvider initialMode="light">
      <RecordsScreen navigation={navigation} route={route} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  clearServerStateCache();
  beginServerStateSession(7);
  apiGet.mockReset();
  apiPatch.mockReset().mockResolvedValue(undefined);
  apiDelete.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  setParams.mockReset();
  setParentParams.mockReset();
  routePages();
});

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe('RecordsScreen virtualized list behavior', () => {
  it('preserves cursor navigation between virtualized pages', async () => {
    const queries = await renderScreen();

    expect(await queries.findByText('First page purchase')).toBeTruthy();

    await fireEvent.press(queries.getByRole('button', { name: 'Next' }));
    expect(await queries.findByText('Second page purchase')).toBeTruthy();
    expect(queries.queryByText('First page purchase')).toBeNull();

    const callsAfterNext = searchCalls();
    expect(callsAfterNext).toHaveLength(2);
    expect(callsAfterNext[0]![1]).toMatchObject({
      businessProfileId: fixtures.businessProfile.id,
      limit: 50,
    });
    expect(callsAfterNext[0]![1].cursor).toBeUndefined();
    expect(callsAfterNext[1]![1]).toMatchObject({ cursor: 'cursor-1' });

    await fireEvent.press(queries.getByRole('button', { name: 'Previous' }));
    expect(await queries.findByText('First page purchase')).toBeTruthy();
    expect(searchCalls()).toHaveLength(2);
  });

  it('keeps resolve and confirmed-delete callbacks wired through swipe actions', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const queries = await renderScreen();
    await queries.findByText('First page purchase');

    await fireEvent.press(queries.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/records/expenses/1', {
        duplicateStatus: 'Not a Duplicate',
        reviewStatus: 'Reviewed',
      }, { cacheScope: { businessProfileId: fixtures.businessProfile.id } }),
    );
    expect(await queries.findByText('Marked reviewed and not a duplicate.')).toBeTruthy();

    await fireEvent.press(queries.getByRole('button', { name: 'Delete' }));
    expect(alert).toHaveBeenCalledWith(
      'Delete this record?',
      '"First page purchase" will be removed. This cannot be undone.',
      expect.any(Array),
    );
    const buttons = alert.mock.calls[0]![2] ?? [];
    const destructive = buttons.find((button) => button.style === 'destructive');
    expect(destructive).toBeTruthy();

    await act(async () => {
      await destructive?.onPress?.();
    });
    expect(apiDelete).toHaveBeenCalledWith(
      '/records/expenses/1',
      undefined,
      { cacheScope: { businessProfileId: fixtures.businessProfile.id } },
    );
    alert.mockRestore();
  });

  it('ignores a native delete callback after the business-keyed list unmounts', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const queries = await renderScreen();
    await queries.findByText('First page purchase');
    await fireEvent.press(queries.getByRole('button', { name: 'Delete' }));
    const buttons = alert.mock.calls[0]![2] ?? [];
    const destructive = buttons.find((button) => button.style === 'destructive');

    await queries.unmount();
    await act(async () => {
      await destructive?.onPress?.();
    });

    expect(apiDelete).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});
