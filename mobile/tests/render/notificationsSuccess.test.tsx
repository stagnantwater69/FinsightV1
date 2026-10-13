import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityInfo, RefreshControl } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * "Mark all read" has to confirm itself to someone who cannot see it.
 *
 * WHY THIS FILE EXISTS. The 2026-08-02 design audit listed Alerts among the
 * screens with no success state. It half held up: the screen does confirm,
 * visually and well — the eyebrow changes to "All caught up" and the button
 * removes itself. But the confirmation IS the removal of the control the
 * reader was standing on, so there is nothing left to announce from and
 * nothing said. An owner using TalkBack pressed a button and got silence.
 *
 * A live region cannot fix an element that stops existing, so the screen
 * announces the outcome directly. This drives the press and checks the
 * announcement is made with the number of alerts it actually cleared.
 *
 * WHAT THIS IS NOT. `announceForAccessibility` reaching the platform is not
 * the same as TalkBack or VoiceOver speaking it at a useful moment, or at all
 * if the queue is busy. That needs a device.
 */

const apiGet = vi.fn();
const apiPatch = vi.fn();

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: fixtures.businessProfile,
    categories: [],
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories: vi.fn(),
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const unreadAlert = (id: number) => ({
  id,
  expenseRecordId: null,
  message: `Possible duplicate expense ${id}`,
  type: 'DUPLICATE',
  readStatus: false,
  businessProfileId: fixtures.businessProfile.id,
  dateCreated: '2026-09-15T01:00:00.000Z',
});

async function renderScreen(navigation?: { navigate: ReturnType<typeof vi.fn> }) {
  const { NotificationsScreen } = await import('../../src/screens/NotificationsScreen');
  const { ThemeProvider } = await import('../../src/context/ThemeContext');
  return render(
    <ThemeProvider initialMode="light">
      <NotificationsScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

function findFiberByType(node: { unstable_fiber?: any } | null, type: unknown) {
  let root = node?.unstable_fiber;
  while (root?.return) root = root.return;
  const pending = root ? [root] : [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current?.type === type || current?.elementType === type) return current;
    if (current?.sibling) pending.push(current.sibling);
    if (current?.child) pending.push(current.child);
  }
  return null;
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
  vi.clearAllMocks();
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPatch.mockResolvedValue(undefined);
});

describe('Alerts — marking everything read', () => {
  it('marks a record alert read and opens its exact expense in the review flow', async () => {
    const alert = { ...unreadAlert(31), expenseRecordId: 44 };
    const record = {
      id: 44,
      businessProfileId: fixtures.businessProfile.id,
      type: 'expense',
      amount: 1250,
      date: '2026-09-15',
      description: 'Stock delivery',
    };
    apiGet.mockImplementation((path: string) => {
      if (path === '/notifications') return Promise.resolve([alert]);
      if (path === '/records/expenses/44') return Promise.resolve(record);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const navigation = { navigate: vi.fn() };
    const queries = await renderScreen(navigation);

    await fireEvent.press(await queries.findByRole('button', {
      name: 'Possible duplicate expense 31. Review duplicate.',
    }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/notifications/31/read',
      undefined,
      { cacheScope: { businessProfileId: fixtures.businessProfile.id } },
    ));
    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith(
      'Records',
      { screen: 'EditRecord', params: { record } },
    ));
  });

  it('keeps a business-wide alert as a mark-read action without opening a record', async () => {
    apiGet.mockResolvedValue([unreadAlert(32)]);
    const navigation = { navigate: vi.fn() };
    const queries = await renderScreen(navigation);

    await fireEvent.press(await queries.findByRole('button', {
      name: 'Possible duplicate expense 32. Tap to mark as read.',
    }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('announces how many were cleared, and drops the control', async () => {
    apiGet.mockResolvedValue([unreadAlert(1), unreadAlert(2)]);
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');

    const queries = await renderScreen();
    const markAll = await queries.findByRole('button', { name: 'Mark all read' });

    await fireEvent.press(markAll);

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('2 alerts marked as read.');
    });
    expect(apiPatch).toHaveBeenCalledWith('/notifications/read-all', undefined, {
      query: { businessProfileId: fixtures.businessProfile.id },
      cacheScope: { businessProfileId: fixtures.businessProfile.id },
    });
    expect(queries.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(queries.getByText('All caught up')).toBeTruthy();

    announce.mockRestore();
  });

  it('scopes a single mark-read mutation to the alert business', async () => {
    apiGet.mockResolvedValue([unreadAlert(7)]);
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', {
      name: 'Possible duplicate expense 7. Tap to mark as read.',
    }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/notifications/7/read',
      undefined,
      { cacheScope: { businessProfileId: fixtures.businessProfile.id } },
    ));
  });

  it('does not let an overlapping stale refresh undo mark-all read', async () => {
    let finishRefresh!: (items: ReturnType<typeof unreadAlert>[]) => void;
    const delayedRefresh = new Promise<ReturnType<typeof unreadAlert>[]>((resolve) => {
      finishRefresh = resolve;
    });
    apiGet
      .mockResolvedValueOnce([unreadAlert(9)])
      .mockReturnValueOnce(delayedRefresh);
    const queries = await renderScreen();
    const markAll = await queries.findByRole('button', { name: 'Mark all read' });
    const refreshControl = findFiberByType(queries.root, RefreshControl);

    await act(async () => {
      refreshControl?.memoizedProps.onRefresh();
      refreshControl?.memoizedProps.onRefresh();
    });
    expect(apiGet).toHaveBeenCalledTimes(2);
    await fireEvent.press(markAll);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));

    await act(async () => {
      finishRefresh([unreadAlert(9)]);
      await delayedRefresh;
    });

    expect(queries.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(queries.getByText('All caught up')).toBeTruthy();
    expect(queries.getByRole('button', {
      name: 'Possible duplicate expense 9. Already read.',
    })).toBeDisabled();
  });

  it('does not let a refresh begun after mark-read publish a pre-commit unread row', async () => {
    let finishPatch!: () => void;
    const delayedPatch = new Promise<void>((resolve) => {
      finishPatch = resolve;
    });
    let finishRefresh!: (items: ReturnType<typeof unreadAlert>[]) => void;
    const delayedRefresh = new Promise<ReturnType<typeof unreadAlert>[]>((resolve) => {
      finishRefresh = resolve;
    });
    apiGet
      .mockResolvedValueOnce([unreadAlert(10)])
      .mockReturnValueOnce(delayedRefresh);
    apiPatch.mockReturnValueOnce(delayedPatch);
    const queries = await renderScreen();
    const row = await queries.findByRole('button', {
      name: 'Possible duplicate expense 10. Tap to mark as read.',
    });
    const refreshControl = findFiberByType(queries.root, RefreshControl);

    await act(() => {
      void pressHandler(row)();
    });
    expect(apiPatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      refreshControl?.memoizedProps.onRefresh();
    });
    expect(apiGet).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishPatch();
      await delayedPatch;
    });
    await act(async () => {
      finishRefresh([unreadAlert(10)]);
      await delayedRefresh;
    });

    expect(queries.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(queries.getByRole('button', {
      name: 'Possible duplicate expense 10. Already read.',
    })).toBeDisabled();
  });

  it('does not let an older failed mark-one undo a newer successful mark-all', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstPatch = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    apiGet.mockResolvedValue([unreadAlert(1), unreadAlert(2)]);
    apiPatch
      .mockReturnValueOnce(firstPatch)
      .mockResolvedValueOnce(undefined);
    const queries = await renderScreen();
    const markOne = await queries.findByRole('button', {
      name: 'Possible duplicate expense 1. Tap to mark as read.',
    });
    await act(() => {
      void pressHandler(markOne)();
    });
    await fireEvent.press(queries.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(2));

    await act(async () => {
      rejectFirst(new Error('First mark failed late.'));
      await firstPatch.catch(() => undefined);
    });

    expect(queries.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(queries.getByRole('button', {
      name: 'Possible duplicate expense 1. Already read.',
    })).toBeDisabled();
    expect(queries.getByRole('button', {
      name: 'Possible duplicate expense 2. Already read.',
    })).toBeDisabled();
  });

  it('says nothing succeeded when the server refused, and restores the alerts', async () => {
    apiGet.mockResolvedValue([unreadAlert(1)]);
    apiPatch.mockRejectedValue(new Error('offline'));
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');

    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() => {
      // The button comes back because the optimistic update was rolled back —
      // a confirmation here would have been a lie.
      expect(queries.getByRole('button', { name: 'Mark all read' })).toBeTruthy();
    });
    expect(announce).not.toHaveBeenCalled();

    announce.mockRestore();
  });
});
