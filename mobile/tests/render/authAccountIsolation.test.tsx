import React from 'react';
import { Text } from 'react-native';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, UserPreferences } from '../../src/lib/types';

const get = vi.fn();
const patch = vi.fn();
const setSession = vi.fn();
const authChange = { value: null as ((event: string) => void) | null };

vi.mock('../../src/lib/api', () => ({
  api: { get, patch, post: vi.fn() },
  errorMessage: (error: Error) => error.message,
  setSessionEndedHandler: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'account-a' } } })),
      onAuthStateChange: vi.fn((callback: (event: string) => void) => {
        authChange.value = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      setSession,
      signOut: vi.fn(async () => ({ error: null })),
    },
  },
}));

vi.mock('../../src/lib/receiptScannerCache', () => ({
  clearReceiptScannerCache: vi.fn(async () => 0),
}));

const { AuthProvider, useAuth } = await import('../../src/context/AuthContext');
const { createServerStateKey, getServerStateCacheStats } = await import('../../src/lib/serverStateCache');

const preferences = (showDashboardMascotMessage: boolean): UserPreferences => ({
  showDashboardMascotMessage,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
});

const profile = (id: number, email: string, prefs: UserPreferences): Profile => ({
  id,
  firstName: id === 1 ? 'Account A' : 'Account B',
  middleName: null,
  lastName: 'Owner',
  email,
  phoneNumber: null,
  status: 'ACTIVE',
  avatarUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  preferences: prefs,
});

const accountA = profile(1, 'a@example.com', preferences(true));
const accountB = profile(2, 'b@example.com', preferences(false));

let auth!: ReturnType<typeof useAuth>;

function Probe() {
  auth = useAuth();
  return (
    <>
      <Text>{auth.profile?.email ?? 'signed-out'}</Text>
      <Text>{auth.preferences.showDashboardMascotMessage ? 'mascot-on' : 'mascot-off'}</Text>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  setSession.mockReset().mockResolvedValue({ data: {}, error: null });
  authChange.value = null;
  get.mockImplementation(async (path: string) => {
    if (path === '/auth/me') return accountA;
    if (path === '/business-profiles') return [];
    throw new Error(`unexpected GET ${path}`);
  });
});

afterEach(async () => {
  await cleanup();
});

async function renderAccountA() {
  const queries = await render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(queries.getByText('a@example.com')).toBeTruthy());
  return queries;
}

async function switchToAccountB(queries: Awaited<ReturnType<typeof renderAccountA>>) {
  get.mockImplementation(async (path: string) => {
    if (path === '/auth/me') return accountB;
    if (path === '/business-profiles') return [];
    throw new Error(`unexpected GET ${path}`);
  });
  await act(async () => {
    await auth.adoptSession(
      { access_token: 'account-b-access', refresh_token: 'account-b-refresh' },
      accountB,
    );
  });
  await waitFor(() => expect(queries.getByText('b@example.com')).toBeTruthy());
}

describe('AuthContext account-generation isolation', () => {
  it("drops account A's late profile response after account B becomes active", async () => {
    const queries = await renderAccountA();
    const latePatch = deferred<Profile>();
    patch.mockReturnValueOnce(latePatch.promise);

    let pending!: Promise<void>;
    await act(async () => {
      pending = auth.updateProfile({ firstName: 'Account A changed' });
      await Promise.resolve();
    });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await switchToAccountB(queries);

    await act(async () => {
      latePatch.resolve({ ...accountA, firstName: 'Account A changed' });
      await pending;
    });

    expect(queries.getByText('b@example.com')).toBeTruthy();
    expect(createServerStateKey('/probe')).toContain(`user:${accountB.id}|`);
  });

  it("does not let account A's failed preference write roll back account B", async () => {
    const queries = await renderAccountA();
    const latePatch = deferred<UserPreferences>();
    patch.mockReturnValueOnce(latePatch.promise);

    let pending!: Promise<void>;
    await act(async () => {
      pending = auth.updatePreferences({ showDashboardMascotMessage: false });
      await Promise.resolve();
    });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await switchToAccountB(queries);

    await act(async () => {
      latePatch.reject(new Error('account A write failed late'));
      await pending.catch(() => undefined);
    });

    expect(queries.getByText('b@example.com')).toBeTruthy();
    expect(queries.getByText('mascot-off')).toBeTruthy();
    expect(createServerStateKey('/probe')).toContain(`user:${accountB.id}|`);
  });

  it('does not resurrect a cold-start account after a signed-out event', async () => {
    const lateProfile = deferred<Profile>();
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return lateProfile.promise;
      if (path === '/business-profiles') return Promise.resolve([]);
      throw new Error(`unexpected GET ${path}`);
    });

    const queries = await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(authChange.value).not.toBeNull());
    await act(async () => {
      authChange.value?.('SIGNED_OUT');
      lateProfile.resolve(accountA);
      await lateProfile.promise;
    });

    expect(queries.getByText('signed-out')).toBeTruthy();
    expect(auth.takeBootstrapProfiles()).toBeNull();
    expect(getServerStateCacheStats().scoped).toBe(false);
  });
});
