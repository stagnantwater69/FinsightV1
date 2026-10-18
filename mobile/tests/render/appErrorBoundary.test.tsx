import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { AppErrorBoundary } from '../../src/components/AppErrorBoundary';

let shouldThrow = true;
let mounts = 0;

function Flaky() {
  React.useEffect(() => {
    mounts += 1;
  }, []);
  if (shouldThrow) throw new Error("expense 412 'Team lunch' failed");
  return <Text>Records</Text>;
}

function renderBoundary() {
  return render(
    <ThemeProvider>
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>
    </ThemeProvider>,
  );
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true;
    mounts = 0;
    // React and the boundary both log the caught error; keep the run quiet.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
    vi.restoreAllMocks();
  });

  it('shows a recovery screen instead of an empty tree', async () => {
    const screen = await renderBoundary();

    expect(await screen.findByRole('header', { name: 'Something broke on this screen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('keeps the error message off screen in a release build', async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
    const screen = await renderBoundary();

    await screen.findByRole('header', { name: 'Something broke on this screen' });
    expect(screen.queryByText(/Team lunch/)).toBeNull();
  });

  it('shows the message in development', async () => {
    const screen = await renderBoundary();

    expect(await screen.findByText(/Team lunch/)).toBeTruthy();
  });

  it('mounts the tree again on Try again', async () => {
    const screen = await renderBoundary();
    await screen.findByRole('button', { name: 'Try again' });

    shouldThrow = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Records')).toBeTruthy();
    expect(mounts).toBe(1);
  });
});
