import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { FutureDatedRecords } from '../../src/lib/types';

const apiGet = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.'),
}));

const { FutureDatedNotice } = await import('../../src/components/FutureDatedNotice');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { clearServerStateCache } = await import('../../src/lib/serverStateCache');

const onOpen = vi.fn();

const found: FutureDatedRecords = {
  today: '2026-08-20',
  total: 3,
  truncated: true,
  records: [
    { id: 7, type: 'expense', date: '2027-08-25', description: 'Rice sacks', amount: 1500, vendor: 'Divisoria', categoryName: 'Stock' },
    { id: 8, type: 'sales', date: '2026-09-01', description: 'Walk-in sales', amount: 900, vendor: null, categoryName: null },
  ],
};

function renderNotice() {
  return render(
    <ThemeProvider initialMode="light">
      <FutureDatedNotice businessProfileId={1} onOpen={onOpen} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  clearServerStateCache();
  apiGet.mockReset();
  onOpen.mockReset();
});

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe('Future-dated records notice', () => {
  it('says how many records are left out and lists the ones to fix', async () => {
    apiGet.mockResolvedValue(found);
    const queries = await renderNotice();

    expect(await queries.findByText(/3 records are dated after 2026-08-20/)).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Fix Rice sacks, dated 2027-08-25' })).toBeTruthy();
    expect(queries.getByText('Dated 2026-09-01')).toBeTruthy();
    expect(queries.getByText('Showing 2 of 3. The rest appear as these are fixed.')).toBeTruthy();
    expect(apiGet.mock.calls[0]![0]).toBe('/records/future-dated');
  });

  it('loads the whole record before handing it to the edit screen', async () => {
    const record = { id: 8, type: 'sales', businessProfileId: 1 };
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path === '/records/sales/8' ? record : found));
    const queries = await renderNotice();

    await fireEvent.press(await queries.findByRole('button', { name: 'Fix Walk-in sales, dated 2026-09-01' }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
  });

  it('refuses a record that belongs to another business', async () => {
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path === '/records/expenses/7' ? { id: 7, type: 'expense', businessProfileId: 2 } : found));
    const queries = await renderNotice();

    await fireEvent.press(await queries.findByRole('button', { name: 'Fix Rice sacks, dated 2027-08-25' }));

    expect(await queries.findByText('That record is not in this business.')).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows nothing when there are none, and nothing when the check fails', async () => {
    apiGet.mockResolvedValue({ today: '2026-08-20', total: 0, truncated: false, records: [] });
    const none = await renderNotice();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(none.queryByText('Records dated after today')).toBeNull();
    await cleanup();
    clearServerStateCache();

    apiGet.mockReset();
    apiGet.mockRejectedValue(new Error('offline'));
    const failed = await renderNotice();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(failed.queryByText('Records dated after today')).toBeNull();
  });
});
