import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

const get = vi.fn();
const post = vi.fn();
const signOut = vi.fn();
const clearReceiptScannerCache = vi.fn();

const profile = {
  id: 7,
  firstName: 'Ana',
  middleName: null,
  lastName: 'Reyes',
  email: 'ana@example.com',
  phoneNumber: null,
  status: 'ACTIVE',
  avatarUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../../src/lib/api', () => ({
  api: {
    get,
    post,
    patch: vi.fn(),
  },
  errorMessage: (error: Error) => error.message,
  setSessionEndedHandler: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      setSession: vi.fn(),
      signOut,
    },
  },
}));

vi.mock('../../src/lib/receiptScannerCache', () => ({ clearReceiptScannerCache }));

const { AuthProvider, useAuth } = await import('../../src/context/AuthContext');

let auth!: ReturnType<typeof useAuth>;

function Probe() {
  auth = useAuth();
  return <Text>{auth.profile ? `Signed in as ${auth.profile.id}` : 'Signed out'}</Text>;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  signOut.mockReset();
  clearReceiptScannerCache.mockReset();
  signOut.mockResolvedValue({ error: null });
  clearReceiptScannerCache.mockResolvedValue(0);
  get.mockImplementation(async (path: string) => (path === '/auth/me' ? profile : []));
});

afterEach(async () => {
  await cleanup();
});

async function renderSignedInProvider() {
  const queries = await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(queries.getByText('Signed in as 7')).toBeTruthy());
  return queries;
}

describe('AuthProvider logout scopes', () => {
  it('uses Supabase local scope for an ordinary this-phone logout', async () => {
    post.mockRejectedValueOnce(new Error('backend unavailable'));
    const queries = await renderSignedInProvider();

    await act(async () => {
      await auth.logout();
    });

    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(queries.getByText('Signed out')).toBeTruthy();
  });

  it('keeps the local session when the server does not confirm global revocation', async () => {
    post.mockRejectedValueOnce(new Error('network unavailable'));
    const queries = await renderSignedInProvider();

    await act(async () => {
      await expect(auth.logoutEverywhere()).rejects.toThrow('network unavailable');
    });

    expect(post).toHaveBeenCalledWith('/auth/logout-all');
    expect(signOut).not.toHaveBeenCalled();
    expect(clearReceiptScannerCache).not.toHaveBeenCalled();
    expect(queries.getByText('Signed in as 7')).toBeTruthy();
  });

  it('clears the local session only after the server confirms global revocation', async () => {
    post.mockResolvedValueOnce(undefined);
    const queries = await renderSignedInProvider();

    await act(async () => {
      await auth.logoutEverywhere();
    });

    expect(post).toHaveBeenCalledWith('/auth/logout-all');
    expect(clearReceiptScannerCache).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(queries.getByText('Signed out')).toBeTruthy();
  });

  it('finishes confirmed global logout when Supabase local cleanup rejects', async () => {
    post.mockResolvedValueOnce(undefined);
    signOut.mockRejectedValueOnce(new Error('keystore unavailable'));
    const queries = await renderSignedInProvider();

    await act(async () => {
      await auth.logoutEverywhere();
    });

    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(queries.getByText('Signed out')).toBeTruthy();
  });
});
