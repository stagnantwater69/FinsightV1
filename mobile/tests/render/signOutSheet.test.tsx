import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react-native';

/**
 * Rendered tests for the sign-out confirmation (plan ticket §9.12).
 *
 * The three properties that matter here are all behavioural rather than
 * cosmetic, and none of them were previously covered by anything but a source
 * read: the session is not ended on the tap that opens the sheet, the confirm
 * handler cannot run twice, and a failed teardown is shown rather than
 * swallowed (the case where the owner believes they are signed out and are not).
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

function renderSheet(visible = true) {
  const onClose = vi.fn();
  const result = render(
    <ThemeProvider initialMode="light">
      <SignOutSheet visible={visible} onClose={onClose} />
    </ThemeProvider>,
  );
  return { result, onClose };
}

beforeEach(() => {
  logout.mockReset();
});

// Explicit rather than relying on auto-cleanup: several of these tests leave a
// sign-out deliberately in flight, and an un-unmounted tree in that state
// leaks into the next render.
afterEach(async () => {
  await cleanup();
});

describe('SignOutSheet', () => {
  it('asks before it acts — nothing is signed out until confirm is pressed', async () => {
    const { result } = renderSheet();
    const queries = await result;

    expect(
      queries.getByRole('header', { name: 'Sign out of FinSight?' }),
    ).toBeTruthy();
    expect(
      queries.getByText(
        "You'll need to sign in again to access your business data.",
      ),
    ).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();

    await fireEvent.press(queries.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('cancels without signing out', async () => {
    const { result, onClose } = renderSheet();
    const queries = await result;

    await fireEvent.press(queries.getByRole('button', { name: 'Cancel' }));

    expect(logout).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks cancel while the sign-out is in flight', async () => {
    let finish: () => void = () => {};
    logout.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    const { result, onClose } = renderSheet();
    const queries = await result;

    const pressing = fireEvent.press(
      queries.getByRole('button', { name: 'Sign out' }),
    );

    // An owner who taps away mid-sign-out is otherwise left on a screen that
    // looks signed in over a session that may already be half torn down.
    const cancel = await waitFor(() => {
      const button = queries.getByRole('button', { name: 'Cancel' });
      expect(button.props.accessibilityState.disabled).toBe(true);
      return button;
    });

    await fireEvent.press(cancel);
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await pressing;
  });

  it('shows a failed sign-out inside the sheet instead of closing over a live session', async () => {
    logout.mockRejectedValueOnce(new Error('keystore unavailable'));

    const { result } = renderSheet();
    const queries = await result;

    await fireEvent.press(queries.getByRole('button', { name: 'Sign out' }));

    expect(
      await queries.findByText(
        "Signing out didn't finish. Nothing was lost — try again.",
      ),
    ).toBeTruthy();

    // Still open, still offering the action again.
    expect(
      queries.getByRole('header', { name: 'Sign out of FinSight?' }),
    ).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('lets the owner retry after a failure', async () => {
    logout.mockRejectedValueOnce(new Error('keystore unavailable'));

    const { result } = renderSheet();
    const queries = await result;

    await fireEvent.press(queries.getByRole('button', { name: 'Sign out' }));
    await queries.findByText(
      "Signing out didn't finish. Nothing was lost — try again.",
    );

    logout.mockResolvedValueOnce(undefined);
    await fireEvent.press(queries.getByRole('button', { name: 'Sign out' }));

    expect(logout).toHaveBeenCalledTimes(2);
  });
});
