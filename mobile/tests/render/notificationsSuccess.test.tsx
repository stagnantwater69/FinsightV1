import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityInfo, Pressable, RefreshControl, SectionList } from 'react-native';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import { palettes } from '../../src/theme/palette';

/**
 * "Mark all read" has to confirm itself to someone who cannot see it.
 *
 * WHY THIS FILE EXISTS. The 2026-08-02 design audit listed Alerts among the
 * screens with no success state. It half held up: the screen does confirm,
 * visually and well: the unread count changes and the button
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
let selected: typeof fixtures.businessProfile | null = fixtures.businessProfile;

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected,
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

const { NotificationsScreen } = await import('../../src/screens/NotificationsScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
type TestNavigation = { navigate: ReturnType<typeof vi.fn>; goBack?: ReturnType<typeof vi.fn>; canGoBack?: () => boolean };
function screenTree(navigation?: TestNavigation, mode: 'light' | 'dark' = 'light') {
  return (
    <ThemeProvider initialMode={mode}>
      <NotificationsScreen navigation={navigation} />
    </ThemeProvider>
  );
}
async function renderScreen(navigation?: TestNavigation, mode: 'light' | 'dark' = 'light') {
  return render(screenTree(navigation, mode));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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

function findAncestorOfType(node: { unstable_fiber?: any }, type: unknown) {
  let fiber = node.unstable_fiber?.return;
  while (fiber) {
    if (fiber.type === type || fiber.elementType === type) return fiber;
    fiber = fiber.return;
  }
  return null;
}

async function reportLongMessageLayout(screen: Awaited<ReturnType<typeof render>>, message: string) {
  const measurement = screen.getAllByText(message, { includeHiddenElements: true })
    .find((node) => typeof node.props.onTextLayout === 'function' && node.props.numberOfLines === undefined);
  expect(measurement).toBeDefined();
  await fireEvent(measurement!, 'textLayout', {
    nativeEvent: {
      lines: Array.from({ length: 8 }, (_, index) => ({
        text: message.slice(index * 50, (index + 1) * 50),
        x: 0, y: index * 22, width: 250, height: 22,
      })),
    },
  });
}

beforeEach(() => {
  selected = fixtures.businessProfile;
  vi.clearAllMocks();
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPatch.mockResolvedValue(undefined);
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('Alerts — marking everything read', () => {
  it('mounts a bounded initial batch while retaining the unread count for 500 alerts', async () => {
    apiGet.mockResolvedValue(Array.from({ length: 500 }, (_, index) => unreadAlert(index + 1)));
    const screen = await renderScreen();
    await screen.findByRole('button', { name: /Possible duplicate expense 1\./ });
    const rows = screen.getAllByRole('button').filter((button) => String(button.props.accessibilityLabel).startsWith('Possible duplicate expense '));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(screen.queryByRole('button', { name: /Possible duplicate expense 500\./ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeTruthy();
  });

  it('says "at least" once the list reaches the server cap, since older alerts may lie beyond it', async () => {
    apiGet.mockResolvedValue(Array.from({ length: 500 }, (_, index) => ({ ...unreadAlert(index + 1), readStatus: index % 2 === 0 })));
    const screen = await renderScreen();

    expect(await screen.findByText('250+ unread')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter alerts, All (500+)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter alerts, Unread (250+)' })).toBeTruthy();
  });

  it('locks repeated mark-all actions before a pending request completes', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    apiGet.mockResolvedValue([unreadAlert(1), unreadAlert(2)]); apiPatch.mockReturnValue(pending);
    const screen = await renderScreen();
    const markAll = pressHandler(await screen.findByRole('button', { name: 'Mark all read' }));
    await act(() => { markAll(); markAll(); });
    expect(apiPatch).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await pending; });
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });
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
    expect(queries.getByText('0 unread')).toBeTruthy();

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
    expect(queries.getByText('0 unread')).toBeTruthy();
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

describe('Alerts review and business isolation', () => {
  it.each([
    { name: 'business-wide marking', expenseRecordId: null },
    { name: 'record review', expenseRecordId: 44 },
  ])('preserves preview touches for $name', async ({ expenseRecordId }) => {
    const alert = { ...unreadAlert(43), expenseRecordId };
    const record = { id: 44, businessProfileId: fixtures.businessProfile.id, type: 'expense', amount: 1250, description: 'Stock delivery' };
    apiGet.mockImplementation((path: string) => path === '/notifications' ? Promise.resolve([alert]) : Promise.resolve(record));
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await screen.findByText(alert.message);

    const preview = findAncestorOfType(screen.getByText(expenseRecordId === null ? 'Possible duplicate' : alert.message), Pressable);
    expect(preview).not.toBeNull();
    expect(preview.memoizedProps.accessible).toBe(false);
    expect(preview.memoizedProps.disabled).toBe(false);
    expect(preview.memoizedProps.onPress).toEqual(expect.any(Function));
    await act(() => { void preview.memoizedProps.onPress(); });

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/notifications/43/read', undefined, {
      cacheScope: { businessProfileId: fixtures.businessProfile.id },
    }));
    if (expenseRecordId !== null) {
      await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('Records', { screen: 'EditRecord', params: { record } }));
      expect(apiGet).toHaveBeenCalledWith('/records/expenses/44');
    } else {
      expect(apiGet).toHaveBeenCalledTimes(1);
      expect(navigation.navigate).not.toHaveBeenCalled();
    }
  });

  it('keeps a read record alert reviewable without sending another mark-read mutation', async () => {
    const alert = { ...unreadAlert(45), readStatus: true, expenseRecordId: 44 };
    const record = { id: 44, businessProfileId: fixtures.businessProfile.id, type: 'expense', amount: 1250, description: 'Stock delivery' };
    apiGet.mockImplementation((path: string) => path === '/notifications' ? Promise.resolve([alert]) : Promise.resolve(record));
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);

    const row = await screen.findByRole('button', { name: 'Possible duplicate expense 45. Review duplicate. Already read.' });
    expect(row).not.toBeDisabled();
    await fireEvent.press(row);

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('Records', { screen: 'EditRecord', params: { record } }));
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiGet).toHaveBeenCalledWith('/records/expenses/44');
  });

  it.each([
    { id: 44, businessProfileId: 2 },
    { id: 45, businessProfileId: fixtures.businessProfile.id },
  ])('refuses a record response that no longer matches the alert: %j', async (record) => {
    apiGet.mockImplementation((path: string) => path === '/notifications'
      ? Promise.resolve([{ ...unreadAlert(46), expenseRecordId: 44 }]) : Promise.resolve(record));
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await fireEvent.press(await screen.findByRole('button', { name: 'Possible duplicate expense 46. Review duplicate.' }));
    expect(await screen.findByText('That alert no longer points to a record in this business.')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('ignores an old business load that finishes with %s after switching businesses', async (outcome) => {
    const old = deferred<ReturnType<typeof unreadAlert>[]>();
    const secondBusiness = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    const secondAlert = { ...unreadAlert(51), businessProfileId: 2, message: 'Second business alert' };
    apiGet.mockReturnValueOnce(old.promise).mockResolvedValueOnce([secondAlert]);
    const screen = await renderScreen();
    selected = secondBusiness;
    await screen.rerender(screenTree());
    await screen.findByRole('button', { name: 'Second business alert. Tap to mark as read.' });
    expect(apiGet).toHaveBeenCalledWith('/notifications', { businessProfileId: 2 });

    await act(async () => {
      if (outcome === 'success') old.resolve([unreadAlert(50)]);
      else old.reject(new Error('Private first business load failed.'));
      await old.promise.catch(() => undefined);
    });

    expect(screen.getByRole('button', { name: 'Second business alert. Tap to mark as read.' })).toBeTruthy();
    expect(screen.queryByText('Possible duplicate expense 50')).toBeNull();
    expect(screen.queryByText(/Private first business load failed/)).toBeNull();
  });

  it('never opens a late record response after the active business changes', async () => {
    const pending = deferred<{ id: number; businessProfileId: number }>();
    apiGet.mockImplementation((path: string, query?: { businessProfileId: number }) => {
      if (path === '/records/expenses/44') return pending.promise;
      return Promise.resolve(query?.businessProfileId === 2
        ? [{ ...unreadAlert(61), businessProfileId: 2, message: 'Second business alert' }]
        : [{ ...unreadAlert(60), expenseRecordId: 44 }]);
    });
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await act(() => { void pressHandler(screen.getByRole('button', { name: 'Possible duplicate expense 60. Review duplicate.' }))(); });
    expect(apiGet).toHaveBeenCalledWith('/records/expenses/44');
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await screen.rerender(screenTree(navigation));
    await screen.findByRole('button', { name: 'Second business alert. Tap to mark as read.' });
    await act(async () => { pending.resolve({ id: 44, businessProfileId: fixtures.businessProfile.id }); await pending.promise; });
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(screen.queryByText('Possible duplicate expense 60')).toBeNull();
  });
});

describe('Alerts filtering and presentation', () => {
  it.each([
    { name: 'read business-wide', readStatus: true, expenseRecordId: null },
    { name: 'unread record', readStatus: false, expenseRecordId: 44 },
  ])('opens the full $name alert message without marking it read or reviewing a record', async ({ readStatus, expenseRecordId }) => {
    const message = `Possible duplicate expense. ${'The supplier, date, amount and item description match an earlier expense. '.repeat(12)}Original server detail: receipt #R-289, PHP 1,250.50.`;
    apiGet.mockResolvedValue([{ ...unreadAlert(81), readStatus, expenseRecordId, message }]);
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await screen.findByText(message);
    expect(screen.getByText(message).props.numberOfLines).toBe(2);
    await reportLongMessageLayout(screen, message);
    const expand = screen.getByRole('button', { name: /^Read full alert: Possible duplicate,/ });
    expect(expand).not.toBeDisabled();
    expect(expand.props.accessibilityState.expanded).toBe(false);
    await fireEvent.press(expand);

    const full = screen.getByText(message);
    expect(full.props.numberOfLines).toBeUndefined();
    expect(full.props.selectable).toBe(true);
    const collapse = screen.getByRole('button', { name: /^Show less: Possible duplicate,/ });
    expect(collapse.props.accessibilityState.expanded).toBe(true);
    expect(screen.getByRole('button', { name: `Filter alerts, Unread (${readStatus ? 0 : 1})` })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter alerts, All (1)' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(collapse);
    expect(screen.getByText(message).props.numberOfLines).toBe(2);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/notifications', { businessProfileId: fixtures.businessProfile.id });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('removes an expanded private message when the business changes even if the next alert reuses its id', async () => {
    const privateMessage = `First business receipt details. ${'Supplier and expense data belonging to the first business. '.repeat(12)}`;
    const nextMessage = `Second business receipt details. ${'Only data belonging to the second business. '.repeat(12)}`;
    apiGet.mockImplementation((_path: string, query: { businessProfileId: number }) => Promise.resolve([
      { ...unreadAlert(82), businessProfileId: query.businessProfileId, message: query.businessProfileId === 2 ? nextMessage : privateMessage },
    ]));
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await screen.findByText(privateMessage);
    await reportLongMessageLayout(screen, privateMessage);
    await fireEvent.press(screen.getByRole('button', { name: /^Read full alert: Possible duplicate,/ }));
    expect(screen.getByRole('button', { name: /^Show less: Possible duplicate,/ })).toBeTruthy();

    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await screen.rerender(screenTree(navigation));
    await screen.findByText(nextMessage);
    expect(screen.queryByText(privateMessage, { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Show less:/ })).toBeNull();
    expect(screen.getByText(nextMessage).props.numberOfLines).toBe(2);
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiPatch).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('counts all alerts separately from unread and filters without fetching or changing read state', async () => {
    apiGet.mockResolvedValue([unreadAlert(1), { ...unreadAlert(2), readStatus: true }, unreadAlert(3)]);
    const screen = await renderScreen();
    expect((await screen.findByRole('button', { name: 'Filter alerts, All (3)' })).props.accessibilityState.selected).toBe(true);
    const unread = screen.getByRole('button', { name: 'Filter alerts, Unread (2)' });
    await fireEvent.press(unread);
    expect(screen.getByRole('button', { name: 'Filter alerts, Unread (2)' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('button', { name: 'Possible duplicate expense 1. Tap to mark as read.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Possible duplicate expense 2. Already read.' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Filter alerts, All (3)' }));
    expect(screen.getByRole('button', { name: 'Possible duplicate expense 2. Already read.' })).toBeDisabled();
    expect(apiGet).toHaveBeenCalledTimes(1); expect(apiPatch).not.toHaveBeenCalled();
  });

  it('offers View all alerts after unread is cleared and returns to the retained history', async () => {
    apiGet.mockResolvedValue([unreadAlert(1), unreadAlert(2)]);
    const screen = await renderScreen();
    await fireEvent.press(await screen.findByRole('button', { name: 'Filter alerts, Unread (2)' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByText('All alerts read')).toBeTruthy();
    expect(screen.getByText('0 unread')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter alerts, Unread (0)' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'View all alerts' }));
    expect(screen.getByRole('button', { name: 'Filter alerts, All (2)' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('button', { name: 'Possible duplicate expense 1. Already read.' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Possible duplicate expense 2. Already read.' })).toBeDisabled();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('restores an unread row and its count in the active unread filter when marking it fails', async () => {
    apiGet.mockResolvedValue([unreadAlert(8)]);
    apiPatch.mockRejectedValue(Object.assign(new Error('Network request failed.'), { status: 0 }));
    const screen = await renderScreen();
    await fireEvent.press(await screen.findByRole('button', { name: 'Filter alerts, Unread (1)' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Possible duplicate expense 8. Tap to mark as read.' }));
    expect(await screen.findByRole('button', { name: 'Possible duplicate expense 8. Tap to mark as read.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter alerts, Unread (1)' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByText(/FinSight didn't confirm whether the action finished/)).toBeTruthy();
    expect(screen.getByText(/Refresh this screen to check the result before trying again/)).toBeTruthy();
    expect(screen.queryByText(/The alert is still unread/)).toBeNull();
    expect(screen.queryByText('All alerts read')).toBeNull();
  });

  it('distinguishes a successful empty list from unread history', async () => {
    apiGet.mockResolvedValue([]);
    const screen = await renderScreen();
    expect(await screen.findByText('No alerts yet')).toBeTruthy();
    expect(screen.queryByText('All alerts read')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View all alerts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('shows the no-business state without requesting or mutating another business', async () => {
    selected = null;
    const screen = await renderScreen();
    expect(screen.getByText('Set up a business first')).toBeTruthy();
    expect(screen.getByText('Alerts belong to a business profile.')).toBeTruthy();
    expect(screen.queryByText('No alerts yet')).toBeNull();
    expect(apiGet).not.toHaveBeenCalled(); expect(apiPatch).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'] as const)('retains server messages with friendly labels and themed outline icons in %s', async (mode) => {
    const cases = [
      ['Possible Duplicate', 'Possible duplicate', 'copy-outline'],
      ['Large Expense Flag', 'Large expense', 'warning-outline'],
      ['Needs Review', 'Needs review', 'alert-circle-outline'],
      ['Recurring Schedule', 'Recurring payment', 'repeat-outline'],
      ['Recovery Target', 'Recovery target', 'locate-outline'],
      ['CUSTOM_NOTICE', 'Custom notice', 'information-circle-outline'],
    ];
    const rows = cases.map(([type], index) => ({
      ...unreadAlert(index + 1), type,
      message: `Original server message ${index + 1}: "Stock delivery"; PHP 1,250.50.`,
    }));
    apiGet.mockResolvedValue(rows);
    const screen = await renderScreen(undefined, mode);
    await screen.findByText(rows[0]!.message);
    for (const [index, [, label, glyph]] of cases.entries()) {
      expect(screen.getByText(rows[index]!.message)).toBeTruthy();
      expect(screen.getByText(label!)).toBeTruthy();
      const icon = screen.getByText(`Ionicons:${glyph}`, { includeHiddenElements: true });
      expect(icon.props.color).toBe(label === 'Large expense' ? palettes[mode].statusText.serious : palettes[mode].brandText);
    }
    expect(screen.queryByText('CUSTOM_NOTICE')).toBeNull();
  });

  it('shows a loading state and an offline retry instead of claiming the alerts are empty', async () => {
    const pending = deferred<ReturnType<typeof unreadAlert>[]>();
    apiGet.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([unreadAlert(70)]);
    const screen = await renderScreen();
    expect(screen.getByLabelText('Loading alerts')).toBeTruthy();
    expect(screen.getByText('Checking alerts')).toBeTruthy();
    expect(screen.queryByText('No alerts yet')).toBeNull();
    expect(screen.queryByText('0 unread')).toBeNull();
    await act(async () => { pending.reject(Object.assign(new Error('Network request failed.'), { status: 0 })); await pending.promise.catch(() => undefined); });
    expect(screen.getByText('Alerts unavailable')).toBeTruthy();
    expect(screen.getByText("Can't reach FinSight")).toBeTruthy();
    expect(screen.queryByText('No alerts yet')).toBeNull();
    const notice = screen.getByRole('alert', { name: /Can't reach FinSight.*your alerts haven't loaded/ });
    expect(notice.props.accessible).toBe(true);
    expect(notice.props.accessibilityLiveRegion).toBe('assertive');
    expect(within(notice).queryByRole('button', { name: 'Try again' })).toBeNull();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).not.toBeDisabled();
    await fireEvent.press(retry);
    expect(await screen.findByRole('button', { name: 'Possible duplicate expense 70. Tap to mark as read.' })).toBeTruthy();
    expect(screen.queryByText("Can't reach FinSight")).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('keeps loaded alerts visible after a failed refresh and identifies the data as older', async () => {
    apiGet.mockResolvedValueOnce([unreadAlert(71)]).mockRejectedValueOnce(Object.assign(new Error('Network request failed.'), { status: 0 }));
    const screen = await renderScreen();
    await screen.findByRole('button', { name: 'Possible duplicate expense 71. Tap to mark as read.' });
    const refreshControl = findFiberByType(screen.root, RefreshControl);
    await act(async () => { await refreshControl?.memoizedProps.onRefresh(); });
    expect(screen.getByRole('button', { name: 'Possible duplicate expense 71. Tap to mark as read.' })).toBeTruthy();
    expect(screen.getByText(/What's on screen is what loaded/)).toBeTruthy();
    expect(screen.queryByText('No alerts yet')).toBeNull();
  });

  it('opens Recovery alert settings through the existing nested destination', async () => {
    apiGet.mockResolvedValue([]);
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await fireEvent.press(await screen.findByRole('button', { name: 'Recovery alert settings' }));
    expect(navigation.navigate).toHaveBeenCalledWith('More', { screen: 'RecoveryNotificationPreferences', initial: false });
  });

  it('keeps Recovery settings outside the virtualized feed with 289 read alerts and an empty unread filter', async () => {
    const history = Array.from({ length: 289 }, (_, index) => ({
      ...unreadAlert(index + 1),
      readStatus: true,
      message: `Read alert ${index + 1}. ${'A supplier expense may match another recorded expense. '.repeat(12)}`,
    }));
    apiGet.mockResolvedValue(history);
    const navigation = { navigate: vi.fn() };
    const screen = await renderScreen(navigation);
    await screen.findByRole('button', { name: 'Filter alerts, All (289)' });
    const list = findFiberByType(screen.root, SectionList);
    expect(list).not.toBeNull();
    const settings = screen.getByRole('button', { name: 'Recovery alert settings' });
    expect(findAncestorOfType(settings, SectionList)).toBeNull();
    expect(settings).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: `${history[288]!.message}. Already read.` })).toBeNull();
    await fireEvent.press(settings);
    expect(navigation.navigate).toHaveBeenLastCalledWith('More', { screen: 'RecoveryNotificationPreferences', initial: false });

    await fireEvent.press(screen.getByRole('button', { name: 'Filter alerts, Unread (0)' }));
    expect(screen.getByText('All alerts read')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Recovery alert settings' }));
    expect(navigation.navigate).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByRole('button', { name: 'View all alerts' }));
    expect(screen.getByRole('button', { name: 'Filter alerts, All (289)' }).props.accessibilityState.selected).toBe(true);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it.each([true, false])('honors stack back or the More fallback when canGoBack is %s', async (canGoBack) => {
    apiGet.mockResolvedValue([]);
    const navigation = { navigate: vi.fn(), goBack: vi.fn(), canGoBack: () => canGoBack };
    const screen = await renderScreen(navigation);
    await fireEvent.press(screen.getByRole('button', { name: 'Go back' }));
    if (canGoBack) {
      expect(navigation.goBack).toHaveBeenCalledTimes(1);
      expect(navigation.navigate).not.toHaveBeenCalled();
    } else {
      expect(navigation.goBack).not.toHaveBeenCalled();
      expect(navigation.navigate).toHaveBeenCalledWith('More', { screen: 'MoreHome', initial: false });
    }
  });
});
