import React from 'react';
import { AccessibilityInfo, Animated, BackHandler, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { TourContext, type TourContextValue } from '../../src/context/tourContextValue';
import { TOUR_STEPS } from '../../src/components/tour/steps';
import type { TourRect } from '../../src/components/tour/geometry';

const measure = vi.fn();
const reveal = vi.fn();
const next = vi.fn();
const back = vi.fn();
const stop = vi.fn();
const skipUnavailable = vi.fn();
const removeBack = vi.fn();
let reducedMotion = true;

vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: () => reducedMotion }));
vi.mock('../../src/components/tour/targets', () => ({
  measureTourTarget: (...args: unknown[]) => measure(...args),
  revealTourTarget: (...args: unknown[]) => reveal(...args),
  stepIsOnScreen: () => true,
  tourTargetOptions: () => undefined,
}));
const { TourOverlay } = await import('../../src/components/tour/TourOverlay');
const rect: TourRect = { x: 24, y: 130, width: 100, height: 48 };
const value = (stepIndex: number, overrides: Partial<TourContextValue> = {}): TourContextValue => ({
  active: true, stepIndex, activeStepId: TOUR_STEPS[stepIndex]!.id,
  next, back, stop, skipUnavailable, unavailableStepIds: [], restart: vi.fn(), alwaysShow: false,
  setAlwaysShow: vi.fn().mockResolvedValue(undefined), reportHomeStage: vi.fn(), ...overrides,
});
const tree = (stepIndex = 0, overrides: Partial<TourContextValue> = {}) => <ThemeProvider initialMode="light">
  <TourContext.Provider value={value(stepIndex, overrides)}><TourOverlay /></TourContext.Provider>
</ThemeProvider>;
type Queries = Awaited<ReturnType<typeof render>>;
type NativeMeasure = (callback: (x: number, y: number, width: number, height: number) => void) => void;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function rootMeasure(queries: Queries) {
  let fiber = queries.getByLabelText('Product tour').unstable_fiber;
  while (fiber && typeof fiber.stateNode?.measureInWindow !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('No native measurement ref for tour root');
  return vi.spyOn(fiber.stateNode as { measureInWindow: NativeMeasure }, 'measureInWindow');
}
async function layout(queries: Queries, width = 390, height = 844) {
  rootMeasure(queries).mockImplementation((callback) => callback(0, 0, width, height));
  let card = queries.getByRole('header');
  while (!card.props.onLayout && card.parent) card = card.parent;
  if (card.props.onLayout) await fireEvent(card, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 300 } } });
  await fireEvent(queries.getByLabelText('Product tour'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } });
}
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
const forward = (queries: Queries, disabled = false) => queries.getByRole('button', { name: /^(Next|Start tour|Finish)$/, disabled });
function pressHandler(node: ReturnType<Queries['getByRole']>) {
  let fiber = node.unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('No press handler for tour control');
  return fiber.memoizedProps.onPress as () => void;
}
function cardMaxHeight(queries: Queries): number {
  let node = queries.getByRole('header');
  while (node.parent) {
    node = node.parent;
    const style = StyleSheet.flatten(node.props.style);
    if (typeof style?.maxHeight === 'number') return style.maxHeight;
  }
  throw new Error('Tour card has no bounded scrolling container');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  reducedMotion = true;
  for (const spy of [measure, reveal, next, back, stop, skipUnavailable, removeBack]) spy.mockReset();
  measure.mockResolvedValue(rect);
  reveal.mockResolvedValue(false);
  vi.spyOn(BackHandler, 'addEventListener').mockReturnValue({ remove: removeBack });
});
afterEach(async () => { await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tour overlay presentation and measurement', () => {
  it('waits for consecutive stable target samples before enabling navigation and announcing a step', async () => {
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');
    measure.mockResolvedValueOnce({ ...rect, x: 100 }).mockResolvedValueOnce({ ...rect, x: 60 }).mockResolvedValue(rect);
    const queries = await render(tree(1));
    await layout(queries);
    expect(forward(queries, true)).toBeTruthy();
    expect(announce).not.toHaveBeenCalled();
    await advance(90);
    expect(forward(queries, true)).toBeTruthy();
    await advance(90);
    expect(forward(queries, true)).toBeTruthy();
    await advance(90);
    expect(forward(queries)).toBeTruthy();
    expect(measure).toHaveBeenCalledTimes(4);
    await advance(0);
    expect(announce).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(TOUR_STEPS[1]!.title));
  });

  it('retains the previous card while a new target resolves and rejects a superseded sample', async () => {
    const oldSample = deferred<TourRect | null>();
    const newSample = deferred<TourRect | null>();
    measure.mockImplementation((key: string) => key === 'business-switcher' ? oldSample.promise : newSample.promise);
    const queries = await render(tree(0));
    await layout(queries);
    await queries.rerender(tree(1));
    expect(queries.getByRole('header').props.accessibilityLabel).toContain(TOUR_STEPS[0]!.title);
    await queries.rerender(tree(2));
    await act(async () => { oldSample.resolve(rect); await oldSample.promise; });
    expect(forward(queries, true)).toBeTruthy();
    expect(queries.getByRole('header').props.accessibilityLabel).toContain(TOUR_STEPS[0]!.title);
    await act(async () => { newSample.resolve(rect); await newSample.promise; });
    await advance(100);
    expect(queries.getByRole('header').props.accessibilityLabel).toContain(TOUR_STEPS[2]!.title);
    expect(forward(queries)).toBeTruthy();
    expect(skipUnavailable).not.toHaveBeenCalled();
  });

  it('does not restart target reveal when action callback identities change', async () => {
    const sample = deferred<TourRect | null>();
    measure.mockReturnValue(sample.promise);
    const queries = await render(tree(1));
    await layout(queries);
    expect(reveal).toHaveBeenCalledTimes(1);
    await queries.rerender(tree(1, { next: vi.fn(), back: vi.fn() }));
    expect(reveal).toHaveBeenCalledTimes(1);
    await act(async () => { sample.resolve(rect); await sample.promise; });
    await advance(100);
    expect(forward(queries)).toBeTruthy();
  });

  it('serializes repeated same-frame Next and Back presses', async () => {
    const queries = await render(tree());
    await layout(queries);
    const goNext = pressHandler(forward(queries));
    await act(async () => { goNext(); goNext(); });
    expect(next).toHaveBeenCalledTimes(1);
    await queries.rerender(tree(1));
    await advance(100);
    const goBack = pressHandler(queries.getByRole('button', { name: 'Back' }));
    await act(async () => { goBack(); goBack(); });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('skips an unmeasurable target forward within a bounded wait while keeping Close available', async () => {
    measure.mockResolvedValue(null);
    const queries = await render(tree(2));
    await layout(queries);
    expect(forward(queries, true)).toBeTruthy();
    await advance(2500);
    expect(skipUnavailable).toHaveBeenCalledExactlyOnceWith('next');
    await fireEvent.press(queries.getByRole('button', { name: 'Close the tour' }));
    expect(stop).toHaveBeenCalledExactlyOnceWith('skipped');
  });

  it('skips a missing target backward after the owner pressed Back', async () => {
    const queries = await render(tree(3));
    await layout(queries);
    await advance(100);
    await fireEvent.press(queries.getByRole('button', { name: 'Back' }));
    measure.mockResolvedValue(null);
    await queries.rerender(tree(2));
    await advance(2500);
    expect(skipUnavailable).toHaveBeenCalledExactlyOnceWith('back');
  });

  it('disables animated scroll, fading and card movement when reduced motion is requested', async () => {
    const animate = vi.spyOn(Animated, 'timing');
    const queries = await render(tree(1));
    await layout(queries);
    await advance(100);
    expect(animate).not.toHaveBeenCalled();
    expect(reveal.mock.calls[0]?.[2].animated).toBe(false);
    expect(forward(queries)).toBeTruthy();
  });

  it('bounds scrollable instructions when the viewport becomes shorter during a pending reveal', async () => {
    const pending = deferred<TourRect | null>();
    measure.mockReturnValue(pending.promise);
    const queries = await render(tree(1));
    await layout(queries, 320, 568);
    const portraitHeight = cardMaxHeight(queries);
    expect(portraitHeight).toBeGreaterThan(0);
    expect(portraitHeight).toBeLessThanOrEqual(490);
    await layout(queries, 568, 320);
    const landscapeHeight = cardMaxHeight(queries);
    expect(landscapeHeight).toBeGreaterThan(0);
    expect(landscapeHeight).toBeLessThan(portraitHeight);
    expect(landscapeHeight).toBeLessThanOrEqual(242);
    expect(queries.getByRole('button', { name: 'Close the tour' })).toBeTruthy();
  });

  it('cancels reveal work, queued announcements and hardware-back subscriptions on unmount', async () => {
    const sample = deferred<TourRect | null>();
    measure.mockReturnValue(sample.promise);
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const queries = await render(tree(1));
    await layout(queries);
    const signal = reveal.mock.calls[0]?.[2].signal as AbortSignal;
    await queries.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { sample.resolve(rect); await sample.promise; await vi.advanceTimersByTimeAsync(3000); });
    expect(skipUnavailable).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(removeBack).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
