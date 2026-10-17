import React from 'react';
import { AppState, Text, type AppStateStatus } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react-native';
import type { BusinessProfile, UserPreferences } from '../../src/lib/types';
import type { StoredTour } from '../../src/lib/tourStorage';
import type { TourContextValue } from '../../src/context/tourContextValue';
import * as fixtures from './support/fixtures';

const readTour = vi.fn();
const writeTour = vi.fn();
const updatePreferences = vi.fn();
let userId: number | null = 1;
let selected: BusinessProfile | null = fixtures.businessProfile;
let preferencesLoaded = true;
let profilesLoading = false;
let preferences: UserPreferences;
let tour: TourContextValue;
let appStateChange: ((state: AppStateStatus) => void) | null = null;
const removeAppState = vi.fn();
const originalAppState = Object.getOwnPropertyDescriptor(AppState, 'currentState')!;

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ profile: userId === null ? null : { id: userId }, preferences, preferencesLoaded, updatePreferences }),
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({ useBusinessProfiles: () => ({ selected, loading: profilesLoading }) }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }));
vi.mock('../../src/lib/tourStorage', async (original) => ({
  ...await original<typeof import('../../src/lib/tourStorage')>(),
  readTour: (...args: unknown[]) => readTour(...args),
  writeTour: (...args: unknown[]) => writeTour(...args),
}));
vi.mock('../../src/components/tour/targets', () => ({ stepIsOnScreen: () => true }));
vi.mock('../../src/components/tour/TourOverlay', async () => {
  const { useTourOptional } = await import('../../src/context/tourContextValue');
  return { TourOverlay: () => <Text>Tour card: {useTourOptional()?.activeStepId}</Text> };
});

const { TourProvider, useTourOptional } = await import('../../src/context/TourContext');
const { BusinessNavigationBoundary } = await import('../../src/components/BusinessNavigationBoundary');

function Probe() {
  tour = useTourOptional()!;
  return <Text>Business page</Text>;
}
const tree = (withBusinessBoundary = false) => {
  const content = <TourProvider><Probe /></TourProvider>;
  return withBusinessBoundary ? <BusinessNavigationBoundary businessProfileId={selected?.id ?? null}>{content}</BusinessNavigationBoundary> : content;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function home(onHomeTab = true, dashboardLoaded = true) {
  await act(async () => { tour.reportHomeStage({ onHomeTab, dashboardLoaded }); });
}

beforeEach(() => {
  userId = 1;
  selected = fixtures.businessProfile;
  preferencesLoaded = true;
  profilesLoading = false;
  preferences = { showDashboardMascotMessage: true, tourStatus: 'not_started', tourStep: 0, tourAlwaysShow: false };
  readTour.mockReset().mockResolvedValue({ status: 'not_started' });
  writeTour.mockReset().mockResolvedValue(undefined);
  updatePreferences.mockReset().mockResolvedValue(preferences);
  removeAppState.mockReset();
  appStateChange = null;
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    appStateChange = listener;
    return { remove: removeAppState };
  });
});
afterEach(async () => {
  await cleanup();
  Object.defineProperty(AppState, 'currentState', originalAppState);
  vi.restoreAllMocks();
});

describe('tour provider progress and ownership', () => {
  it('waits for cache reconciliation, account preferences and the loaded Home page before opening', async () => {
    const cache = deferred<StoredTour>();
    readTour.mockReturnValueOnce(cache.promise);
    preferencesLoaded = false;
    const queries = await render(tree());
    await home();
    expect(tour.active).toBe(false);
    await act(async () => { cache.resolve({ status: 'not_started' }); await cache.promise; });
    expect(tour.active).toBe(false);
    preferencesLoaded = true;
    await queries.rerender(tree());
    await home(true, false);
    expect(tour.active).toBe(false);
    await home();
    expect(tour.activeStepId).toBe('welcome');
    expect(queries.getByText('Tour card: welcome')).toBeTruthy();
  });

  it.each(['completed', 'skipped'] as const)('honors a server %s status even when this device has no progress', async (status) => {
    preferences = { ...preferences, tourStatus: status, tourStep: 11 };
    await render(tree());
    await home();
    expect(tour.active).toBe(false);
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(writeTour).toHaveBeenLastCalledWith(1, expect.objectContaining({ status, step: 11 }));
  });

  it('advances and returns only one step for repeated same-frame navigation calls', async () => {
    await render(tree());
    await home();
    await act(async () => { tour.next(); tour.next(); });
    expect(tour.activeStepId).toBe('business-profile');
    await act(async () => { tour.back(); tour.back(); });
    expect(tour.activeStepId).toBe('welcome');
  });

  it('resumes the current step after leaving Home, without reactivating a stopped tour', async () => {
    await render(tree());
    await home();
    await act(async () => { tour.next(); });
    await act(async () => { tour.next(); });
    expect(tour.activeStepId).toBe('dashboard');
    await home(false, false);
    expect(tour.active).toBe(false);
    await home();
    expect(tour.activeStepId).toBe('dashboard');
    await act(async () => { tour.stop('skipped'); });
    await home(false, false);
    await home();
    expect(tour.active).toBe(false);
  });

  it('pauses backgrounded tours and resumes at the same step when the app becomes active', async () => {
    await render(tree());
    await home();
    await act(async () => { tour.next(); });
    expect(appStateChange).toBeTypeOf('function');
    await act(async () => { appStateChange?.('background'); });
    expect(tour.active).toBe(false);
    await act(async () => { appStateChange?.('active'); });
    expect(tour.activeStepId).toBe('business-profile');
  });

  it('runs always-show once per activation and allows an explicit restart', async () => {
    preferences = { ...preferences, tourStatus: 'completed', tourStep: 11, tourAlwaysShow: true };
    await render(tree());
    await home();
    expect(tour.activeStepId).toBe('welcome');
    await act(async () => { tour.stop('completed'); });
    await home(false, false);
    await home();
    expect(tour.active).toBe(false);
    await act(async () => { tour.restart(); });
    expect(tour.activeStepId).toBe('welcome');
    expect(tour.alwaysShow).toBe(true);
  });

  it('skips unavailable targets in either direction for this run and resets exclusions on restart', async () => {
    await render(tree());
    await home();
    await act(async () => { tour.next(); });
    expect(tour.activeStepId).toBe('business-profile');
    expect(tour.skipUnavailable).toBeTypeOf('function');
    await act(async () => { tour.skipUnavailable?.('next'); tour.skipUnavailable?.('next'); });
    expect(tour.activeStepId).toBe('dashboard');
    expect(tour.unavailableStepIds).toEqual(['business-profile']);
    expect(writeTour).toHaveBeenLastCalledWith(1, expect.objectContaining({ status: 'in_progress', step: 2 }));
    await act(async () => { tour.skipUnavailable?.('back'); });
    expect(tour.activeStepId).toBe('welcome');
    expect(tour.unavailableStepIds).toEqual(['business-profile', 'dashboard']);
    await act(async () => { tour.restart(); });
    expect(tour.activeStepId).toBe('welcome');
    expect(tour.unavailableStepIds).toEqual([]);
  });

  it('discards a delayed cache read from a previous signed-in account', async () => {
    const oldCache = deferred<StoredTour>();
    readTour.mockReturnValueOnce(oldCache.promise).mockResolvedValueOnce({ status: 'completed', step: 11 });
    const queries = await render(tree());
    userId = 2;
    preferences = { ...preferences, tourStatus: 'completed', tourStep: 11 };
    await queries.rerender(tree());
    await act(async () => { oldCache.resolve({ status: 'not_started', alwaysShow: true }); await oldCache.promise; });
    await home();
    expect(tour.active).toBe(false);
    expect(tour.alwaysShow).toBe(false);
    expect(writeTour.mock.calls.filter(([id]) => id === 2).every(([, value]) => value.status === 'completed')).toBe(true);
  });

  it('ignores actions captured by an outgoing business boundary', async () => {
    const queries = await render(tree(true));
    await home();
    const oldTour = tour;
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await queries.rerender(tree(true));
    writeTour.mockClear();
    updatePreferences.mockClear();
    await act(async () => {
      oldTour.stop('skipped');
      oldTour.restart();
      await oldTour.setAlwaysShow(true);
    });
    expect(writeTour).not.toHaveBeenCalled();
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(tour.alwaysShow).toBe(false);
    expect(tour.active).toBe(false);
  });

  it('rejects old run controls after switching away from and back to the same business', async () => {
    const queries = await render(tree());
    await home();
    await act(async () => { tour.next(); });
    const oldTour = tour;
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await queries.rerender(tree());
    await home(false, false);
    selected = fixtures.businessProfile;
    await queries.rerender(tree());
    await home();
    writeTour.mockClear();
    updatePreferences.mockClear();
    await act(async () => { oldTour.next(); oldTour.back(); oldTour.stop('skipped'); oldTour.restart(); });
    expect(tour.activeStepId).toBe('business-profile');
    expect(tour.active).toBe(true);
    expect(writeTour).not.toHaveBeenCalled();
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('does not roll an old preference failure back over the next account', async () => {
    const pending = deferred<UserPreferences>();
    updatePreferences.mockReturnValueOnce(pending.promise);
    const queries = await render(tree());
    let save!: Promise<void>;
    await act(async () => { save = tour.setAlwaysShow(true); });
    expect(tour.alwaysShow).toBe(true);
    userId = 2;
    preferences = { ...preferences, tourStatus: 'completed', tourStep: 11, tourAlwaysShow: true };
    await queries.rerender(tree());
    writeTour.mockClear();
    await act(async () => {
      pending.reject(new Error('Old account preference failed'));
      await save.catch(() => undefined);
    });
    expect(tour.alwaysShow).toBe(true);
    expect(writeTour.mock.calls.some(([id, value]) => id === 2 && value.alwaysShow !== true)).toBe(false);
  });

  it('rolls back a failed current-account preference and removes its lifecycle listener on unmount', async () => {
    updatePreferences.mockRejectedValueOnce(new Error('Preference rejected'));
    const queries = await render(tree());
    let error: unknown;
    await act(async () => { try { await tour.setAlwaysShow(true); } catch (caught) { error = caught; } });
    expect(error).toEqual(new Error('Preference rejected'));
    expect(tour.alwaysShow).toBe(false);
    expect(writeTour).toHaveBeenLastCalledWith(1, expect.objectContaining({ alwaysShow: undefined }));
    await queries.unmount();
    expect(removeAppState).toHaveBeenCalledTimes(1);
  });
});
