import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react-native';

/**
 * Shared screen hierarchy used by the daily-workflow screens.
 *
 * The visual row/stack switch still needs small-device and Dynamic Type
 * inspection, but the semantic hierarchy and reachable action can be pinned
 * in the off-device renderer.
 */

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), profile: null }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { Button, ScreenHeader } = await import('../../src/components/ui');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

function renderHeader(action = true) {
  return render(
    <ThemeProvider initialMode="light">
      <ScreenHeader
        eyebrow="Money out"
        title="Add expense"
        subtitle="Record what the business paid and where it belongs."
        action={action ? <Button title="Import" onPress={() => {}} /> : undefined}
      />
    </ThemeProvider>,
  );
}

describe('ScreenHeader', () => {
  it('exposes one semantic heading with its supporting context', async () => {
    const queries = await renderHeader();

    expect(queries.getByRole('header', { name: 'Add expense' })).toBeTruthy();
    expect(queries.getByText('Money out')).toBeTruthy();
    expect(
      queries.getByText('Record what the business paid and where it belongs.'),
    ).toBeTruthy();
  });

  it('keeps the optional shortcut reachable as a named button', async () => {
    const queries = await renderHeader();
    expect(queries.getByRole('button', { name: 'Import' })).toBeTruthy();
  });

  it('does not create an unnamed control when there is no action', async () => {
    const queries = await renderHeader(false);
    expect(queries.queryAllByRole('button')).toHaveLength(0);
  });
});
