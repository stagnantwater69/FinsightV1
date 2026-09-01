import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react-native';

/**
 * The same-frame double tap on sign-out — deliberately in a file of its own.
 *
 * To reproduce a double tap honestly the two presses have to be dispatched
 * with no render between them, which means two overlapping `act()` scopes.
 * React tolerates that for the assertion but leaves its act queue in a state
 * that breaks any test rendered afterwards in the same file, so this case is
 * isolated rather than left to poison the rest of `signOutSheet.test.tsx`.
 *
 * WHAT IT CAUGHT: the handler originally guarded on the `busy` STATE. State
 * only changes on the next render, so both presses read `false` and both
 * called `logout()` — the exact second sign-out the guard exists to prevent.
 * `SignOutSheet` now guards on a ref, which moves on the first press.
 */

const logout = vi.fn();

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    logout,
    login: vi.fn(),
    register: vi.fn(),
    profile: null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { SignOutSheet } = await import('../../src/components/SignOutSheet');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

describe('SignOutSheet — double tap', () => {
  it('calls logout once when confirm is pressed twice in the same frame', async () => {
    let finish: () => void = () => {};
    logout.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    const queries = await render(
      <ThemeProvider initialMode="light">
        <SignOutSheet visible onClose={vi.fn()} />
      </ThemeProvider>,
    );
    const confirm = queries.getByRole('button', { name: 'Sign out' });

    const first = fireEvent.press(confirm);
    const second = fireEvent.press(confirm);

    expect(logout).toHaveBeenCalledTimes(1);

    finish();
    await Promise.all([first, second]);
  });
});
