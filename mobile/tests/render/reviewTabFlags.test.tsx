import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecordItem } from '../../src/lib/types';
import { importDuplicateGroups } from '../../src/lib/flagGroups';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));

const { ImportDuplicateCards } = await import('../../src/components/ImportDuplicateCards');
const { LargeExpenseFlags } = await import('../../src/components/LargeExpenseFlags');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const BIZ = fixtures.businessProfile.id;

function rec(id: number, extra: Partial<RecordItem> = {}): RecordItem {
  return {
    id,
    type: 'expense',
    businessProfileId: BIZ,
    categoryId: 10,
    duplicateOfRecordId: 1,
    date: '2026-10-13',
    description: `Imported row ${id}`,
    amount: 100,
    source: 'CSV_UPLOAD',
    reviewStatus: 'Reviewed',
    duplicateStatus: 'Flagged',
    createdAt: '2026-10-13T02:00:00.000Z',
    ...extra,
  } as RecordItem;
}

const mount = (node: React.ReactNode) => render(<ThemeProvider initialMode="light">{node}</ThemeProvider>);

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue([{ id: 7, title: 'burger_stall_sample', uploadDate: '2026-10-17T00:00:00.000Z', status: 'COMPLETED' }]);
});
afterEach(cleanup);

describe('importDuplicateGroups', () => {
  it('groups flagged duplicates by import, two or more per group, and nothing else', () => {
    const groups = importDuplicateGroups([
      rec(1, { importBatchId: 7 }),
      rec(2, { importBatchId: 7 }),
      rec(3, { importBatchId: 8 }),
      rec(4, { importBatchId: 7, duplicateStatus: 'Not a Duplicate' }),
      rec(5, { importBatchId: null }),
    ], [{ id: 7, title: 'burger_stall_sample', uploadDate: '2026-10-17', status: 'COMPLETED' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.batch?.title).toBe('burger_stall_sample');
    expect(groups[0]!.records.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('ImportDuplicateCards', () => {
  const records = [rec(71, { importBatchId: 7 }), rec(72, { importBatchId: 7, type: 'sales' }), rec(73, { importBatchId: 7 })];

  it('discards a whole import only after confirming, with exactly its ids', async () => {
    apiPost.mockResolvedValue({ resolved: 3 });
    const onChanged = vi.fn();
    const q = await mount(<ImportDuplicateCards records={records} hasMore={false} businessProfileId={BIZ} onChanged={onChanged} />);
    expect(await q.findByText('burger_stall_sample')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Discard all 3' }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(q.getByText(/stay exactly as they are/)).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Cancel' }));
    expect(apiPost).not.toHaveBeenCalled();

    await fireEvent.press(q.getByRole('button', { name: 'Discard all 3' }));
    await fireEvent.press(q.getByRole('button', { name: 'Discard 3' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith('/records/duplicates/resolve', {
      businessProfileId: BIZ, action: 'discard', expenseIds: [71, 73], salesIds: [72],
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('keeps a whole import in one request', async () => {
    apiPost.mockResolvedValue({ resolved: 3 });
    const q = await mount(<ImportDuplicateCards records={records} hasMore={false} businessProfileId={BIZ} onChanged={vi.fn()} />);
    await fireEvent.press(await q.findByRole('button', { name: 'Keep all 3' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith('/records/duplicates/resolve', {
      businessProfileId: BIZ, action: 'keep', expenseIds: [71, 73], salesIds: [72],
    }));
  });

  it('never offers records from another business, and says when more may be unloaded', async () => {
    const mixed = [rec(81, { importBatchId: 7 }), rec(82, { importBatchId: 7, businessProfileId: BIZ + 1 })];
    const q = await mount(<ImportDuplicateCards records={mixed} hasMore businessProfileId={BIZ} onChanged={vi.fn()} />);
    expect(q.queryByRole('button', { name: /^Discard all/ })).toBeNull();

    const partial = await mount(<ImportDuplicateCards records={records} hasMore businessProfileId={BIZ} onChanged={vi.fn()} />);
    expect(await partial.findByText(/Applies to the 3 loaded so far/)).toBeTruthy();
  });
});

describe('ImportDuplicateCards on the Review tab', () => {
  it('shows each import as one row that opens it, with no decision buttons', async () => {
    const records = [rec(71, { importBatchId: 7 }), rec(72, { importBatchId: 7 })];
    const onOpen = vi.fn();
    const q = await mount(<ImportDuplicateCards records={records} hasMore={false} businessProfileId={BIZ} onChanged={vi.fn()} onOpen={onOpen} />);
    expect(await q.findByText('burger_stall_sample')).toBeTruthy();
    expect(q.queryByRole('button', { name: /^Keep all/ })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: /^burger_stall_sample, 2 possible duplicates/ }));
    expect(onOpen).toHaveBeenCalledWith(records);
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('Review tab flag list', () => {
  it('lists a flagged sale beside expenses, labelled as a sale', async () => {
    const onOpen = vi.fn();
    const q = await mount(
      <LargeExpenseFlags
        items={[rec(91, { type: 'sales', description: 'Lunch sales', categoryId: undefined })]}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        profile={{ expectedMonthlyExpenses: 10000, largeExpenseThresholdPercent: 5 }}
        categories={fixtures.categories}
        flaggedTotal={1}
        onOpen={onOpen}
      />,
    );
    expect(q.getByText('Flagged records')).toBeTruthy();
    expect(q.getByText(/^Sale · /)).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: /^Lunch sales,/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 91, type: 'sales' }));
  });
});
