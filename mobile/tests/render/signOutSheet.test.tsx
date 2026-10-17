import React from 'react';
import { Modal, Pressable } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, fireEvent, waitFor } from '@testing-library/react-native';

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
const logoutEverywhere = vi.fn();

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    logout,
    logoutEverywhere,
    login: vi.fn(),
    register: vi.fn(),
    profile: null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { SignOutSheet } = await import('../../src/components/SignOutSheet');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

function renderSheet(visible = true, scope: "local" | "all" = "local") {
  const onClose = vi.fn();
  const result = render(
    <ThemeProvider initialMode="light">
      <SignOutSheet visible={visible} onClose={onClose} scope={scope} />
    </ThemeProvider>,
  );
  return { result, onClose };
}

function findFiber(node: { unstable_fiber?: any }, type: unknown, matches: (props: any) => boolean = () => true) {
  let root = node.unstable_fiber;
  while (root?.return) root = root.return;
  const pending = root ? [root] : [];
  while (pending.length > 0) {
    const fiber = pending.pop();
    if ((fiber?.type === type || fiber?.elementType === type) && matches(fiber.memoizedProps)) return fiber;
    if (fiber?.sibling) pending.push(fiber.sibling);
    if (fiber?.child) pending.push(fiber.child);
  }
  return null;
}

function pressHandler(node: { unstable_fiber?: any }): () => unknown {
  const button = findPressable(node);
  expect(button?.memoizedProps.onPress).toEqual(expect.any(Function));
  return button.memoizedProps.onPress;
}

function findPressable(node: { unstable_fiber?: any }) {
  let fiber = node.unstable_fiber;
  while (fiber) {
    if (fiber.type === Pressable || fiber.elementType === Pressable) return fiber;
    fiber = fiber.return;
  }
  return null;
}

beforeEach(() => {
  logout.mockReset();
  logoutEverywhere.mockReset();
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

  it('blocks captured cancel, backdrop and system-back handlers in the same frame as confirmation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    logout.mockReturnValueOnce(pending);
    const { result, onClose } = renderSheet();
    const queries = await result;
    const confirm = pressHandler(queries.getByRole('button', { name: 'Sign out' }));
    const cancel = pressHandler(queries.getByRole('button', { name: 'Cancel' }));
    const root = queries.root;
    if (root === null) throw new Error('Sign-out confirmation did not render.');
    const modal = findFiber(root, Modal);
    const backdrop = findFiber(root, Pressable, (props) => props.accessible === false && props.importantForAccessibility === 'no-hide-descendants');
    expect(modal?.memoizedProps.onRequestClose).toEqual(expect.any(Function));
    expect(backdrop?.memoizedProps.onPress).toEqual(expect.any(Function));
    const systemBack = modal.memoizedProps.onRequestClose;
    const dismissBackdrop = backdrop.memoizedProps.onPress;

    await act(() => {
      void confirm();
      cancel();
      systemBack();
      dismissBackdrop();
    });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(logoutEverywhere).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(queries.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(queries.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    await act(async () => { finish(); await pending; });
  });

  it('shows a failed sign-out inside the sheet instead of closing over a live session', async () => {
    logout.mockRejectedValueOnce(new Error('keystore unavailable'));

    const { result } = renderSheet();
    const queries = await result;

    await fireEvent.press(queries.getByRole('button', { name: 'Sign out' }));

    expect(
      await queries.findByText(
        "Signing out didn't finish. You're still signed in on this phone. Try again.",
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
      "Signing out didn't finish. You're still signed in on this phone. Try again.",
    );

    logout.mockResolvedValueOnce(undefined);
    await fireEvent.press(queries.getByRole('button', { name: 'Sign out' }));

    expect(logout).toHaveBeenCalledTimes(2);
  });

  it('keeps global sign-out open with a recoverable error when revocation is not confirmed', async () => {
    logoutEverywhere.mockRejectedValueOnce(new Error('network unavailable'));

    const { result } = renderSheet(true, 'all');
    const queries = await result;

    expect(queries.getByRole('header', { name: 'Sign out on all devices?' })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Sign out everywhere' }));

    expect(
      await queries.findByText(
        "Signing out on all devices didn't finish. This phone still shows your account, but other devices may already be unable to renew their sessions. Check your connection and try again.",
      ),
    ).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();
    expect(queries.getByRole('button', { name: 'Sign out everywhere' })).toBeTruthy();
  });

  it('lets the owner retry global sign-out after a failed attempt', async () => {
    logoutEverywhere
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(undefined);

    const { result } = renderSheet(true, 'all');
    const queries = await result;

    await fireEvent.press(queries.getByRole('button', { name: 'Sign out everywhere' }));
    await queries.findByText(/other devices may already be unable to renew their sessions/i);
    await fireEvent.press(queries.getByRole('button', { name: 'Sign out everywhere' }));

    expect(logoutEverywhere).toHaveBeenCalledTimes(2);
  });
});
