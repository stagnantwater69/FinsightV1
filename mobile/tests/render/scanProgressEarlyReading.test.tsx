import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ScanProgress } from '../../src/screens/records/scanReceipt/ScanProgress';

function tree(earlyReading: React.ComponentProps<typeof ScanProgress>['earlyReading']) {
  return (
    <ThemeProvider initialMode="light">
      <ScanProgress phase="Reading receipt…" earlyReading={earlyReading} onStop={vi.fn()} />
    </ThemeProvider>
  );
}

describe('scan progress early reading', () => {
  afterEach(async () => { await cleanup(); });

  it("shows the photo's early reading as provisional, keeping only the stop control", async () => {
    const screen = await render(tree({ date: '2026-09-01', vendor: 'LOCAL STORE', amount: 1250.5 }));

    expect(screen.getByRole('header', { name: 'Read from your photo so far' })).toBeTruthy();
    expect(screen.getByText('LOCAL STORE')).toBeTruthy();
    expect(screen.getByText('2026-09-01')).toBeTruthy();
    expect(screen.getByText(/1,250\.50/)).toBeTruthy();
    expect(screen.getByText('Still being checked. These can change before you review them.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual(['Stop waiting']);
  });

  it('says which fields the photo has not given up yet', async () => {
    const screen = await render(tree({ date: null, vendor: null, amount: 99 }));

    expect(screen.getAllByText('Not read yet')).toHaveLength(2);
  });

  it('keeps the placeholder while there is no early reading', async () => {
    const screen = await render(tree(null));

    expect(screen.queryByText('Read from your photo so far')).toBeNull();
  });
});
