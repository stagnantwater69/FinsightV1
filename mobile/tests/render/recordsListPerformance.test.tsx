import { testScreen } from './support/screen';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Dimensions } from 'react-native';

import * as fixtures from './support/fixtures';
import type { RecordItem } from '../../src/lib/types';

let selectedBusiness = fixtures.businessProfile;
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
    selected: selectedBusiness,
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

const { RecordsScreen: TypedRecordsScreen } = await import('../../src/screens/records/RecordsListScreen');
const RecordsScreen = testScreen(TypedRecordsScreen);
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { beginServerStateSession, clearServerStateCache, invalidateServerState } = await import('../../src/lib/serverStateCache');

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
  Dimensions.set({ window: { width: 1024, height: 768, scale: 1, fontScale: 1 }, screen: { width: 1024, height: 768, scale: 1, fontScale: 1 } });
  clearServerStateCache();
  selectedBusiness = fixtures.businessProfile;
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
  it('appends cursor batches without replacing the current loaded rows', async () => {
    const q = await renderScreen();
    await q.findByText('First page purchase');
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    expect(await q.findByText('Second page purchase')).toBeTruthy();
    expect(q.getByText('First page purchase')).toBeTruthy();
    expect(searchCalls()).toHaveLength(2);
    expect(searchCalls()[0]![1]).toMatchObject({ businessProfileId: fixtures.businessProfile.id, limit: 100 });
    expect(searchCalls()[0]![1].includeTotal).toBeUndefined();
    expect(searchCalls()[1]![1]).toMatchObject({ limit: 100, cursor: 'cursor-1' });
    expect(q.queryByRole('button', { name: 'Load more records' })).toBeNull();
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


describe('Records loaded-batch pagination', () => {
  function batchPages(total = 23) {
    apiGet.mockImplementation(async (path: string, query?: Record<string, unknown>) => {
      if (path !== '/records/search') throw new Error(`Unexpected path ${path}`);
      const offset = Number(query?.cursor ?? 0);
      return { items: Array.from({ length: Math.min(100, total - offset) }, (_, index) => record(offset + 1 + index, `Purchase ${offset + 1 + index}`)), nextCursor: offset + 100 < total ? String(offset + 100) : null };
    });
  }

  it('pages locally through all loaded rows, including the partial final page, without further API reads', async () => {
    batchPages(23);
    const q = await renderScreen();
    expect(await q.findByText('Purchase 10')).toBeTruthy();
    expect(q.getAllByText(/^Purchase \d+$/)).toHaveLength(10);
    expect(q.getByRole('button', { name: 'Go to page 3' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 2' }));
    expect(await q.findByText('Purchase 20')).toBeTruthy();
    expect(q.getAllByText(/^Purchase \d+$/)).toHaveLength(10);
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 3' }));
    expect(await q.findByText('Purchase 23')).toBeTruthy();
    expect(q.getAllByText(/^Purchase \d+$/)).toHaveLength(3);
    expect(q.getByRole('button', { name: 'Go to page 3' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Previous page' }));
    expect(await q.findByText('Purchase 20')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'First page' }));
    expect(await q.findByText('Purchase 10')).toBeTruthy();
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0]![1]).toMatchObject({ limit: 100, businessProfileId: selectedBusiness.id });
    expect(searchCalls()[0]![1].includeTotal).toBeUndefined();
  });

  it('expands loaded page totals from ten to twenty to twenty-five without moving the current page', async () => {
    batchPages(250);
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    expect(q.getByRole('button', { name: 'Go to page 10' })).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Go to page 25' })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Last page' }));
    expect(await q.findByText('Purchase 100')).toBeTruthy();
    expect(searchCalls()).toHaveLength(1);
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    await waitFor(() => expect(q.getByRole('button', { name: 'Go to page 20' })).toBeTruthy());
    expect(q.getByText('Purchase 100')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Go to page 10' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    await waitFor(() => expect(q.getByRole('button', { name: 'Go to page 25' })).toBeTruthy());
    expect(q.getByRole('button', { name: 'Go to page 10' }).props.accessibilityState.selected).toBe(true);
    expect(q.queryByRole('button', { name: 'Load more records' })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Last page' }));
    expect(await q.findByText('Purchase 250')).toBeTruthy();
    expect(q.getAllByText(/^Purchase \d+$/)).toHaveLength(10);
    expect(searchCalls().map((call) => call[1].cursor)).toEqual([undefined, '100', '200']);
    expect(searchCalls().every((call) => call[1].limit === 100 && call[1].includeTotal === undefined)).toBe(true);
  });

  it('keeps all four boundary controls functional and the selected page when the viewport becomes narrower', async () => {
    batchPages(100);
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 10' }));
    await q.findByText('Purchase 100');
    await act(async () => { Dimensions.set({ window: { width: 320, height: 768, scale: 1, fontScale: 1 }, screen: { width: 320, height: 768, scale: 1, fontScale: 1 } }); });
    expect(q.getByRole('button', { name: 'Go to page 10' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByText('Purchase 100')).toBeTruthy();
    for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) expect(q.getByRole('button', { name })).toBeTruthy();
    expect(q.getByRole('button', { name: 'Last page' }).props.accessibilityState.disabled).toBe(true);
    expect(q.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'First page' }));
    expect(await q.findByText('Purchase 10')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Go to page 1' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('button', { name: 'First page' }).props.accessibilityState.disabled).toBe(true);
    expect(q.getByRole('button', { name: 'Previous page' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Last page' }));
    expect(await q.findByText('Purchase 100')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Go to page 10' }).props.accessibilityState.selected).toBe(true);
    expect(searchCalls()).toHaveLength(1);
  });

  it('deduplicates overlapping batches by record type and ID while retaining expense/sales ID collisions', async () => {
    apiGet.mockImplementation(async (_path: string, query?: Record<string, unknown>) => query?.cursor ? { items: [record(1, 'Expense one'), { ...record(1, 'Sale one'), type: 'sales' }], nextCursor: null } : { items: [record(1, 'Expense one')], nextCursor: 'mixed' });
    const q = await renderScreen();
    await q.findByText('Expense one');
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    expect(await q.findByText('Sale one')).toBeTruthy();
    expect(q.getAllByText('Expense one')).toHaveLength(1);
    expect(q.getAllByRole('button', { name: 'Resolve' })).toHaveLength(2);
  });

  it('resolves the actual record shown on the second local page', async () => {
    batchPages(23);
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 2' }));
    await q.findByText('Purchase 20');
    await fireEvent.press(q.getAllByRole('button', { name: 'Resolve' })[0]!);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/records/expenses/11', { duplicateStatus: 'Not a Duplicate', reviewStatus: 'Reviewed' }, { cacheScope: { businessProfileId: selectedBusiness.id } }));
  });

  it.each(['search', 'type', 'category', 'business'])('resets the loaded collection and local page after changing %s', async (change) => {
    batchPages(23);
    const base = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => query?.keyword || query?.type === 'sales' || query?.categoryId || query?.businessProfileId === 99 ? Promise.resolve({ items: [{ ...record(99, 'Filtered purchase'), businessProfileId: Number(query?.businessProfileId) }], nextCursor: null }) : base(path, query));
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 2' }));
    await q.findByText('Purchase 20');
    if (change === 'search') await fireEvent.changeText(q.getByLabelText('Search descriptions'), 'supplies');
    if (change === 'type') await fireEvent.press(q.getByRole('radio', { name: 'Sales' }));
    if (change === 'category') {
      await fireEvent.press(q.getByRole('button', { name: 'Filters' }));
      await fireEvent.press(q.getByRole('button', { name: 'Category: any. Change' }));
      await fireEvent.press(q.getByRole('button', { name: fixtures.categories[0]!.name }));
      await fireEvent.press(q.getByRole('button', { name: /Show results/ }));
    }
    if (change === 'business') {
      selectedBusiness = { ...fixtures.businessProfile, id: 99, name: 'Second business' };
      await q.rerender(<ThemeProvider initialMode="light"><RecordsScreen navigation={navigation} route={route} /></ThemeProvider>);
    }
    expect(await q.findByText('Filtered purchase')).toBeTruthy();
    expect(searchCalls().at(-1)![1]).toMatchObject({ limit: 100, ...(change === 'search' ? { keyword: 'supplies' } : change === 'type' ? { type: 'sales' } : change === 'category' ? { categoryId: fixtures.categories[0]!.id } : { businessProfileId: 99 }) });
    expect(searchCalls().at(-1)![1].cursor).toBeUndefined();
    expect(q.queryByText('Purchase 11')).toBeNull();
    expect(q.queryByRole('button', { name: 'Go to page 3' })).toBeNull();
  });

  it('keeps loaded rows on append failure and retries the same batch cursor', async () => {
    let failed = true;
    batchPages(200);
    const base = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => query?.cursor && failed ? Promise.reject(new Error('More records unavailable')) : base(path, query));
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    expect(await q.findByText(/More records unavailable/)).toBeTruthy();
    expect(q.getByText('Purchase 10')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Go to page 10' })).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Go to page 20' })).toBeNull();
    failed = false;
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    await waitFor(() => expect(q.getByRole('button', { name: 'Go to page 20' })).toBeTruthy());
    expect(q.getByText('Purchase 10')).toBeTruthy();
    expect(searchCalls().slice(-2).map((call) => call[1].cursor)).toEqual(['100', '100']);
  });

  it('ignores an old business batch append after switching businesses', async () => {
    let finish!: (page: { items: RecordItem[]; nextCursor: null }) => void;
    const pending = new Promise<{ items: RecordItem[]; nextCursor: null }>((resolve) => { finish = resolve; });
    batchPages(200);
    const base = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (query?.businessProfileId === 99) return Promise.resolve({ items: [{ ...record(99, 'Second business purchase'), businessProfileId: 99 }], nextCursor: null });
      return query?.cursor ? pending : base(path, query);
    });
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    selectedBusiness = { ...fixtures.businessProfile, id: 99, name: 'Second business' };
    await q.rerender(<ThemeProvider initialMode="light"><RecordsScreen navigation={navigation} route={route} /></ThemeProvider>);
    expect(await q.findByText('Second business purchase')).toBeTruthy();
    await act(async () => { finish({ items: [record(101, 'Late first business purchase')], nextCursor: null }); await pending; });
    expect(q.queryByText('Late first business purchase')).toBeNull();
    expect(q.getByText('Second business purchase')).toBeTruthy();
  });

  it('clamps the local page after deleting the only record on its last page', async () => {
    batchPages(11);
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Go to page 2' }));
    await q.findByText('Purchase 11');
    await fireEvent.press(q.getByRole('button', { name: 'Delete' }));
    const confirm = alert.mock.calls[0]![2]?.find((button) => button.style === 'destructive');
    await act(async () => { await confirm?.onPress?.(); });
    expect(apiDelete).toHaveBeenCalledWith('/records/expenses/11', undefined, { cacheScope: { businessProfileId: selectedBusiness.id } });
    expect(await q.findByText('Purchase 10')).toBeTruthy();
    expect(q.queryByText('Purchase 11')).toBeNull();
    expect(q.queryByRole('button', { name: 'Go to page 2' })).toBeNull();
    alert.mockRestore();
  });

  it('restores a failed deletion without losing a concurrently appended batch', async () => {
    let failDelete!: (error: Error) => void;
    const pendingDelete = new Promise<void>((_resolve, reject) => { failDelete = reject; });
    apiDelete.mockReturnValue(pendingDelete);
    apiGet.mockImplementation(async (_path: string, query?: Record<string, unknown>) => query?.cursor ? { items: [record(3, 'Appended purchase')], nextCursor: null } : { items: [record(1, 'Deleted purchase'), record(2, 'Other purchase')], nextCursor: 'tail' });
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const q = await renderScreen();
    await q.findByText('Deleted purchase');
    await fireEvent.press(q.getAllByRole('button', { name: 'Delete' })[0]!);
    const confirm = alert.mock.calls[0]![2]?.find((button) => button.style === 'destructive');
    let deleting: unknown;
    await act(async () => { deleting = confirm?.onPress?.(); });
    expect(q.queryByText('Deleted purchase')).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    expect(await q.findByText('Appended purchase')).toBeTruthy();
    await act(async () => { failDelete(new Error('Delete failed')); await deleting; });
    expect(await q.findByText('Deleted purchase')).toBeTruthy();
    expect(q.getByText('Other purchase')).toBeTruthy();
    expect(q.getByText('Appended purchase')).toBeTruthy();
    alert.mockRestore();
  });

  it('drops loaded tails and resets to the first local page when the front data refreshes', async () => {
    let refreshed = false;
    batchPages(200);
    const base = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((path: string, query?: Record<string, unknown>) => refreshed ? Promise.resolve({ items: [record(99, 'Refreshed purchase')], nextCursor: null }) : base(path, query));
    const q = await renderScreen();
    await q.findByText('Purchase 10');
    await fireEvent.press(q.getByRole('button', { name: 'Load more records' }));
    await waitFor(() => expect(q.getByRole('button', { name: 'Go to page 20' })).toBeTruthy());
    await fireEvent.press(q.getByRole('button', { name: 'Last page' }));
    await q.findByText('Purchase 200');
    refreshed = true;
    await act(async () => { invalidateServerState({ businessProfileId: selectedBusiness.id, pathPrefixes: ['/records/search'] }); });
    expect(await q.findByText('Refreshed purchase')).toBeTruthy();
    expect(q.queryByText('Purchase 200')).toBeNull();
    expect(q.queryByRole('button', { name: 'Go to page 20' })).toBeNull();
  });
});
