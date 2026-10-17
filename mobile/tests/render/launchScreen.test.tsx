import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Animated } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { LaunchScreen, MIN_SHOW_MS } from '../../src/components/LaunchScreen';
import { useReducedMotion } from '../../src/lib/useReducedMotion';

vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: vi.fn(() => false) }));

function useLaunchTimers() {
  // RN StatusBar schedules its native stack with setImmediate. Keep that
  // queue live while controlling only the launch animation and release timers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

describe('Launch screen', () => {
  it('waits for fonts before exposing branded text and loading feedback', async () => {
    const queries = await render(<LaunchScreen fontsReady={false} />);

    expect(queries.queryByText('FinSight')).toBeNull();
    expect(queries.queryByText('A clearer view of your business.')).toBeNull();
    expect(queries.queryByText('Opening your workspace…')).toBeNull();
    expect(queries.queryByRole('progressbar')).toBeNull();

    await queries.rerender(<LaunchScreen fontsReady />);

    expect(queries.getByRole('header', { name: 'FinSight' })).toBeTruthy();
    expect(queries.getByText('A clearer view of your business.')).toBeTruthy();
    expect(queries.getByText('Opening your workspace…')).toBeTruthy();
    const progress = queries.getByRole('progressbar', { name: 'Opening FinSight' });
    expect(progress).toHaveProp('accessibilityState', { busy: true });
  });

  it('stays up for the minimum time, and lets the app in by the cap even if the sequence never runs', async () => {
    useLaunchTimers();
    const onFinished = vi.fn();
    // No layout events in this renderer, so the name is never measured and
    // the sequence never starts: exactly the case the cap exists for.
    const queries = await render(<LaunchScreen fontsReady={false} onFinished={onFinished} />);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(onFinished).not.toHaveBeenCalled();

    await queries.rerender(<LaunchScreen fontsReady onFinished={onFinished} />);
    await act(async () => { vi.advanceTimersByTime(MIN_SHOW_MS); });
    // Minimum is up, but the sequence has not finished: still waiting.
    expect(onFinished).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(onFinished).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('waits for the minimum after the normal sequence completes and uses the latest callback once', async () => {
    useLaunchTimers();
    vi.spyOn(Animated, 'timing').mockImplementation(() => ({
      start: (callback) => callback?.({ finished: true }),
      stop: vi.fn(),
      reset: vi.fn(),
    }));
    vi.spyOn(Animated, 'loop').mockReturnValue({ start: vi.fn(), stop: vi.fn(), reset: vi.fn() });
    const original = vi.fn();
    const latest = vi.fn();
    const queries = await render(<LaunchScreen fontsReady onFinished={original} />);
    await fireEvent(queries.getByRole('header'), 'layout', { nativeEvent: { layout: { width: 180 } } });
    for (let letter = 0; letter < 'FinSight'.length; letter++) {
      await act(async () => { vi.advanceTimersByTime(70); });
    }
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(original).not.toHaveBeenCalled();

    await queries.rerender(<LaunchScreen fontsReady onFinished={latest} />);
    await act(async () => { vi.advanceTimersByTime(MIN_SHOW_MS - 861); });
    expect(latest).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('completes the reduced-motion layout without animations and still holds for the minimum', async () => {
    useLaunchTimers();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const timing = vi.spyOn(Animated, 'timing');
    const loop = vi.spyOn(Animated, 'loop');
    const onFinished = vi.fn();
    const queries = await render(<LaunchScreen fontsReady onFinished={onFinished} />);
    await fireEvent(queries.getByRole('header'), 'layout', { nativeEvent: { layout: { width: 180 } } });
    expect(timing).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(MIN_SHOW_MS - 1); });
    expect(onFinished).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(onFinished).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('cancels the completion timers when unmounted before the minimum', async () => {
    useLaunchTimers();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const onFinished = vi.fn();
    const queries = await render(<LaunchScreen fontsReady onFinished={onFinished} />);
    await fireEvent(queries.getByRole('header'), 'layout', { nativeEvent: { layout: { width: 180 } } });
    await act(async () => { vi.advanceTimersByTime(MIN_SHOW_MS - 1); });
    await queries.unmount();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(onFinished).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useReducedMotion).mockReturnValue(false);
  vi.useRealTimers();
});
