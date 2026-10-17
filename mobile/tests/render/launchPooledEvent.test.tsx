import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';

const deferred = vi.hoisted(() => ({ update: null as null | ((value: null) => number) }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const state = actual.useState(initial);
      if (initial !== null) return state;
      return [state[0], (update: unknown) => {
        if (typeof update === 'function') deferred.update = update as (value: null) => number;
        else state[1](update);
      }];
    },
  };
});
vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: () => true }));
const { LaunchScreen } = await import('../../src/components/LaunchScreen');

afterEach(() => { deferred.update = null; vi.restoreAllMocks(); });

it('captures a layout measurement before the native event is released and React evaluates the updater later', async () => {
  const screen = await render(<LaunchScreen fontsReady />);
  const event = { nativeEvent: { layout: { width: 180 } } as null | { layout: { width: number } } };
  await fireEvent(screen.getByRole('header', { name: 'FinSight' }), 'layout', event);
  event.nativeEvent = null;
  expect(deferred.update).toBeTypeOf('function');
  expect(() => deferred.update!(null)).not.toThrow();
  expect(deferred.update!(null)).toBe(180);
});
