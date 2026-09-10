import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { palettes } from '../../src/theme/palette';

const updatePreferences = vi.fn();
const setPreference = vi.fn();
const restart = vi.fn();
const setAlwaysShow = vi.fn();
let hasTour = true;

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    preferences: { showDashboardMascotMessage: true },
    updatePreferences,
  }),
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Unable to save.',
}));

vi.mock('../../src/context/ThemeContext', () => ({
  useTheme: () => palettes.light,
  useThemeControl: () => ({ mode: 'light', preference: 'system', setPreference }),
}));

vi.mock('../../src/context/TourContext', () => ({
  useTourOptional: () => hasTour ? { alwaysShow: false, setAlwaysShow, restart } : null,
}));

const { SettingsScreen } = await import('../../src/screens/SettingsScreen');

async function renderScreen() {
  const navigate = vi.fn();
  const queries = await render(<SettingsScreen navigation={{ navigate }} />);
  return { ...queries, navigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  updatePreferences.mockResolvedValue(undefined);
  setAlwaysShow.mockResolvedValue(undefined);
  hasTour = true;
});

describe('SettingsScreen', () => {
  it('selects the saved system preference even when the phone resolves to light', async () => {
    const screen = await renderScreen();
    expect(screen.getByRole('button', { name: /Auto$/ }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('button', { name: /Light$/ }).props.accessibilityState.selected).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: /Dark$/ }));
    expect(setPreference).toHaveBeenCalledWith('dark');
  });

  it('opens the notification preferences destination', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByRole('button', { name: /^Notification settings/ }));
    expect(screen.navigate).toHaveBeenCalledWith('RecoveryNotificationPreferences');
  });

  it('shows a failed mascot update and permits retry', async () => {
    updatePreferences.mockRejectedValueOnce(new Error('Unable to save your preference.'));
    const screen = await renderScreen();
    await fireEvent.press(screen.getByRole('switch', { name: /^Show Fin/ }));
    expect(updatePreferences).toHaveBeenCalledWith({ showDashboardMascotMessage: false });
    expect(await screen.findByText('Unable to save your preference.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('switch', { name: /^Show Fin/ }));
    expect(updatePreferences).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Unable to save your preference.')).toBeNull();
  });

  it('prevents repeated mascot updates while a save is pending', async () => {
    let finish!: () => void;
    updatePreferences.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const screen = await renderScreen();
    await fireEvent.press(screen.getByRole('switch', { name: /^Show Fin/ }));
    expect(screen.getByRole('switch', { name: /^Show Fin/ }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole('switch', { name: /^Show Fin/ }));
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByRole('switch', { name: /^Show Fin/ }).props.accessibilityState.disabled).toBe(false);
  });

  it('restarts the tour on Home', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByRole('button', { name: /^Restart/ }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(screen.navigate).toHaveBeenCalledWith('Dashboard');
  });

  it('works without a tour provider', async () => {
    hasTour = false;
    const screen = await renderScreen();
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Notification settings/ })).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });
});
