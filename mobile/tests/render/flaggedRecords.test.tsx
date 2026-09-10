import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecordItem } from '../../src/lib/types';

/**
 * Rendered coverage for the flagged-records queue after the
 * `GET /records/flagged` contract changed.
 *
 * WHAT THIS IS GUARDING. The endpoint used to answer with every flagged
 * record a business had. It now caps the legacy bare-array shape at 200 and
 * only signals the remainder through an `X-Next-Cursor` HEADER — which
 * `api.get` parses none of. A business with more than 200 flagged records
 * would therefore lose the rest from view WITHOUT any visible error, which is
 * the failure these tests exist to make loud:
 *
 * - the headline count comes from `/records/flagged/count`, so rendering a
 *   number never downloads the list it counts;
 * - the list always sends `limit`, so it always gets `{ items, nextCursor }`
 *   and can walk past the 200-record cap;
 * - loading, empty, error and end-of-list states stay honest.
 *
 * Camera, permission and app-lifecycle behaviour are untouched by this screen
 * and are not covered here or anywhere else in this directory.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

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
    selected: fixtures.businessProfile,
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

const { FlaggedRecordsScreen } = await import('../../src/screens/records/FlaggedRecordsScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

function renderScreen() {
  return render(
    <ThemeProvider initialMode="light">
      <FlaggedRecordsScreen />
    </ThemeProvider>,
  );
}

/** A large-expense flag: ungrouped, so one record renders as one card. */
function record(id: number): RecordItem {
  return {
    id,
    type: 'expense',
    businessProfileId: 1,
    categoryId: 10,
    duplicateOfRecordId: null,
    date: '2026-08-20',
    description: `Flagged purchase ${id}`,
    amount: 1200,
    source: 'MANUAL_ENTRY',
    reviewStatus: 'Needs Review',
    duplicateStatus: 'Not a Duplicate',
    largeExpenseFlag: true,
    createdAt: '2026-08-20T02:00:00.000Z',
  } as RecordItem;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Every `/records/flagged` list call, in order, with the query it sent. */
function listCalls(): Query[] {
  return apiGet.mock.calls
    .filter((call) => call[0] === '/records/flagged')
    .map((call) => (call[1] ?? {}) as Query);
}

function countCalls(): Query[] {
  return apiGet.mock.calls
    .filter((call) => call[0] === '/records/flagged/count')
    .map((call) => (call[1] ?? {}) as Query);
}

/**
 * Routes `api.get` by path. `pages` is consumed in order, so a test states the
 * server's answers as a sequence rather than by matching cursor strings.
 */
function routeApi(options: {
  pages: Array<{ items: RecordItem[]; nextCursor: string | null } | Error>;
  count?: { expenses: number; sales: number; total: number } | Error;
}) {
  const pages = [...options.pages];
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/records/flagged') {
      const next = pages.shift();
      if (!next) throw new Error('Unexpected extra page request');
      if (next instanceof Error) throw next;
      return next;
    }
    if (path === '/records/flagged/count') {
      if (options.count instanceof Error) throw options.count;
      return options.count ?? { expenses: 0, sales: 0, total: 0 };
    }
    if (path === '/records/csv-imports/batches') return [];
    throw new Error(`Unexpected path ${path}`);
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
});

afterEach(cleanup);

describe('FlaggedRecordsScreen — count endpoint', () => {
  it('renders the headline count from /records/flagged/count, not from the list', async () => {
    routeApi({
      pages: [{ items: [record(1), record(2)], nextCursor: 'cursor-1' }],
      count: { expenses: 400, sales: 12, total: 412 },
    });

    const queries = await renderScreen();

    // The number on screen is the server's count, not the two records loaded.
    expect(await queries.findByText(/412 records flagged/)).toBeTruthy();
    expect(countCalls()).toEqual([{ businessProfileId: 1 }]);
  });

  it('never asks for the flagged list without a limit', async () => {
    routeApi({
      pages: [{ items: [record(1)], nextCursor: null }],
      count: { expenses: 1, sales: 0, total: 1 },
    });

    const queries = await renderScreen();
    await queries.findByText('Flagged purchase 1');

    // A request with no `limit` gets the legacy bare array, capped at 200,
    // with the remainder only in a response header this client cannot read.
    for (const query of listCalls()) expect(query.limit).toBeDefined();
    expect(listCalls()[0]).toMatchObject({ businessProfileId: 1 });
  });

  it('omits the count line rather than claiming zero when the count call fails', async () => {
    routeApi({
      pages: [{ items: [record(1)], nextCursor: null }],
      count: new Error('count unavailable'),
    });

    const queries = await renderScreen();
    await queries.findByText('Flagged purchase 1');

    expect(queries.queryByText(/records flagged/)).toBeNull();
  });
});

describe('FlaggedRecordsScreen — paging past the 200-record cap', () => {
  it('loads the next page with the cursor and appends it', async () => {
    routeApi({
      pages: [
        { items: [record(1), record(2)], nextCursor: 'cursor-1' },
        // A record that sits beyond the legacy 200 cap: unreachable before.
        { items: [record(250)], nextCursor: null },
      ],
      count: { expenses: 201, sales: 0, total: 201 },
    });

    const queries = await renderScreen();
    await queries.findByText('Flagged purchase 1');
    expect(queries.queryByText('Flagged purchase 250')).toBeNull();

    await fireEvent.press(await queries.findByRole('button', { name: 'Load more' }));

    expect(await queries.findByText('Flagged purchase 250')).toBeTruthy();
    // The earlier page is still on screen — pages append, they do not replace.
    expect(queries.getByText('Flagged purchase 1')).toBeTruthy();

    const calls = listCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cursor).toBeUndefined();
    expect(calls[1]!.cursor).toBe('cursor-1');
  });

  it('shows the end of the list once there is no cursor left', async () => {
    routeApi({
      pages: [
        { items: [record(1)], nextCursor: 'cursor-1' },
        { items: [record(2)], nextCursor: null },
      ],
      count: { expenses: 2, sales: 0, total: 2 },
    });

    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(queries.queryByRole('button', { name: 'Load more' })).toBeNull());
    expect(queries.getByText("That's everything waiting for review.")).toBeTruthy();
  });

  it('keeps the loaded records and explains itself when a further page fails', async () => {
    routeApi({
      pages: [
        { items: [record(1)], nextCursor: 'cursor-1' },
        new Error('The server had a problem with that.'),
      ],
      count: { expenses: 300, sales: 0, total: 300 },
    });

    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'Load more' }));

    expect(await queries.findByText(/The records already listed are still here\./)).toBeTruthy();
    expect(queries.getByText('Flagged purchase 1')).toBeTruthy();
    // Still offered, because the records beyond the cursor are still there.
    expect(queries.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });
});

describe('FlaggedRecordsScreen — empty and error states', () => {
  it('gives the all-clear only when the queue really is empty', async () => {
    routeApi({ pages: [{ items: [], nextCursor: null }], count: { expenses: 0, sales: 0, total: 0 } });

    const queries = await renderScreen();

    expect(await queries.findByText('Nothing needs your attention')).toBeTruthy();
    expect(queries.queryByText(/records flagged/)).toBeNull();
  });

  it('withholds the all-clear and offers a retry when the list fails to load', async () => {
    routeApi({ pages: [new Error('Could not reach FinSight.')], count: { expenses: 5, sales: 0, total: 5 } });

    const queries = await renderScreen();

    expect(await queries.findByRole('button', { name: 'Try again' })).toBeTruthy();
    // "Nothing needs your attention" over a failed fetch would be a false
    // all-clear about the owner's own books.
    expect(queries.queryByText('Nothing needs your attention')).toBeNull();
  });
});
