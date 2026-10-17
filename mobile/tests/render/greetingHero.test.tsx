import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { AppState, Image, Platform, type AppStateStatus } from 'react-native';
import { GREETING_FPS, GREETING_REST_FRAME } from '../../src/lib/greetingPlayback';
import { lightPalette } from '../../src/theme/palette';

const state = vi.hoisted(() => ({ focused: true, reduced: false }));
const frames = vi.hoisted(() => Array.from({ length: 103 }, (_, index) => ({ uri: `file:///greeting-${index}.png` })));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }));
vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: () => state.reduced }));
vi.mock('../../src/lib/greetingFrames', () => ({ GREETING_FRAMES: frames }));
vi.mock('../../src/context/AuthContext', () => ({ useAuth: () => ({ profile: { firstName: 'Ken' } }) }));
vi.mock('../../src/context/ThemeContext', () => ({ useTheme: () => lightPalette }));
vi.mock('../../src/components/Skeleton', () => ({ SkeletonBox: () => null }));

const { GreetingHero } = await import('../../src/components/GreetingHero');

const originalResolveAssetSource = Object.getOwnPropertyDescriptor(Image, 'resolveAssetSource');
const originalPrefetch = Object.getOwnPropertyDescriptor(Image, 'prefetch');
const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
let pending: { resolve: (ready: boolean | void) => void; reject: (error: Error) => void }[];
let appListeners: ((state: AppStateStatus) => void)[];
let removes: ReturnType<typeof vi.fn>[];

async function mount() {
  return render(<GreetingHero summary={null} />);
}

function source(queries: Awaited<ReturnType<typeof mount>>) {
  return queries.getByRole('image', { name: "Fin, FinSight's mascot" }).props.source;
}

async function tick(milliseconds = 1000 / GREETING_FPS + 1) {
  await act(async () => { vi.advanceTimersByTime(milliseconds); });
}

async function finishLoading() {
  await act(async () => { pending.forEach(({ resolve }) => resolve(true)); });
}

beforeEach(() => {
  state.focused = true;
  state.reduced = false;
  pending = [];
  appListeners = [];
  removes = [];
  vi.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    appListeners.push(listener);
    const remove = vi.fn();
    removes.push(remove);
    return { remove };
  });
  Object.defineProperty(Image, 'resolveAssetSource', { configurable: true, writable: true, value: vi.fn((asset) => asset) });
  Object.defineProperty(Image, 'prefetch', {
    configurable: true, writable: true,
    value: vi.fn(() => new Promise<boolean | void>((resolve, reject) => pending.push({ resolve, reject }))),
  });
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', originalPlatform);
  if (originalResolveAssetSource) Object.defineProperty(Image, 'resolveAssetSource', originalResolveAssetSource);
  else delete (Image as unknown as Record<string, unknown>).resolveAssetSource;
  if (originalPrefetch) Object.defineProperty(Image, 'prefetch', originalPrefetch);
  else delete (Image as unknown as Record<string, unknown>).prefetch;
  vi.useRealTimers();
});

describe('dashboard greeting playback', () => {
  it('holds the rest pose until the complete cold sequence is ready', async () => {
    const q = await mount();
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME]);
    expect(pending).toHaveLength(frames.length);
    await act(async () => { pending.slice(0, -1).forEach(({ resolve }) => resolve(true)); });
    await tick(2000);
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME]);
    await finishLoading();
    await tick();
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME + 1]);
  });

  it('plays web asset descriptors after successful prefetch resolves without a value', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    delete (Image as unknown as Record<string, unknown>).resolveAssetSource;
    const q = await mount();
    expect(pending).toHaveLength(frames.length);
    await act(async () => { pending.forEach(({ resolve }) => resolve()); });
    await tick();
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME + 1]);
  });

  it.each(['rejects', 'returns false'])('keeps the static mascot when prefetch %s', async (failure) => {
    const q = await mount();
    await act(async () => {
      if (failure === 'rejects') pending[0]!.reject(new Error('frame unavailable'));
      else pending[0]!.resolve(false);
      pending.slice(1).forEach(({ resolve }) => resolve(true));
    });
    await tick(2000);
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME]);
  });

  it('does not start playback when pending loads finish after unmount', async () => {
    const q = await mount();
    await q.unmount();
    await finishLoading();
    expect(vi.getTimerCount()).toBe(0);
    expect(removes).toHaveLength(1);
    expect(removes.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  });

  it('stops on the rest pose if the displayed animation frame fails', async () => {
    const q = await mount();
    await finishLoading();
    await tick();
    await fireEvent(q.getByRole('image', { name: "Fin, FinSight's mascot" }), 'error', {
      nativeEvent: { error: 'Unable to decode animation frame' },
    });
    await tick(2000);
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME]);
  });

  it('pauses off-tab and resumes from the displayed frame', async () => {
    const q = await mount();
    await finishLoading();
    await tick();
    const paused = source(q);
    state.focused = false;
    await q.rerender(<GreetingHero summary={null} />);
    await tick(2000);
    expect(source(q)).toEqual(paused);
    state.focused = true;
    await q.rerender(<GreetingHero summary={null} />);
    await tick();
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME + 2]);
  });

  it('pauses in background and removes its listener and timer on unmount', async () => {
    const q = await mount();
    await finishLoading();
    await tick();
    const paused = source(q);
    await act(async () => { appListeners.forEach((listener) => listener('background')); });
    await tick(2000);
    expect(source(q)).toEqual(paused);
    await act(async () => { appListeners.forEach((listener) => listener('active')); });
    await tick();
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME + 2]);
    await q.unmount();
    expect(removes).toHaveLength(1);
    expect(removes.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not preload or move when reduced motion is enabled', async () => {
    state.reduced = true;
    const q = await mount();
    expect(pending).toHaveLength(0);
    await tick(2000);
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME]);
  });

  it('stops playback on a live reduced-motion change', async () => {
    const q = await mount();
    await finishLoading();
    await tick();
    state.reduced = true;
    await q.rerender(<GreetingHero summary={null} />);
    await tick(2000);
    expect(source(q)).toEqual(frames[GREETING_REST_FRAME]);
  });
});
