import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';

/**
 * Rendered accessibility tests for the auth screens (plan ticket §9.12).
 *
 * WHAT THESE PROVE, and it is the half that used to fail silently: when a
 * submit is rejected, the offending field's own accessible NAME carries the
 * reason. Phase 1 moved the error into the name specifically because the
 * message below the field is a polite live region, and a polite announcement
 * queues behind the focus change and gets cut off — so the owner landed on a
 * box that said "Email, edit box" and nothing about why.
 *
 * WHAT THEY DO NOT PROVE: that focus physically moves. `focusFirstInvalid`
 * calls `TextInput.focus()`, which is a native command; off-device there is no
 * focus to move and no renderer that records the attempt. Whether the keyboard
 * actually lands on the right field, and whether VoiceOver/TalkBack reads the
 * name at the right moment, still needs a device. See the plan's Phase 4
 * section.
 */

const login = vi.fn();
const registerUser = vi.fn();
const apiPost = vi.fn();

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    login,
    register: registerUser,
    logout: vi.fn(),
    profile: null,
    loading: false,
    takeBootstrapProfiles: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]) => apiPost(...args),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong.',
  getFieldErrors: (err: unknown) =>
    (err as { fieldErrors?: Record<string, string> })?.fieldErrors ?? {},
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {},
  API_BASE_URL: 'http://harness.test',
  createRecoveryClient: () => ({
    auth: { setSession: vi.fn(), updateUser: vi.fn(), signOut: vi.fn() },
  }),
}));

vi.mock('../../src/lib/savedAccountStore', () => ({
  savedEmail: async () => null,
  isSavingAccount: async () => true,
  setSavedAccount: vi.fn(async () => {}),
}));

const { LoginScreen, RegisterScreen } = await import(
  '../../src/screens/AuthScreens'
);
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const navigation = { navigate: vi.fn(), goBack: vi.fn(), replace: vi.fn() };

function renderLogin() {
  return render(
    <ThemeProvider initialMode="light">
      <LoginScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

function renderRegister() {
  return render(
    <ThemeProvider initialMode="light">
      <RegisterScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  login.mockReset();
  registerUser.mockReset();
  apiPost.mockReset();
  navigation.navigate.mockReset();
});

describe('Login — a rejected submit', () => {
  it('folds the reason into the first invalid field\'s accessible name', async () => {
    const queries = await renderLogin();

    // Before submitting, the name is just the label — nothing is wrong yet.
    expect(queries.getByLabelText('Email')).toBeTruthy();

    await fireEvent.press(queries.getByRole('button', { name: 'Log in' }));

    // The field now names itself AND the problem, in one string, so a reader
    // parked on it after the focus change hears both.
    expect(
      await queries.findByLabelText('Email, Enter your email address.'),
    ).toBeTruthy();
    expect(queries.queryByLabelText('Email')).toBeNull();
  });

  it('marks every invalid field, not only the first', async () => {
    const queries = await renderLogin();

    await fireEvent.press(queries.getByRole('button', { name: 'Log in' }));

    expect(
      await queries.findByLabelText('Email, Enter your email address.'),
    ).toBeTruthy();
    expect(queries.getByLabelText('Password, Enter your password.')).toBeTruthy();
  });

  it('names a malformed address differently from a missing one', async () => {
    const queries = await renderLogin();

    await fireEvent.changeText(queries.getByLabelText('Email'), 'nena');
    await fireEvent.press(queries.getByRole('button', { name: 'Log in' }));

    expect(
      await queries.findByLabelText(
        "Email, That doesn't look like an email address.",
      ),
    ).toBeTruthy();
  });

  it('clears the reason from the name as soon as the field is corrected', async () => {
    const queries = await renderLogin();

    await fireEvent.press(queries.getByRole('button', { name: 'Log in' }));
    const marked = await queries.findByLabelText(
      'Email, Enter your email address.',
    );

    await fireEvent.changeText(marked, 'nena@example.com');

    await waitFor(() => {
      expect(queries.getByLabelText('Email')).toBeTruthy();
      expect(
        queries.queryByLabelText('Email, Enter your email address.'),
      ).toBeNull();
    });
  });

  it('puts a server-rejected field under that field rather than in a form-level note', async () => {
    const queries = await renderLogin();

    await fireEvent.changeText(
      queries.getByLabelText('Email'),
      'nena@example.com',
    );
    await fireEvent.changeText(queries.getByLabelText('Password'), 'hunter2!');

    login.mockRejectedValueOnce(
      Object.assign(new Error('Validation failed'), {
        fieldErrors: { email: 'No account uses this address.' },
      }),
    );

    await fireEvent.press(queries.getByRole('button', { name: 'Log in' }));

    expect(
      await queries.findByLabelText('Email, No account uses this address.'),
    ).toBeTruthy();
  });

  it('does not send the request at all when the form is locally invalid', async () => {
    const queries = await renderLogin();

    await fireEvent.press(queries.getByRole('button', { name: 'Log in' }));

    // A round trip would bring back the same answer, at the owner's expense.
    expect(login).not.toHaveBeenCalled();
  });
});

describe('Register — the success panel', () => {
  const fill = async (queries: Awaited<ReturnType<typeof renderRegister>>) => {
    await fireEvent.changeText(queries.getByLabelText('First name'), 'Nena');
    await fireEvent.changeText(queries.getByLabelText('Last name'), 'Cruz');
    await fireEvent.changeText(
      queries.getByLabelText('Email'),
      'nena@example.com',
    );
    await fireEvent.changeText(
      queries.getByLabelText('Password'),
      'hunter2hunter2',
    );
    await fireEvent.changeText(
      queries.getByLabelText('Confirm password'),
      'hunter2hunter2',
    );
  };

  it('announces the outcome through a polite live region and shows the address it went to', async () => {
    const queries = await renderRegister();
    await fill(queries);

    registerUser.mockResolvedValueOnce({
      message: 'We sent a confirmation link.',
    });
    await fireEvent.press(
      queries.getByRole('button', { name: 'Create account' }),
    );

    const body = await queries.findByText('We sent a confirmation link.');
    expect(body).toBeTruthy();

    // Nothing navigates — the form is replaced in place — so without the live
    // region a screen-reader user hears nothing at all after the tap.
    const panel = body.parent;
    expect(panel?.props.accessibilityLiveRegion).toBe('polite');

    // The address is shown so a typo is visible while it can still be fixed.
    expect(queries.getByText('nena@example.com')).toBeTruthy();
  });

  it('counts the resend cooldown down inside the button label', async () => {
    vi.useFakeTimers();
    try {
      const queries = await renderRegister();
      await fill(queries);

      registerUser.mockResolvedValueOnce({
        message: 'We sent a confirmation link.',
      });
      await fireEvent.press(
        queries.getByRole('button', { name: 'Create account' }),
      );

      // The first mail has just gone out, so the resend starts on cooldown.
      const button = await queries.findByRole('button', {
        name: 'Send again in 60s',
      });
      expect(button.props.accessibilityState.disabled).toBe(true);

      // The number is IN the label, not in a caption beside a disabled
      // control — a disabled button with no stated reason is the one owners
      // tap repeatedly and then report as broken.
      // One second at a time. The countdown is a chain of single timeouts —
      // each tick re-renders, and the NEXT timeout is only scheduled by the
      // effect that runs after that render — so the ticks have to be let
      // through one act() at a time rather than in one jump.
      for (const expected of [59, 58, 57]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(
          queries.getByRole('button', { name: `Send again in ${expected}s` }),
        ).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a way back to the form when the address was mistyped', async () => {
    const queries = await renderRegister();
    await fill(queries);

    registerUser.mockResolvedValueOnce({
      message: 'We sent a confirmation link.',
    });
    await fireEvent.press(
      queries.getByRole('button', { name: 'Create account' }),
    );

    const escape = await queries.findByRole('button', {
      name: 'Use a different email',
    });
    await fireEvent.press(escape);

    // Back on the owner's own filled-in form, not through registration again.
    await waitFor(() =>
      expect(queries.getByLabelText('Email').props.value).toBe(
        'nena@example.com',
      ),
    );
  });
});
