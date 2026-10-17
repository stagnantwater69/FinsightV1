import React from 'react';
import { ScrollView, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import {
  hasTourTarget, measureTourTarget, resetTourTargets, revealTourTarget, useTourScrollView, useTourTarget,
} from '../../src/components/tour/targets';

const viewport = { viewportTop: 60, viewportBottom: 500, preferredTop: 140 };
function Target({ name }: { name: string }) {
  return <View {...useTourTarget('dashboard-summary', { scrolls: true })} accessible accessibilityLabel={`Target ${name}`} />;
}
function Page({ name }: { name: string }) {
  return <ScrollView {...useTourScrollView()} accessibilityLabel={`Tour page ${name}`}><Target name={name} /></ScrollView>;
}
const tree = (name = 'A') => <Page key={name} name={name} />;
type Queries = Awaited<ReturnType<typeof render>>;
type Measure = (callback: (x: number, y: number, width: number, height: number) => void) => void;

function targetNode(queries: Queries, name = 'A') {
  let fiber = queries.getByLabelText(`Target ${name}`).unstable_fiber;
  while (fiber && typeof fiber.stateNode?.measureInWindow !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('No native measurement ref for tour target');
  return fiber.stateNode as { measureInWindow: Measure };
}
function pageNode(queries: Queries, name = 'A') {
  let fiber = queries.getByLabelText(`Tour page ${name}`).unstable_fiber;
  while (fiber && typeof fiber.stateNode?.scrollTo !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('No native scroll ref for tour page');
  return fiber.stateNode as { scrollTo: (options: { y: number; animated: boolean }) => void };
}
function measurable(queries: Queries) {
  vi.spyOn(targetNode(queries), 'measureInWindow').mockImplementation((callback) => callback(16, 700, 100, 120));
  return vi.spyOn(pageNode(queries), 'scrollTo');
}

beforeEach(() => { resetTourTargets(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(async () => { await cleanup(); resetTourTargets(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tour target measurement and reveal lifecycle', () => {
  it('resolves an unresponsive native measurement and ignores its late callback', async () => {
    const queries = await render(tree());
    let finish!: Parameters<Measure>[0];
    vi.spyOn(targetNode(queries), 'measureInWindow').mockImplementation((callback) => { finish = callback; });
    const result = measureTourTarget('dashboard-summary');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await result).toBeNull();
    finish(16, 700, 100, 120);
    expect(await result).toBeNull();
  });

  it.each([{ width: Number.POSITIVE_INFINITY, height: 120 }, { width: 100, height: Number.POSITIVE_INFINITY }])(
    'rejects nonfinite native dimensions %j', async ({ width, height }) => {
      const queries = await render(tree());
      vi.spyOn(targetNode(queries), 'measureInWindow').mockImplementation((callback) => callback(16, 700, width, height));
      expect(await measureTourTarget('dashboard-summary')).toBeNull();
    },
  );

  it('cancels a native measurement immediately without leaving its fallback timer', async () => {
    const queries = await render(tree());
    let finish!: Parameters<Measure>[0];
    vi.spyOn(targetNode(queries), 'measureInWindow').mockImplementation((callback) => { finish = callback; });
    const controller = new AbortController();
    const result = measureTourTarget('dashboard-summary', controller.signal);
    controller.abort();
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    finish(16, 700, 100, 120);
    expect(await result).toBeNull();
  });

  it('rejects a measurement from a replaced registration while retaining the new target', async () => {
    const queries = await render(tree());
    let finish!: Parameters<Measure>[0];
    vi.spyOn(targetNode(queries), 'measureInWindow').mockImplementation((callback) => { finish = callback; });
    const result = measureTourTarget('dashboard-summary');
    await queries.rerender(tree('B'));
    finish(16, 700, 100, 120);
    expect(await result).toBeNull();
    expect(hasTourTarget('dashboard-summary')).toBe(true);
  });

  it('does not use an old reveal measurement to scroll a replacement page', async () => {
    const queries = await render(tree());
    let finish!: Parameters<Measure>[0];
    vi.spyOn(targetNode(queries), 'measureInWindow').mockImplementation((callback) => { finish = callback; });
    const result = revealTourTarget('dashboard-summary', viewport);
    await queries.rerender(tree('B'));
    const scrollNewPage = vi.spyOn(pageNode(queries, 'B'), 'scrollTo');
    finish(16, 700, 100, 120);
    expect(await result).toBe(false);
    expect(scrollNewPage).not.toHaveBeenCalled();
  });

  it('waits for observed scrolling to settle before allowing measurement to continue', async () => {
    const queries = await render(tree());
    const scroll = measurable(queries);
    let settled = false;
    const result = revealTourTarget('dashboard-summary', viewport).then((value) => { settled = true; return value; });
    await act(async () => { await Promise.resolve(); });
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ y: 560, animated: true });
    expect(settled).toBe(false);
    await fireEvent.scroll(queries.getByLabelText('Tour page A'), { nativeEvent: { contentOffset: { x: 0, y: 200 } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    await fireEvent.scroll(queries.getByLabelText('Tour page A'), { nativeEvent: { contentOffset: { x: 0, y: 300 } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    expect(settled).toBe(false);
    await fireEvent(queries.getByLabelText('Tour page A'), 'momentumScrollEnd');
    expect(await result).toBe(true);
  });

  it('supports a nonanimated reveal for reduced motion', async () => {
    const queries = await render(tree());
    const scroll = measurable(queries);
    const result = revealTourTarget('dashboard-summary', viewport, { animated: false });
    await act(async () => { await Promise.resolve(); });
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ y: 560, animated: false });
    await fireEvent(queries.getByLabelText('Tour page A'), 'momentumScrollEnd');
    expect(await result).toBe(true);
  });

  it('cancels a superseded reveal without leaving its timer or motion running', async () => {
    const queries = await render(tree());
    const scroll = measurable(queries);
    const controller = new AbortController();
    const result = revealTourTarget('dashboard-summary', viewport, { signal: controller.signal });
    await act(async () => { await Promise.resolve(); });
    await fireEvent.scroll(queries.getByLabelText('Tour page A'), { nativeEvent: { contentOffset: { x: 0, y: 200 } } });
    controller.abort();
    expect(await result).toBe(false);
    expect(scroll).toHaveBeenLastCalledWith({ y: 200, animated: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves pending reveals and removes target registrations on unmount', async () => {
    const queries = await render(tree());
    measurable(queries);
    const result = revealTourTarget('dashboard-summary', viewport);
    await act(async () => { await Promise.resolve(); });
    await queries.unmount();
    expect(await result).toBe(false);
    expect(hasTourTarget('dashboard-summary')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
