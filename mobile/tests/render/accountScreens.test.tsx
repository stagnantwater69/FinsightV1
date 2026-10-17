import React from 'react';
import { Alert } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react-native';
import type { Profile } from '../../src/lib/types';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { takeFlash } from '../../src/lib/flash';

const updateProfile = vi.fn();
const changePassword = vi.fn();
const logout = vi.fn();
const logoutEverywhere = vi.fn();
const setProfileFromServer = vi.fn();
const apiUpload = vi.fn();
const apiDelete = vi.fn();
const launchPicker = vi.fn();
const navigate = vi.fn();
const goBack = vi.fn();
const dispatch = vi.fn();
const preventRemove = vi.fn();
const initialProfile: Profile = {
  id: 41, firstName: 'Nena', middleName: null, lastName: 'Reyes',
  email: 'owner@example.test', phoneNumber: '09171234567', status: 'Active',
  avatarUrl: null, createdAt: '2026-09-01T00:00:00Z',
};
let profile: Profile | null = initialProfile;

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  usePreventRemove: (...args: unknown[]) => preventRemove(...args),
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => launchPicker(...args),
}));
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ profile, updateProfile, changePassword, logout, logoutEverywhere, setProfileFromServer }),
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ selected: null, profiles: [] }),
}));
vi.mock('../../src/lib/api', () => ({
  api: {
    upload: (...args: unknown[]) => apiUpload(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed.',
  getFieldErrors: (error: unknown) => (error as { fieldErrors?: Record<string, string> })?.fieldErrors ?? {},
}));

const { ProfileScreen, EditProfileScreen, ChangePasswordScreen, DeleteAccountScreen } =
  await import('../../src/screens/AccountScreens');
const { MoreScreen } = await import('../../src/screens/MoreScreen');
type AccountComponent = typeof ProfileScreen;
const tree = (Component: AccountComponent, mode: 'light' | 'dark' = 'light') =>
  <ThemeProvider initialMode={mode}><Component navigation={{ navigate, goBack, dispatch, canGoBack: () => true }} /></ThemeProvider>;

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function pressHandler(node: ReturnType<Awaited<ReturnType<typeof render>>['getByRole']>): () => void {
  type Fiber = { return?: Fiber; memoizedProps?: { onPress?: () => void } };
  let fiber = (node as unknown as { unstable_fiber: Fiber }).unstable_fiber;
  while (!fiber.memoizedProps?.onPress && fiber.return) fiber = fiber.return;
  expect(fiber.memoizedProps?.onPress).toBeTypeOf('function');
  return fiber.memoizedProps!.onPress!;
}

async function fillPassword(screen: Awaited<ReturnType<typeof render>>, password = 'new-password-123') {
  await fireEvent.changeText(screen.getByLabelText('Current password'), 'current-password');
  await fireEvent.changeText(screen.getByLabelText('New password'), password);
  await fireEvent.changeText(screen.getByLabelText('Confirm new password'), password);
}

beforeEach(() => {
  profile = { ...initialProfile };
  updateProfile.mockReset().mockImplementation(async (input: Partial<Profile>) => { profile = { ...profile!, ...input }; });
  changePassword.mockReset().mockResolvedValue(undefined);
  logout.mockReset().mockResolvedValue(undefined);
  logoutEverywhere.mockReset().mockResolvedValue(undefined);
  setProfileFromServer.mockReset().mockImplementation((updated: Profile) => { profile = updated; });
  apiUpload.mockReset(); apiDelete.mockReset();
  launchPicker.mockReset().mockResolvedValue({ canceled: true, assets: [] });
  navigate.mockReset(); goBack.mockReset(); dispatch.mockReset(); preventRemove.mockReset();
});
afterEach(async () => { await cleanup(); takeFlash(); vi.restoreAllMocks(); });

describe('My account overview', () => {
  it.each(['light', 'dark'] as const)('opens separate account forms without sign-out controls in %s', async (mode) => {
    const screen = await render(tree(ProfileScreen, mode));
    expect(screen.getAllByText(initialProfile.email)).toHaveLength(2);
    expect(screen.getByText(initialProfile.phoneNumber!)).toBeTruthy();
    expect(screen.queryByLabelText('First name')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /sign out|log out/i })).toHaveLength(0);
    for (const [label, route] of [['Edit profile', 'EditProfile'], ['Change password', 'ChangePassword'], ['Delete account', 'DeleteAccount']]) {
      await fireEvent.press(screen.getByRole('button', { name: label }));
      expect(navigate).toHaveBeenLastCalledWith(route);
    }
    expect(logout).not.toHaveBeenCalled();
  });

  it('shows the latest saved identity and optional phone when the owner returns', async () => {
    const screen = await render(tree(ProfileScreen));
    profile = { ...initialProfile, firstName: 'Updated', phoneNumber: null };
    await screen.rerender(tree(ProfileScreen));
    expect(screen.getByText('Updated Reyes')).toBeTruthy();
    expect(screen.queryByText('Nena Reyes')).toBeNull();
    expect(screen.queryByText(initialProfile.phoneNumber!)).toBeNull();
  });
});

describe('More account session actions', () => {
  it('confirms a local sign-out without revoking every device', async () => {
    const screen = await render(tree(MoreScreen));
    await fireEvent.press(screen.getByRole('button', { name: /^Sign out\./ }));
    expect(screen.getByRole('header', { name: 'Sign out of FinSight?' })).toBeTruthy();
    expect(logout).not.toHaveBeenCalled(); expect(logoutEverywhere).not.toHaveBeenCalled();
    let dialog = screen.getByRole('header', { name: 'Sign out of FinSight?' });
    while (!dialog.props.accessibilityViewIsModal && dialog.parent) dialog = dialog.parent;
    expect(dialog.props.accessibilityViewIsModal).toBe(true);
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1); expect(logoutEverywhere).not.toHaveBeenCalled();
  });

  it('offers only local sign-out and dismisses its popup without ending any session', async () => {
    const screen = await render(tree(MoreScreen));
    expect(screen.queryByRole('button', { name: /sign out on all devices|sign out everywhere/i })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /^Sign out\./ }));
    expect(screen.getByRole('header', { name: 'Sign out of FinSight?' })).toBeTruthy();
    expect(logoutEverywhere).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('header', { name: 'Sign out of FinSight?' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Sign out\./ })).not.toBeDisabled();
    expect(logoutEverywhere).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
  });
});

describe('Edit profile', () => {
  it('asks before discarding an unsaved draft and honors keeping the form open', async () => {
    const alert = vi.spyOn(Alert, 'alert');
    const screen = await render(tree(EditProfileScreen));
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Unsaved name');
    expect(preventRemove).toHaveBeenLastCalledWith(true, expect.any(Function));
    const action = { type: 'GO_BACK' };
    const guardedBack = preventRemove.mock.lastCall?.[1] as (event: { data: { action: typeof action } }) => void;
    await act(async () => { guardedBack({ data: { action } }); });
    expect(alert).toHaveBeenCalledWith('Discard changes?', expect.stringContaining('unsaved changes'), expect.any(Array));
    const buttons = alert.mock.calls[0]?.[2];
    await act(async () => { buttons?.find((button) => button.text === 'Keep editing')?.onPress?.(); });
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('First name').props.value).toBe('Unsaved name');
    await act(async () => { buttons?.find((button) => button.text === 'Discard changes')?.onPress?.(); });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(action);
  });

  it('rejects missing names and invalid phone before writing, with field-level reasons', async () => {
    const screen = await render(tree(EditProfileScreen));
    await fireEvent.changeText(screen.getByLabelText('First name'), ' ');
    await fireEvent.changeText(screen.getByLabelText('Last name'), ' ');
    await fireEvent.changeText(screen.getByLabelText('Phone number (optional)'), '012345678901234567890');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText('First name, Enter your first name.')).toBeTruthy();
    expect(screen.getByLabelText('Last name, Enter your last name.')).toBeTruthy();
    expect(screen.getByLabelText(/Phone number \(optional\),/)).toBeTruthy();
    expect(updateProfile).not.toHaveBeenCalled(); expect(goBack).not.toHaveBeenCalled();
  });

  it('keeps rejected values, clears field errors on edit, and retries only on an explicit save', async () => {
    updateProfile.mockRejectedValueOnce(Object.assign(new Error('Profile could not save.'), { fieldErrors: { firstName: 'Name was rejected.' } }));
    const screen = await render(tree(EditProfileScreen));
    await fireEvent.changeText(screen.getByLabelText('First name'), ' New name ');
    await fireEvent.changeText(screen.getByLabelText('Phone number (optional)'), '');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText('First name, Name was rejected.').props.value).toBe(' New name ');
    expect(screen.getByLabelText('Phone number (optional)').props.value).toBe('');
    expect(screen.getByText('Profile could not save.')).toBeTruthy();
    expect(updateProfile).toHaveBeenCalledTimes(1); expect(goBack).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('First name, Name was rejected.'), ' Updated ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateProfile).toHaveBeenLastCalledWith({ firstName: 'Updated', lastName: 'Reyes', phoneNumber: null });
    expect(goBack).toHaveBeenCalledTimes(1);
    await screen.unmount();
    const overview = await render(tree(ProfileScreen));
    expect(overview.getByText('Updated Reyes')).toBeTruthy();
  });

  it('normalizes a pasted phone and serializes save events before a loading render', async () => {
    const pending = deferred(); updateProfile.mockReturnValue(pending.promise);
    const screen = await render(tree(EditProfileScreen));
    await fireEvent.changeText(screen.getByLabelText('Phone number (optional)'), '(0917) 123-4567');
    expect(screen.getByLabelText('Phone number (optional)').props.value).toBe('09171234567');
    const save = pressHandler(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => { void save(); void save(); });
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('First name').props.editable).toBe(false);
    expect(preventRemove).toHaveBeenLastCalledWith(true, expect.any(Function));
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('uploads the chosen photo without overwriting the unsaved profile draft', async () => {
    const pending = deferred<Profile>(); apiUpload.mockReturnValue(pending.promise);
    launchPicker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///synthetic-photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg' }] });
    const screen = await render(tree(EditProfileScreen));
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Unsaved name');
    await act(async () => { void pressHandler(screen.getByRole('button', { name: 'Add Profile photo' }))(); });
    expect(apiUpload).toHaveBeenCalledExactlyOnceWith('/auth/me/avatar', expect.any(FormData));
    expect(screen.getByRole('button', { name: 'Save changes' }).props.accessibilityState.disabled).toBe(true);
    const updated = { ...initialProfile, avatarUrl: 'https://images.example.test/new-avatar.jpg' };
    await act(async () => { pending.resolve(updated); await pending.promise; });
    expect(setProfileFromServer).toHaveBeenCalledExactlyOnceWith(updated);
    await screen.rerender(tree(EditProfileScreen));
    expect(screen.getByLabelText('First name').props.value).toBe('Unsaved name');
    expect(screen.getByRole('button', { name: 'Change Profile photo' })).toBeTruthy();
    expect(updateProfile).not.toHaveBeenCalled();
    await screen.unmount();
    const overview = await render(tree(ProfileScreen));
    expect(overview.getByLabelText('Profile photo').props.source).toEqual({ uri: updated.avatarUrl });
  });

  it('shows a photo upload failure without replacing the profile or losing typed details', async () => {
    launchPicker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///synthetic-photo.jpg' }] });
    apiUpload.mockRejectedValue(new Error('Photo could not upload.'));
    const screen = await render(tree(EditProfileScreen));
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Unsaved name');
    await fireEvent.press(screen.getByRole('button', { name: 'Add Profile photo' }));
    expect(screen.getByText('Photo could not upload.')).toBeTruthy();
    expect(screen.getByLabelText('First name').props.value).toBe('Unsaved name');
    expect(screen.getByRole('button', { name: 'Save changes' }).props.accessibilityState.disabled).toBe(false);
    expect(setProfileFromServer).not.toHaveBeenCalled(); expect(updateProfile).not.toHaveBeenCalled();
  });
});

describe('Change password', () => {
  it('enforces the server minimum of 12 characters in the new form', async () => {
    const screen = await render(tree(ChangePasswordScreen));
    await fillPassword(screen, 'short');
    await fireEvent.press(screen.getByRole('button', { name: 'Update password' }));
    expect(screen.getByLabelText('New password, Use at least 12 characters.')).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
  });

  it('serializes password changes, clears secrets on success, and describes the retained phone session accurately', async () => {
    const pending = deferred(); changePassword.mockReturnValue(pending.promise);
    const screen = await render(tree(ChangePasswordScreen));
    await fillPassword(screen);
    const submit = pressHandler(screen.getByRole('button', { name: 'Update password' }));
    await act(async () => { void submit(); void submit(); });
    expect(changePassword).toHaveBeenCalledExactlyOnceWith('current-password', 'new-password-123');
    expect(screen.getByLabelText('Current password').props.editable).toBe(false);
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(screen.getByLabelText('Current password').props.value).toBe('');
    expect(screen.getByLabelText('New password').props.value).toBe('');
    expect(screen.getByLabelText('Confirm new password').props.value).toBe('');
    expect(goBack).toHaveBeenCalledTimes(1);
    await screen.unmount();
    const overview = await render(tree(ProfileScreen));
    expect(overview.getByText("Password changed. You're still signed in here. Other devices will need to sign in again after their current access expires.")).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();
  });

  it('preserves password input and exposes a server field rejection for correction', async () => {
    changePassword.mockRejectedValue(Object.assign(new Error('Validation failed.'), { fieldErrors: { currentPassword: 'Current password is incorrect.' } }));
    const screen = await render(tree(ChangePasswordScreen));
    await fillPassword(screen);
    await fireEvent.press(screen.getByRole('button', { name: 'Update password' }));
    expect(screen.getByLabelText('Current password, Current password is incorrect.').props.value).toBe('current-password');
    expect(screen.getByLabelText('New password').props.value).toBe('new-password-123');
    expect(logout).not.toHaveBeenCalled(); expect(goBack).not.toHaveBeenCalled();
  });
});

describe('Delete account', () => {
  it('requires the current password and a separate irreversible confirmation', async () => {
    const alert = vi.spyOn(Alert, 'alert');
    const screen = await render(tree(DeleteAccountScreen));
    await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(alert).not.toHaveBeenCalled(); expect(apiDelete).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText(/Current password/), 'current-password');
    await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(alert).toHaveBeenCalledWith('Permanently delete account?', expect.stringContaining('This cannot be undone.'), expect.any(Array), expect.objectContaining({ cancelable: true }));
    expect(apiDelete).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]?.[2];
    expect(buttons?.find((button) => button.text === 'Keep account')?.style).toBe('cancel');
    await act(async () => { buttons?.find((button) => button.text === 'Keep account')?.onPress?.(); });
    expect(apiDelete).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
  });

  it('issues one confirmed deletion and signs out only after the server confirms success', async () => {
    const pending = deferred(); apiDelete.mockReturnValue(pending.promise);
    const alert = vi.spyOn(Alert, 'alert');
    const screen = await render(tree(DeleteAccountScreen));
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'current-password');
    await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
    const confirm = alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Delete everything')?.onPress;
    expect(confirm).toBeTypeOf('function');
    await act(async () => { void confirm?.(); void confirm?.(); });
    expect(apiDelete).toHaveBeenCalledExactlyOnceWith('/auth/me', { currentPassword: 'current-password' });
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Current password').props.editable).toBe(false);
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed deletion recoverable and retains the password without ending the session', async () => {
    apiDelete.mockRejectedValue(new Error('Deletion could not finish.'));
    const alert = vi.spyOn(Alert, 'alert');
    const screen = await render(tree(DeleteAccountScreen));
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'current-password');
    await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
    await act(async () => { await alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Delete everything')?.onPress?.(); });
    expect(screen.getByText('Deletion could not finish.')).toBeTruthy();
    expect(screen.getByLabelText('Current password').props.value).toBe('current-password');
    expect(logout).not.toHaveBeenCalled(); expect(apiDelete).toHaveBeenCalledTimes(1);
  });
});

describe('Account mutation ownership', () => {
  it.each(['profile', 'password', 'deletion'] as const)('suppresses late %s completion after another account becomes active', async (action) => {
    const pending = deferred();
    const alert = vi.spyOn(Alert, 'alert');
    const Component = action === 'profile' ? EditProfileScreen : action === 'password' ? ChangePasswordScreen : DeleteAccountScreen;
    updateProfile.mockReturnValue(pending.promise);
    changePassword.mockReturnValue(pending.promise);
    apiDelete.mockReturnValue(pending.promise);
    const screen = await render(tree(Component));
    if (action === 'password') await fillPassword(screen);
    if (action === 'deletion') {
      await fireEvent.changeText(screen.getByLabelText('Current password'), 'current-password');
      await fireEvent.press(screen.getByRole('button', { name: 'Delete my account' }));
      await act(async () => { void alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Delete everything')?.onPress?.(); });
    } else {
      await act(async () => { void pressHandler(screen.getByRole('button', { name: action === 'profile' ? 'Save changes' : 'Update password' }))(); });
    }
    profile = { ...initialProfile, id: 42, firstName: 'Other owner', email: 'other@example.test' };
    await screen.rerender(tree(Component));
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(goBack).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
    expect(takeFlash()).toBeNull();
  });
});
