import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import { MAX_NAME_LENGTH, MAX_PHONE_LENGTH } from '../../src/lib/authValidation';

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
const logout = vi.fn();
const apiPost = vi.fn();
const apiPostWithToken = vi.fn();

/*
 * The throwaway recovery client, one mock per call the way the real factory
 * makes one client per call. `verifyOtp` is the new step: the reset email
 * carries GoTrue's code and no link at all now, so this is where a typed code
 * becomes the token pair the deep link used to deliver.
 */
const verifyOtp = vi.fn();
const setSession = vi.fn();
const updateUser = vi.fn();
const recoverySignOut = vi.fn();

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    login,
    register: registerUser,
    logout,
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
    postWithToken: (...args: unknown[]) => apiPostWithToken(...args),
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
    auth: {
      verifyOtp: (...args: unknown[]) => verifyOtp(...args),
      setSession: (...args: unknown[]) => setSession(...args),
      updateUser: (...args: unknown[]) => updateUser(...args),
      signOut: (...args: unknown[]) => recoverySignOut(...args),
    },
  }),
}));

vi.mock('../../src/lib/savedAccountStore', () => ({
  savedEmail: async () => null,
  isSavingAccount: async () => true,
  setSavedAccount: vi.fn(async () => {}),
}));

const { LoginScreen, RegisterScreen, RecoverPasswordScreen, ResetPasswordScreen } =
  await import('../../src/screens/AuthScreens');
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

function renderRecovery() {
  return render(
    <ThemeProvider initialMode="light">
      <RecoverPasswordScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  login.mockReset();
  registerUser.mockReset();
  apiPost.mockReset();
  apiPostWithToken.mockReset();
  apiPostWithToken.mockResolvedValue({});
  logout.mockReset();
  verifyOtp.mockReset();
  setSession.mockReset();
  setSession.mockResolvedValue({ error: null });
  updateUser.mockReset();
  updateUser.mockResolvedValue({ error: null });
  recoverySignOut.mockReset();
  recoverySignOut.mockResolvedValue({ error: null });
  navigation.navigate.mockReset();
});

describe('Auth navigation and dark theme', () => {
  it.each([
    [375, 1],
    [480, 1.3],
  ])('stacks the name fields at width %i and font scale %s', async (width, fontScale) => {
    const before = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    try {
      await act(async () => Dimensions.set({
        window: { ...before.window, width, fontScale },
        screen: { ...before.screen, width, fontScale },
      }));
      const queries = await renderRegister();
      const first = queries.getByLabelText('First name');
      const last = queries.getByLabelText('Last name');
      const firstAncestors = new Set();
      for (let node = first.parent; node; node = node.parent) firstAncestors.add(node);
      let common = last.parent;
      while (common && !firstAncestors.has(common)) common = common.parent;
      expect(common).not.toBeNull();
      expect(StyleSheet.flatten(common?.props.style)?.flexDirection).toBe('column');
    } finally {
      await act(async () => Dimensions.set(before));
    }
  });

  it.each([
    ['registration', RegisterScreen],
    ['password recovery', RecoverPasswordScreen],
  ] as const)('offers one clear return to login from %s', async (_name, Component) => {
    const queries = await render(
      <ThemeProvider initialMode="light">
        <Component navigation={navigation} />
      </ThemeProvider>,
    );
    expect(queries.getAllByRole('button', { name: 'Back to log in' })).toHaveLength(1);
    await fireEvent.press(queries.getByRole('button', { name: 'Back to log in' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });

  it.each([
    ['login', LoginScreen, 'Log in'],
    ['registration', RegisterScreen, 'Create account'],
    ['password recovery', RecoverPasswordScreen, 'Send code'],
  ] as const)('keeps the %s form accessible in the dark theme', async (_name, Component, action) => {
    const queries = await render(
      <ThemeProvider initialMode="dark">
        <Component navigation={navigation} />
      </ThemeProvider>,
    );
    expect(queries.getByLabelText('Email')).toBeTruthy();
    expect(queries.getAllByRole('button', { name: action })).toHaveLength(1);
    await fireEvent.press(queries.getByRole('button', { name: action }));
    expect(queries.getByLabelText('Email, Enter your email address.')).toBeTruthy();
  });
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

  it('includes trimmed optional contact details in registration', async () => {
    const queries = await renderRegister();
    await fill(queries);
    await fireEvent.changeText(queries.getByLabelText('Middle name (optional)'), '  Santos  ');
    await fireEvent.changeText(queries.getByLabelText('Phone number (optional)'), '  +639171234567  ');
    registerUser.mockResolvedValueOnce({ message: 'We sent a confirmation link.' });
    await fireEvent.press(queries.getByRole('button', { name: 'Create account' }));
    expect(registerUser).toHaveBeenCalledWith(expect.objectContaining({
      middleName: 'Santos', phoneNumber: '+639171234567',
    }));
  });

  it.each(['', '   '])('leaves optional details unset for blank input %j', async (blank) => {
    const queries = await renderRegister();
    await fill(queries);
    await fireEvent.changeText(queries.getByLabelText('Middle name (optional)'), blank);
    await fireEvent.changeText(queries.getByLabelText('Phone number (optional)'), blank);
    registerUser.mockResolvedValueOnce({ message: 'We sent a confirmation link.' });
    await fireEvent.press(queries.getByRole('button', { name: 'Create account' }));
    expect(registerUser).toHaveBeenCalledTimes(1);
    expect(registerUser.mock.calls[0][0].middleName).toBeUndefined();
    expect(registerUser.mock.calls[0][0].phoneNumber).toBeUndefined();
  });

  it('names optional server errors on their fields and clears them after edits', async () => {
    const queries = await renderRegister();
    await fill(queries);
    registerUser.mockRejectedValueOnce(Object.assign(new Error('Validation failed'), {
      fieldErrors: { middleName: 'Check your middle name.', phoneNumber: 'Check your phone number.' },
    }));
    await fireEvent.press(queries.getByRole('button', { name: 'Create account' }));
    await fireEvent.changeText(
      queries.getByLabelText('Middle name (optional), Check your middle name.'), 'Santos',
    );
    await fireEvent.changeText(
      queries.getByLabelText('Phone number (optional), Check your phone number.'), '+639171234567',
    );
    expect(queries.getByLabelText('Middle name (optional)')).toBeTruthy();
    expect(queries.getByLabelText('Phone number (optional)')).toBeTruthy();
    expect(queries.queryByText('Check your middle name.')).toBeNull();
    expect(queries.queryByText('Check your phone number.')).toBeNull();
  });

  it('rejects optional details beyond the existing length limits before registration', async () => {
    const queries = await renderRegister();
    await fill(queries);
    await fireEvent.changeText(queries.getByLabelText('Middle name (optional)'), 'a'.repeat(MAX_NAME_LENGTH + 1));
    await fireEvent.changeText(queries.getByLabelText('Phone number (optional)'), '1'.repeat(MAX_PHONE_LENGTH + 1));
    await fireEvent.press(queries.getByRole('button', { name: 'Create account' }));
    expect(queries.getByLabelText(`Middle name (optional), Keep this under ${MAX_NAME_LENGTH} characters.`)).toBeTruthy();
    expect(queries.getByLabelText(`Phone number (optional), Keep this under ${MAX_PHONE_LENGTH} characters.`)).toBeTruthy();
    expect(registerUser).not.toHaveBeenCalled();
  });

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

describe('Password recovery', () => {
  it('rejects a malformed email locally and names the error accessibly', async () => {
    const queries = await renderRecovery();
    await fireEvent.changeText(queries.getByLabelText('Email'), 'nena');
    await fireEvent.press(queries.getByRole('button', { name: 'Send code' }));

    expect(queries.getByLabelText("Email, That doesn't look like an email address.")).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('sends the address with the mobile platform and offers an editable return', async () => {
    apiPost.mockResolvedValue({});
    const queries = await renderRecovery();
    await fireEvent.changeText(queries.getByLabelText('Email'), 'nena@example.com');
    await fireEvent.press(queries.getByRole('button', { name: 'Send code' }));

    expect(apiPost).toHaveBeenCalledWith('/auth/recover-password', {
      email: 'nena@example.com', platform: 'mobile',
    });
    expect(await queries.findByText('nena@example.com')).toBeTruthy();
    // Straight on to the code form, with the address it was sent to. The email
    // has no link in it any more, so "check your inbox" cannot be the end.
    expect(navigation.navigate).toHaveBeenCalledWith('ResetPassword', {
      email: 'nena@example.com',
    });
    expect(queries.getByRole('button', { name: 'Send again in 60s' })).toBeDisabled();
    await fireEvent.press(queries.getByRole('button', { name: 'Use a different email' }));
    expect(queries.getByLabelText('Email')).toHaveProp('value', 'nena@example.com');
    await fireEvent.press(queries.getByRole('button', { name: 'Back to log in' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });

  it('allows a resend after the countdown and starts the cooldown again', async () => {
    vi.useFakeTimers();
    try {
      apiPost.mockResolvedValue({});
      const queries = await renderRecovery();
      await fireEvent.changeText(queries.getByLabelText('Email'), 'nena@example.com');
      await fireEvent.press(queries.getByRole('button', { name: 'Send code' }));
      expect(queries.getByRole('button', { name: 'Send again in 60s' })).toBeDisabled();
      for (let seconds = 0; seconds < 60; seconds += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      }
      const resend = queries.getByRole('button', { name: 'Send it again' });
      expect(resend).toBeEnabled();
      await fireEvent.press(resend);
      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(apiPost).toHaveBeenLastCalledWith('/auth/recover-password', {
        email: 'nena@example.com', platform: 'mobile',
      });
      expect(queries.getByRole('button', { name: 'Send again in 60s' })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Finishing a reset from the emailed CODE, which is now the only way.
 *
 * The Supabase template's button is gone, so `finsight://auth/reset-password`
 * will never fire again and this screen is reached by navigating rather than by
 * a link. What is proved here is the exchange and the tail after it; what is
 * NOT proved is anything about a real keyboard, the OS's one-time-code offer,
 * or a deep link, none of which exist off-device.
 */
describe('Reset password — the emailed code', () => {
  const session = { access_token: 'at-live', refresh_token: 'rt-live' };
  const onDone = vi.fn();
  const onNewCode = vi.fn();

  function renderReset(email = 'nena@example.com') {
    return render(
      <ThemeProvider initialMode="light">
        <ResetPasswordScreen email={email} onDone={onDone} onNewCode={onNewCode} />
      </ThemeProvider>,
    );
  }

  beforeEach(() => {
    onDone.mockReset();
    onNewCode.mockReset();
  });

  it('opens on the code form with the address already filled in', async () => {
    const queries = await renderReset();
    expect(queries.getByLabelText('Email')).toHaveProp('value', 'nena@example.com');
    expect(queries.getByLabelText('Recovery code')).toHaveProp('value', '');
  });

  it('checks the code\'s shape before spending a round trip on it', async () => {
    const queries = await renderReset();
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), '12ab');
    await fireEvent.press(queries.getByRole('button', { name: 'Continue' }));

    expect(queries.getByLabelText('Recovery code, The code is digits only.')).toBeTruthy();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('sends the code with the spaces and dashes stripped', async () => {
    verifyOtp.mockResolvedValueOnce({ data: { session }, error: null });
    const queries = await renderReset();
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), '7532 4744');
    await fireEvent.press(queries.getByRole('button', { name: 'Continue' }));

    expect(verifyOtp).toHaveBeenCalledWith({
      email: 'nena@example.com',
      token: '75324744',
      type: 'recovery',
    });
  });

  /**
   * THE ENUMERATION GUARD. `/auth/recover-password` answers identically for a
   * registered and an unregistered address on purpose; a form that said "no
   * such account" here would rebuild the oracle that endpoint refuses to be.
   * So a wrong address, a wrong code and an expired code read the same.
   */
  it.each([
    ['a rejected code', { data: { session: null }, error: { message: 'Token has expired or is invalid' } }],
    ['an unknown address', { data: { session: null }, error: { message: 'User not found' } }],
    ['a session-less success', { data: { session: null }, error: null }],
  ])('says the same thing for %s', async (_name, answer) => {
    verifyOtp.mockResolvedValueOnce(answer);
    const queries = await renderReset();
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), '75324744');
    await fireEvent.press(queries.getByRole('button', { name: 'Continue' }));

    expect(
      await queries.findByText(
        "That didn't work. Check the email address and the code — codes expire, so ask for a new one if this keeps failing.",
      ),
    ).toBeTruthy();
    // Still on the code form: retyping a digit is the likely fix, and starting
    // over is not.
    expect(queries.getByLabelText('Recovery code')).toBeTruthy();
  });

  it('never puts the code anywhere but the verify call', async () => {
    verifyOtp.mockResolvedValueOnce({ data: { session }, error: null });
    const queries = await renderReset();
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), '75324744');
    await fireEvent.press(queries.getByRole('button', { name: 'Continue' }));
    await queries.findByLabelText('New password');

    // The code is a live credential: our own backend never sees it.
    for (const call of [...apiPost.mock.calls, ...apiPostWithToken.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('75324744');
    }
  });

  it('sets the new password on the verified session and ends every other one', async () => {
    verifyOtp.mockResolvedValueOnce({ data: { session }, error: null });
    const queries = await renderReset();
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), '75324744');
    await fireEvent.press(queries.getByRole('button', { name: 'Continue' }));

    await fireEvent.changeText(
      await queries.findByLabelText('New password'),
      'hunter2hunter2',
    );
    await fireEvent.changeText(queries.getByLabelText('Confirm new password'), 'hunter2hunter2');
    await fireEvent.press(queries.getByRole('button', { name: 'Save new password' }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'hunter2hunter2' }));
    expect(setSession).toHaveBeenCalledWith({
      access_token: 'at-live',
      refresh_token: 'rt-live',
    });
    // The backend is told only afterwards, and only so it can revoke the rest.
    expect(apiPostWithToken).toHaveBeenCalledWith('/auth/reset-password/complete', 'at-live');
    // The throwaway client is signed out on every path.
    expect(recoverySignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(await queries.findByRole('button', { name: 'Log in' })).toBeTruthy();
  });

  /**
   * A pair that expired between the code and the save puts the code form back
   * rather than leaving the owner on a password form that cannot save.
   */
  it('returns to the code form when the verified session has expired', async () => {
    verifyOtp.mockResolvedValueOnce({ data: { session }, error: null });
    setSession.mockResolvedValueOnce({ error: { message: 'expired' } });
    const queries = await renderReset();
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), '75324744');
    await fireEvent.press(queries.getByRole('button', { name: 'Continue' }));

    await fireEvent.changeText(
      await queries.findByLabelText('New password'),
      'hunter2hunter2',
    );
    await fireEvent.changeText(queries.getByLabelText('Confirm new password'), 'hunter2hunter2');
    await fireEvent.press(queries.getByRole('button', { name: 'Save new password' }));

    expect(await queries.findByLabelText('Recovery code')).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('offers a way back to ask for a new code, and to the log-in screen', async () => {
    const queries = await renderReset();
    await fireEvent.press(queries.getByRole('button', { name: 'Send a new code' }));
    expect(onNewCode).toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Back to log in' }));
    expect(onDone).toHaveBeenCalled();
  });
});
