import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Pressable, Text, type AppStateStatus } from 'react-native';

const apiGet = vi.fn();
const focusHarness = vi.hoisted(() => ({
  focused: true,
  listeners: new Set<() => void>(),
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const [, rerender] = React.useReducer((value: number) => value + 1, 0);
    const focused = focusHarness.focused;
    React.useEffect(() => {
      const listener = () => rerender();
      focusHarness.listeners.add(listener);
      return () => {
        focusHarness.listeners.delete(listener);
      };
    }, []);
    React.useEffect(() => {
      if (!focused) return;
      return effect();
    }, [effect, focused]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Something went wrong.',
}));

const { useServerStateQuery } = await import('../../src/lib/useInsight');
const {
  beginServerStateSession,
  clearServerStateCache,
  fetchServerState,
  invalidateServerStateForMutation,
} = await import('../../src/lib/serverStateCache');

const PATH = '/insights/expense-overview';
const appStateListeners = new Set<(state: AppStateStatus) => void>();
let restoreAppState: (() => void) | undefined;

function query(businessProfileId: number, month: string) {
  return {
    businessProfileId,
    periodKind: 'month',
    month,
    view: 'detail',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe({
  businessProfileId,
  month,
  staleTimeMs = 60_000,
}: {
  businessProfileId: number;
  month: string;
  staleTimeMs?: number;
}) {
  const state = useServerStateQuery<{ label: string }>(
    PATH,
    query(businessProfileId, month),
    [businessProfileId, month],
    { staleTimeMs },
  );

  return (
    <>
      <Text>{state.loading ? 'Loading' : state.data?.label ?? 'No data'}</Text>
      <Text>{state.refreshing ? 'Refreshing' : 'Idle'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh" onPress={() => void state.load()}>
        <Text>Refresh</Text>
      </Pressable>
    </>
  );
}

async function seed(
  businessProfileId: number,
  month: string,
  label: string,
  staleTimeMs = 60_000,
) {
  await fetchServerState({
    path: PATH,
    query: query(businessProfileId, month),
    fetcher: async () => ({ label }),
    staleTimeMs,
  });
}

async function setFocused(focused: boolean) {
  focusHarness.focused = focused;
  await act(async () => {
    for (const listener of focusHarness.listeners) listener();
  });
}

beforeEach(() => {
  clearServerStateCache();
  beginServerStateSession(7);
  apiGet.mockReset();
  appStateListeners.clear();
  focusHarness.focused = true;
  focusHarness.listeners.clear();
  const appStateSpy = vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    const callback = listener as (state: AppStateStatus) => void;
    appStateListeners.add(callback);
    return {
      remove: () => appStateListeners.delete(callback),
    };
  });
  restoreAppState = () => appStateSpy.mockRestore();
});

afterEach(async () => {
  await cleanup();
  restoreAppState?.();
  restoreAppState = undefined;
  appStateListeners.clear();
  focusHarness.listeners.clear();
  clearServerStateCache();
});

describe('useServerStateQuery lifecycle', () => {
  it('reuses fresh data when the same screen focuses again', async () => {
    apiGet.mockResolvedValue({ label: 'Current overview' });

    const queries = await render(<Probe businessProfileId={1} month="2026-08" />);
    expect(await queries.findByText('Current overview')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(1);

    await setFocused(false);
    await setFocused(true);

    expect(queries.getByText('Current overview')).toBeTruthy();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
  });

  it('keeps stale content visible while focus revalidates it', async () => {
    await seed(1, '2026-08', 'Cached overview', 0);
    const request = deferred<{ label: string }>();
    apiGet.mockReturnValue(request.promise);

    const queries = await render(
      <Probe businessProfileId={1} month="2026-08" staleTimeMs={0} />,
    );

    expect(queries.getByText('Cached overview')).toBeTruthy();
    expect(queries.queryByText('Loading')).toBeNull();
    await waitFor(() => expect(queries.getByText('Refreshing')).toBeTruthy());

    await act(async () => {
      request.resolve({ label: 'Fresh overview' });
      await request.promise;
    });
    expect(await queries.findByText('Fresh overview')).toBeTruthy();
    expect(queries.getByText('Idle')).toBeTruthy();
  });

  it('explicitly refreshes fresh data without replacing it with a loading state', async () => {
    await seed(1, '2026-08', 'Cached overview');
    const request = deferred<{ label: string }>();
    apiGet.mockReturnValue(request.promise);
    const queries = await render(<Probe businessProfileId={1} month="2026-08" />);

    expect(queries.getByText('Cached overview')).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(queries.getByText('Refreshing')).toBeTruthy());
    expect(queries.getByText('Cached overview')).toBeTruthy();
    expect(queries.queryByText('Loading')).toBeNull();

    await act(async () => {
      request.resolve({ label: 'Refreshed overview' });
      await request.promise;
    });
    expect(await queries.findByText('Refreshed overview')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('ignores an old response after the business and period change', async () => {
    const oldRequest = deferred<{ label: string }>();
    apiGet.mockImplementation(
      (_path: string, requestQuery: ReturnType<typeof query>) =>
        requestQuery.businessProfileId === 1
          ? oldRequest.promise
          : Promise.resolve({ label: 'Business two overview' }),
    );

    const queries = await render(<Probe businessProfileId={1} month="2026-08" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await queries.rerender(<Probe businessProfileId={2} month="2026-09" />);

    expect(await queries.findByText('Business two overview')).toBeTruthy();
    await act(async () => {
      oldRequest.resolve({ label: 'Old business overview' });
      await oldRequest.promise;
    });

    expect(queries.getByText('Business two overview')).toBeTruthy();
    expect(queries.queryByText('Old business overview')).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('deduplicates focus and foreground revalidation while preserving cached content', async () => {
    await seed(1, '2026-08', 'Cached overview', 0);
    const request = deferred<{ label: string }>();
    apiGet.mockReturnValue(request.promise);
    const queries = await render(
      <Probe businessProfileId={1} month="2026-08" staleTimeMs={0} />,
    );

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      for (const listener of appStateListeners) listener('background');
      for (const listener of appStateListeners) listener('active');
    });

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(queries.getByText('Cached overview')).toBeTruthy();
    expect(queries.queryByText('Loading')).toBeNull();

    await act(async () => {
      request.resolve({ label: 'Foreground overview' });
      await request.promise;
    });
    expect(await queries.findByText('Foreground overview')).toBeTruthy();
  });

  it('revalidates an affected active query after a record mutation without blanking it', async () => {
    await seed(1, '2026-08', 'Before mutation');
    const request = deferred<{ label: string }>();
    apiGet.mockReturnValue(request.promise);
    const queries = await render(<Probe businessProfileId={1} month="2026-08" />);

    expect(queries.getByText('Before mutation')).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();

    await act(async () => {
      invalidateServerStateForMutation('POST', '/records/expenses', {
        businessProfileId: 1,
      });
    });

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(queries.getByText('Before mutation')).toBeTruthy();
    expect(queries.queryByText('Loading')).toBeNull();

    await act(async () => {
      request.resolve({ label: 'After mutation' });
      await request.promise;
    });
    expect(await queries.findByText('After mutation')).toBeTruthy();
  });

  it('revalidates the active expense overview after a finding is reviewed', async () => {
    await seed(1, '2026-08', 'Before finding review');
    const request = deferred<{ label: string }>();
    apiGet.mockReturnValue(request.promise);
    const queries = await render(<Probe businessProfileId={1} month="2026-08" />);

    expect(queries.getByText('Before finding review')).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();

    await act(async () => {
      invalidateServerStateForMutation('PATCH', '/insights/findings/42/review');
    });

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(queries.getByText('Before finding review')).toBeTruthy();
    expect(queries.queryByText('Loading')).toBeNull();

    await act(async () => {
      request.resolve({ label: 'After finding review' });
      await request.promise;
    });
    expect(await queries.findByText('After finding review')).toBeTruthy();
  });
});
