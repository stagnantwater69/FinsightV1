import React from 'react';
import { describe, expect, it } from 'vitest';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

/**
 * The one "choose one of these" control, under a large system font.
 *
 * WHY THIS FILE EXISTS. Two separate things about SegmentedControl could only
 * be settled on a mounted tree:
 *
 * 1. LAYOUT. Side by side, each segment takes a fraction of the row and its
 *    label wraps as the system font grows. On an affordable Android phone at
 *    200% text that turns a three-option filter into a block of stacked
 *    syllables taller than the card it filters. The control now decides to
 *    stack for itself from the window; it used to be a prop that exactly one
 *    of six call-sites remembered to pass.
 * 2. NAME. The group's name ("Record type") was passed as an
 *    `accessibilityLabel` on the track — a plain View, so never an
 *    accessibility element, so never read. It is folded into each segment's
 *    own name instead, which is the only place React Native will speak it
 *    from without swallowing the buttons inside.
 *
 * WHAT THIS IS NOT. There is no view geometry here, so this proves the axis
 * the control lays out on and the names it exposes — not that the result is
 * legible, comfortable, or reachable one-handed at that text size. And the
 * harness pins iOS, so TAP_FLOOR resolves to 44 here; the 48dp Android branch
 * is not exercised by any of this. Both need a device.
 */

const ui = await import('../../src/components/ui');
const { TAP_FLOOR } = await import('../../src/components/touchTarget');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const OPTIONS = [
  { label: 'All records', value: 'all' },
  { label: 'Expenses', value: 'expense' },
  { label: 'Sales', value: 'sales' },
] as const;

async function mount(props: Partial<React.ComponentProps<typeof ui.SegmentedControl>> = {}) {
  return render(
    <ThemeProvider initialMode="light">
      <ui.SegmentedControl
        options={OPTIONS}
        value="all"
        onChange={() => {}}
        accessibilityLabel="Record type"
        {...(props as object)}
      />
    </ThemeProvider>,
  );
}

/** Runs `body` with the window reporting a given width and text scale. */
async function atWindow(
  { width, fontScale }: { width: number; fontScale: number },
  body: () => Promise<void>,
) {
  const before = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
  try {
    await act(async () =>
      Dimensions.set({
        window: { ...before.window, width, fontScale },
        screen: { ...before.screen, width, fontScale },
      }),
    );
    await body();
  } finally {
    await act(async () => Dimensions.set(before));
  }
}

/** The axis the track lays its segments out on, read off the rendered style. */
function trackAxis(segment: { parent: unknown }): string | undefined {
  const track = (segment as { parent: { props: { style: unknown } } }).parent;
  return (StyleSheet.flatten(track.props.style) as { flexDirection?: string } | undefined)
    ?.flexDirection;
}

describe('SegmentedControl adapts to the window it is in', () => {
  it('sits side by side on a normal phone at normal text', async () => {
    await atWindow({ width: 390, fontScale: 1 }, async () => {
      const queries = await mount();
      expect(trackAxis(queries.getAllByRole('button')[0]!)).toBe('row');
    });
  });

  it.each([
    ['large accessibility text', { width: 390, fontScale: 1.5 }],
    ['a narrow screen', { width: 320, fontScale: 1 }],
  ])('stacks the options under %s', async (_case, window) => {
    await atWindow(window, async () => {
      const queries = await mount();
      expect(trackAxis(queries.getAllByRole('button')[0]!)).toBe('column');
    });
  });

  it('keeps every option at the touch floor once stacked', async () => {
    // Stacking changes the segment's padding and drops its flex, which is
    // exactly where a minimum height gets lost by accident.
    await atWindow({ width: 390, fontScale: 1.5 }, async () => {
      const queries = await mount();
      for (const segment of queries.getAllByRole('button')) {
        const style = StyleSheet.flatten(segment.props.style) as { minHeight?: number };
        expect(style.minHeight ?? 0).toBeGreaterThanOrEqual(TAP_FLOOR);
      }
    });
  });

  it('still lets a call-site force the layout either way', async () => {
    await atWindow({ width: 390, fontScale: 1.5 }, async () => {
      const queries = await mount({ stacked: false });
      expect(trackAxis(queries.getAllByRole('button')[0]!)).toBe('row');
    });
    await atWindow({ width: 390, fontScale: 1 }, async () => {
      const queries = await mount({ stacked: true });
      expect(trackAxis(queries.getAllByRole('button')[0]!)).toBe('column');
    });
  });
});

describe('SegmentedControl says what the group is for', () => {
  it('folds the group name into every option name', async () => {
    const queries = await mount();
    expect(queries.getByRole('button', { name: 'Record type, Expenses' })).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Record type, Sales' })).toBeTruthy();
  });

  it('leaves the option to speak for itself when there is no group name', async () => {
    const queries = await mount({ accessibilityLabel: undefined });
    expect(queries.getByRole('button', { name: 'Expenses' })).toBeTruthy();
  });

  it('reports and moves the selected option', async () => {
    function Host() {
      const [value, setValue] = React.useState<string>('all');
      return (
        <ui.SegmentedControl
          options={OPTIONS}
          value={value}
          onChange={setValue}
          accessibilityLabel="Record type"
        />
      );
    }

    const queries = await render(
      <ThemeProvider initialMode="light">
        <Host />
      </ThemeProvider>,
    );

    const expenses = queries.getByRole('button', { name: 'Record type, Expenses' });
    expect(expenses.props.accessibilityState.selected).toBe(false);

    await fireEvent.press(expenses);

    expect(
      queries.getByRole('button', { name: 'Record type, Expenses' }).props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      queries.getByRole('button', { name: 'Record type, All records' }).props.accessibilityState
        .selected,
    ).toBe(false);
  });
});
