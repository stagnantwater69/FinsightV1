import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ScanProgress } from '../../src/screens/records/scanReceipt/ScanProgress';

describe('scan progress', () => {
  afterEach(async () => { await cleanup(); });

  it('says what is happening and offers only a way to stop', async () => {
    const screen = await render(
      <ThemeProvider initialMode="light">
        <ScanProgress phase="Reading receipt…" onStop={vi.fn()} />
      </ThemeProvider>,
    );

    expect(screen.getByText('Reading receipt…')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual(['Stop waiting']);
  });
});
