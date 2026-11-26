import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecordItem } from '../../src/lib/types';

vi.mock('../../src/lib/api', () => ({
  api: { get: vi.fn(() => Promise.resolve([{ id: 7, title: 'burger_stall_sample', uploadDate: '2026-10-17T00:00:00.000Z', status: 'COMPLETED' }])), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ selected: fixtures.businessProfile, categories: fixtures.categories }),
}));

const { ImportDuplicatesScreen } = await import('../../src/screens/ImportDuplicatesScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const rec = (id: number, original: number, date: string): RecordItem => ({
  id, type: 'expense', businessProfileId: fixtures.businessProfile.id, categoryId: 10, duplicateOfRecordId: original,
  date, description: `Paper takeaway bags x200; purchase E${id}`, amount: 240, source: 'CSV_UPLOAD', importBatchId: 7,
  reviewStatus: 'Reviewed', duplicateStatus: 'Flagged', createdAt: '2026-10-17T00:00:00.000Z',
} as RecordItem);

afterEach(cleanup);

describe('ImportDuplicatesScreen', () => {
  it('is about the import: why it was flagged and one decision, with its rows folded away', async () => {
    const records = [rec(1, 38810, '2026-10-09'), rec(2, 38776, '2026-10-01')];
    const q = await render(
      <ThemeProvider initialMode="light">
        <ImportDuplicatesScreen {...({ navigation: { goBack: vi.fn() }, route: { params: { records, hasMore: false } } } as any)} />
      </ThemeProvider>,
    );
    expect(await q.findByText('burger_stall_sample')).toBeTruthy();
    expect(q.getByText('Why these were flagged')).toBeTruthy();
    expect(q.getByText(/^Every row in this file has the same date and amount/)).toBeTruthy();
    expect(q.getByRole('button', { name: 'Keep all 2' })).toBeTruthy();
    // No list of flagged records to open from here.
    expect(q.queryByText('Flagged records')).toBeNull();
    expect(q.queryByText(/same as record #38810/)).toBeNull();
    await fireEvent.press(q.getByText('The 2 flagged rows'));
    expect(q.getByText(/same as record #38810/)).toBeTruthy();
  });
});
