import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecordItem } from '../../src/lib/types';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();

vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: vi.fn(),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: { ...fixtures.businessProfile, expectedMonthlyExpenses: 10000, largeExpenseThresholdPercent: 5 },
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

const { FlagDetailScreen } = await import('../../src/screens/records/FlagDetailScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

function rec(id: number, extra: Partial<RecordItem> = {}): RecordItem {
  return {
    id,
    type: 'expense',
    businessProfileId: fixtures.businessProfile.id,
    categoryId: 10,
    duplicateOfRecordId: null,
    date: '2026-10-13',
    description: `Paper takeaway bags x200; purchase E00${id}`,
    amount: 240,
    source: 'MANUAL_ENTRY',
    reviewStatus: 'Reviewed',
    duplicateStatus: 'Not a Duplicate',
    largeExpenseFlag: false,
    createdAt: '2026-10-13T02:00:00.000Z',
    ...extra,
  } as RecordItem;
}

const navigation = { navigate: vi.fn(), goBack: vi.fn(), reset: vi.fn(), setParams: vi.fn(), getState: () => ({ index: 1 }) };

function renderScreen(record: RecordItem) {
  return render(
    <ThemeProvider initialMode="light">
      <FlagDetailScreen {...({ navigation, route: { key: 'FlagDetail', name: 'FlagDetail', params: { record } } } as any)} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  Object.values(navigation).forEach((fn) => typeof fn === 'function' && 'mockReset' in fn && (fn as any).mockReset());
  apiGet.mockImplementation((path: string) => {
    const id = Number(path.split('/').pop());
    return Promise.resolve({ ...rec(id), origin: null });
  });
});

afterEach(cleanup);

describe('FlagDetailScreen', () => {
  it('shows the flagged copy above the record it may duplicate', async () => {
    const queries = await renderScreen(rec(201, { duplicateStatus: 'Flagged', duplicateOfRecordId: 9 }));
    expect(queries.getByText('Possible duplicate of #9')).toBeTruthy();
    expect(queries.getByText('Paper takeaway bags x200; purchase E00201')).toBeTruthy();
    expect(await queries.findByText('Paper takeaway bags x200; purchase E009')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/records/expenses/9');
  });

  it('explains a duplicate flag: what matches the original and what each choice does', async () => {
    const queries = await renderScreen(rec(201, { duplicateStatus: 'Flagged', duplicateOfRecordId: 9 }));
    expect(queries.getByText('Why this was flagged')).toBeTruthy();
    expect(queries.getByText(/^It has the same date and amount as record #9/)).toBeTruthy();
    expect(await queries.findByText('Dates match')).toBeTruthy();
    expect(queries.getByText('Amounts match')).toBeTruthy();
    expect(queries.getByText('Descriptions differ')).toBeTruthy();
    expect(queries.getByText(/record #9 stays exactly as it is/)).toBeTruthy();
  });

  it('explains a large-expense flag against the business limit', async () => {
    const queries = await renderScreen(rec(203, { largeExpenseFlag: true, amount: 900 }));
    expect(queries.getByText(/over your PHP 500 large-expense limit: 5% of the PHP 10,000/)).toBeTruthy();
    expect(queries.getByText(/It is marked reviewed and the flag is cleared/)).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Edit' }));
    expect(navigation.navigate).toHaveBeenCalledWith('EditRecord', { record: expect.objectContaining({ id: 203 }) });
  });

  it('keeps a duplicate and returns to the Review tab', async () => {
    apiPost.mockResolvedValue({ resolved: 1 });
    const queries = await renderScreen(rec(201, { duplicateStatus: 'Flagged', duplicateOfRecordId: 9 }));
    await fireEvent.press(queries.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith('/records/duplicates/resolve', {
      businessProfileId: fixtures.businessProfile.id, action: 'keep', expenseIds: [201], salesIds: [],
    }));
    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('Insights', { screen: 'ExpenseBehavior', params: { section: 'alerts' } }));
  });

  it('sends nothing on Discard until the owner confirms', async () => {
    apiPost.mockResolvedValue({ resolved: 1 });
    const queries = await renderScreen(rec(202, { duplicateStatus: 'Flagged', duplicateOfRecordId: 9 }));
    await fireEvent.press(queries.getByRole('button', { name: 'Discard' }));
    expect(apiPost).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Discard 1' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith('/records/duplicates/resolve', {
      businessProfileId: fixtures.businessProfile.id, action: 'discard', expenseIds: [202], salesIds: [],
    }));
  });

  it('marks a large expense reviewed', async () => {
    apiPatch.mockResolvedValue({});
    const queries = await renderScreen(rec(203, { largeExpenseFlag: true }));
    expect(queries.queryByRole('button', { name: 'Discard' })).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Mark as reviewed' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledExactlyOnceWith(
      '/records/expenses/203',
      { duplicateStatus: 'Not a Duplicate', reviewStatus: 'Reviewed' },
      { cacheScope: { businessProfileId: fixtures.businessProfile.id } },
    ));
  });

  it('still lets the owner decide when the original cannot be loaded', async () => {
    apiGet.mockImplementation((path: string) => path.endsWith('/9') ? Promise.reject(new Error('Not found')) : Promise.resolve({ ...rec(204), origin: null }));
    const queries = await renderScreen(rec(204, { duplicateStatus: 'Flagged', duplicateOfRecordId: 9 }));
    expect(await queries.findByText("Record #9 couldn't be shown. It may have been deleted.")).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Keep' })).toBeTruthy();
  });
});
