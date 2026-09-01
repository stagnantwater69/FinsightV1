import React from 'react';
import { describe, expect, it } from 'vitest';
import { View } from 'react-native';
import {
  render,
  isHiddenFromAccessibility,
} from '@testing-library/react-native';

/**
 * Rendered tests for the mascot (plan ticket §9.12).
 *
 * The plan's rule is that Fin never carries meaning on his own: everything a
 * pose could say is said by the words beside it. That rule is only real if the
 * illustration is genuinely hidden from assistive technology — which is a
 * property of the rendered tree, not of the source. `mascotVisibility.test.ts`
 * checks the props are written; this checks the platform-visible result.
 */

const { Mascot } = await import('../../src/components/MascotState');
const { T } = await import('../../src/components/ui');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const withTheme = (node: React.ReactNode) => (
  <ThemeProvider initialMode="light">{node}</ThemeProvider>
);

describe('Mascot', () => {
  it('is hidden from assistive technology when it is decorative', async () => {
    const queries = await render(withTheme(<Mascot state="login" />));

    // `root` is the Mascot's own wrapper: the ThemeProvider renders its child
    // directly, so the first host element is the one under test.
    const wrapper = queries.root!;
    expect(isHiddenFromAccessibility(wrapper)).toBe(true);
    expect(wrapper.props.accessibilityElementsHidden).toBe(true);
    expect(wrapper.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(wrapper.props.accessible).toBe(false);
  });

  it('hides the image inside it too, not just the frame', async () => {
    const queries = await render(withTheme(<Mascot state="login" />));

    // A wrapper marked hidden whose child is still an element would put the
    // illustration back into the reader's path on Android.
    for (const node of queries.root!.children) {
      if (typeof node === 'string') continue;
      expect(isHiddenFromAccessibility(node)).toBe(true);
    }
  });

  it('becomes a labelled image only when it is given a label', async () => {
    const queries = await render(
      withTheme(<Mascot state="login" label="Fin waving hello" />),
    );

    const image = queries.getByRole('image', { name: 'Fin waving hello' });
    expect(image.props.accessibilityElementsHidden).toBe(false);
    expect(isHiddenFromAccessibility(image)).toBe(false);
  });

  it('leaves the heading first in reading order', async () => {
    const queries = await render(
      withTheme(
        <View>
          <Mascot state="login" />
          <T accessibilityRole="header">FinSight</T>
          <T>Your sales, expenses and receipts in one place.</T>
        </View>,
      ),
    );

    // Nothing announceable precedes the heading, because the illustration is
    // out of the accessibility tree entirely.
    const heading = queries.getByRole('header', { name: 'FinSight' });
    expect(heading).toBeTruthy();
    expect(queries.queryAllByRole('image')).toHaveLength(0);
  });

  it('falls back to the expressionless badge rather than a cheerful pose', async () => {
    // The severity rule: a fallback must never put a smiling Fin beside a
    // failure. Comparing the resolved asset identity is the only way to see
    // which art was chosen.
    const { mascotSource } = await import('../../src/components/MascotState');
    const unknown = mascotSource(
      'notAState' as unknown as Parameters<typeof mascotSource>[0],
    );
    expect(unknown).toEqual(mascotSource('brandMark'));
  });
});
