import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

/**
 * Touch targets, measured on the rendered tree (plan ticket §9.12).
 *
 * `tests/touchTargets.test.ts` beside this reads the SOURCE and proves nobody
 * wrote `TAP - 10`. It cannot see what a control ends up with once the style
 * has been composed from an array, a variant table and a caller override —
 * which is exactly where an undercut hides. This mounts the shared primitives
 * and reads the flattened style off the host element instead.
 *
 * WHAT IT STILL DOES NOT PROVE, and no off-device test can: that the resulting
 * target is comfortable, reachable one-handed, or correctly placed over live
 * camera video. Those remain physical-device questions.
 */

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), profile: null }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ui = await import('../../src/components/ui');
const { TAP_FLOOR } = await import('../../src/components/touchTarget');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const withTheme = (node: React.ReactNode) => (
  <ThemeProvider initialMode="light">{node}</ThemeProvider>
);

/**
 * The effective tappable height of an element: its own minimum height plus
 * whatever vertical hitSlop it carries. This is the number the platform
 * actually uses, and it is the number the floor is about.
 */
function tappableHeight(element: { props: Record<string, unknown> }): number {
  const style = StyleSheet.flatten(
    element.props.style as never,
  ) as Record<string, number> | undefined;
  const base = style?.minHeight ?? style?.height ?? 0;

  const slop = element.props.hitSlop as
    | number
    | { top?: number; bottom?: number }
    | undefined;
  const extra =
    typeof slop === 'number'
      ? slop * 2
      : ((slop?.top ?? 0) + (slop?.bottom ?? 0));

  return base + extra;
}

describe('Rendered touch targets', () => {
  it('gives Button at least the platform floor', async () => {
    const queries = await render(
      withTheme(<ui.Button title="Log in" onPress={() => {}} />),
    );

    const button = queries.getByRole('button', { name: 'Log in' });
    expect(tappableHeight(button)).toBeGreaterThanOrEqual(TAP_FLOOR);
  });

  it('keeps the floor even when the caller passes its own style', async () => {
    // The composed-style case the source check cannot see: a call site adding
    // margins must not be able to shrink the target.
    const queries = await render(
      withTheme(
        <ui.Button
          title="Log in"
          onPress={() => {}}
          style={{ marginTop: 12 }}
        />,
      ),
    );

    const button = queries.getByRole('button', { name: 'Log in' });
    expect(tappableHeight(button)).toBeGreaterThanOrEqual(TAP_FLOOR);
  });

  it('gives SelectChip the floor, counting its hitSlop', async () => {
    const queries = await render(
      withTheme(
        <ui.SelectChip label="₱500" selected={false} onPress={() => {}} />,
      ),
    );

    // Chips are visually small on purpose; the floor is met through hitSlop,
    // which is why the measurement has to include it.
    const chip = queries.getByRole('button', { name: '₱500' });
    expect(tappableHeight(chip)).toBeGreaterThanOrEqual(TAP_FLOOR);
  });

  it('gives every segment of a SegmentedControl the floor', async () => {
    const queries = await render(
      withTheme(
        <ui.SegmentedControl
          options={[
            { label: 'Today', value: 1 },
            { label: 'Week', value: 7 },
            { label: 'Month', value: 30 },
          ]}
          value={30}
          onChange={() => {}}
          accessibilityLabel="Comparison period"
        />,
      ),
    );

    const segments = queries.getAllByRole('button');
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(tappableHeight(segment)).toBeGreaterThanOrEqual(TAP_FLOOR);
    }
  });

  it('gives the Checkbox row the floor', async () => {
    const queries = await render(
      withTheme(
        <ui.Checkbox label="Remember me" checked onChange={() => {}} />,
      ),
    );

    const checkbox = queries.getByRole('checkbox', { name: 'Remember me' });
    expect(tappableHeight(checkbox)).toBeGreaterThanOrEqual(TAP_FLOOR);
  });

  it('gives text inputs the floor so a scaled system font still fits', async () => {
    const queries = await render(
      withTheme(
        <ui.Field label="Email" value="" onChangeText={() => {}} />,
      ),
    );

    const input = queries.getByLabelText('Email');
    expect(tappableHeight(input)).toBeGreaterThanOrEqual(TAP_FLOOR);
  });
});
