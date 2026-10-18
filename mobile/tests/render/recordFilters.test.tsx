import { testScreen } from './support/screen';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

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

const { RecordsScreen: TypedRecordsScreen } = await import('../../src/screens/records/RecordsListScreen');
const RecordsScreen = testScreen(TypedRecordsScreen);
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
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/records/search') return { items: [record(1, 'Shop rent')], nextCursor: null };
    if (path === '/records/flagged/count') return { expenses: 0, sales: 0, total: 0 };
    if (path.includes('import')) return [];
    throw new Error(`Unexpected path ${path}`);
  });
});

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe('Records filters', () => {
  it('reaches an older import page and filters records by the chosen older batch', async () => {
    apiGet.mockImplementation(async (path: string, query?: { cursor?: string }) => {
      if (path === '/records/csv-imports/batches') return query?.cursor
        ? { items: [{ id: 5, title: 'Newer inventory' }, { id: 4, title: 'Older stock count' }], nextCursor: null }
        : { items: [{ id: 5, title: 'Newer inventory' }], nextCursor: 'older-imports' };
      if (path === '/records/search') return { items: [record(1, 'Shop rent')], nextCursor: null };
      if (path === '/records/flagged/count') return { expenses: 0, sales: 0, total: 0 };
      throw new Error(`Unexpected path ${path}`);
    });
    const queries = await renderScreen();
    await queries.findByText('Shop rent');
    await fireEvent.press(queries.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(queries.getByRole('button', { name: 'CSV file' }));
    await queries.findByRole('button', { name: 'Newer inventory' });
    await fireEvent.press(queries.getByRole('button', { name: 'Load older imports' }));
    await queries.findByRole('button', { name: 'Older stock count' });
    expect(queries.getAllByRole('button', { name: 'Newer inventory' })).toHaveLength(1);
    expect(apiGet).toHaveBeenCalledWith('/records/csv-imports/batches', expect.objectContaining({ businessProfileId: fixtures.businessProfile.id, pageSize: 50, cursor: 'older-imports' }));
    await fireEvent.press(queries.getByRole('button', { name: 'Older stock count' }));
    await waitFor(() => expect(searchCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ importBatchId: 4, source: 'CSV_UPLOAD' })));
    await fireEvent.press(queries.getByRole('button', { name: 'Show results' }));
    expect(queries.getByRole('button', { name: 'Remove filter: Older stock count' })).toBeTruthy();
  });

  it('retains loaded imports after an older page fails and retries the same cursor', async () => {
    let olderAttempts = 0;
    apiGet.mockImplementation(async (path: string, query?: { cursor?: string }) => {
      if (path === '/records/csv-imports/batches') {
        if (!query?.cursor) return { items: [{ id: 5, title: 'Loaded import' }], nextCursor: 'older-imports' };
        olderAttempts += 1;
        if (olderAttempts === 1) throw new Error('Older imports unavailable');
        return { items: [{ id: 4, title: 'Recovered older import' }], nextCursor: null };
      }
      if (path === '/records/search') return { items: [record(1, 'Shop rent')], nextCursor: null };
      if (path === '/records/flagged/count') return { expenses: 0, sales: 0, total: 0 };
      throw new Error(`Unexpected path ${path}`);
    });
    const queries = await renderScreen();
    await queries.findByText('Shop rent');
    await fireEvent.press(queries.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(queries.getByRole('button', { name: 'CSV file' }));
    await queries.findByRole('button', { name: 'Loaded import' });
    await fireEvent.press(queries.getByRole('button', { name: 'Load older imports' }));
    await queries.findByText('Older imports unavailable');
    expect(queries.getByRole('button', { name: 'Loaded import' })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Retry imports' }));
    await queries.findByRole('button', { name: 'Recovered older import' });
    expect(apiGet.mock.calls.filter(([path, query]) => path === '/records/csv-imports/batches' && query?.cursor).map(([, query]) => query.cursor)).toEqual(['older-imports', 'older-imports']);
    expect(queries.queryByText('Older imports unavailable')).toBeNull();
  });

  it('keeps the filters in a sheet behind one button, with nothing filtered at first', async () => {
    const queries = await renderScreen();
    expect(await queries.findByText('Shop rent')).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Filters' })).toBeTruthy();
    expect(queries.queryByText('How it was added')).toBeNull();
    expect(queries.queryByText('Clear all')).toBeNull();
  });

  it('applies a source chosen in the sheet, shows it as a removable chip, and removes it', async () => {
    const queries = await renderScreen();
    await queries.findByText('Shop rent');
    await fireEvent.press(queries.getByRole('button', { name: 'Filters' }));
    expect(queries.getByText('How it was added')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Receipt' }));
    await waitFor(() => expect(searchCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ source: 'RECEIPT_SCAN' })));
    await fireEvent.press(queries.getByRole('button', { name: 'Show results' }));

    expect(await queries.findByRole('button', { name: 'Filters, 1 on' })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Remove filter: Receipt' }));
    // The unfiltered page is already cached, so the list returns without a new request.
    expect(await queries.findByRole('button', { name: 'Filters' })).toBeTruthy();
    expect(queries.queryByRole('button', { name: 'Remove filter: Receipt' })).toBeNull();
  });

  it('picks a category from a searchable list inside the sheet', async () => {
    const queries = await renderScreen();
    await queries.findByText('Shop rent');
    await fireEvent.press(queries.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(queries.getByRole('button', { name: /^Category: any/ }));
    const target = fixtures.categories[1]!;
    await fireEvent.changeText(queries.getByLabelText('Search categories'), target.name.slice(0, 4));
    await fireEvent.press(queries.getByRole('button', { name: target.name }));
    await waitFor(() => expect(searchCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ categoryId: target.id })));
    expect(queries.getByRole('button', { name: `Category: ${target.name}. Change` })).toBeTruthy();
  });

  it('says so when the category search matches nothing', async () => {
    const queries = await renderScreen();
    await queries.findByText('Shop rent');
    await fireEvent.press(queries.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(queries.getByRole('button', { name: /^Category: any/ }));
    expect(queries.queryByText(/No categories match/)).toBeNull();
    await fireEvent.changeText(queries.getByLabelText('Search categories'), 'zzzz');
    expect(queries.getByText('No categories match "zzzz".')).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Any category' })).toBeTruthy();
  });

  it('switches record type with the small chips', async () => {
    const queries = await renderScreen();
    await queries.findByText('Shop rent');
    await fireEvent.press(queries.getByRole('radio', { name: 'Sales' }));
    await waitFor(() => expect(searchCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ type: 'sales' })));
  });
});
