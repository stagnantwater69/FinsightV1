import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { T } from '../../src/components/ui';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { typeScale } from '../../src/theme/tokens';

/*
 * Android clips text to its line box, so a large size that inherits body's
 * 22pt line height loses the bottom of every glyph ("PHP 25,225.00" read as
 * "25.225.00" on a phone). The web build does not clip, which is why only a
 * device showed it.
 */
async function lineHeightOf(style: object) {
  const q = await render(
    <ThemeProvider initialMode="light">
      <T style={style}>PHP 25,225.00</T>
    </ThemeProvider>,
  );
  return StyleSheet.flatten(q.getByText('PHP 25,225.00').props.style).lineHeight;
}

describe('T line height', () => {
  it('grows the line box with an enlarged size', async () => {
    expect(await lineHeightOf({ fontSize: typeScale.display })).toBe(Math.round(typeScale.display * 1.3));
  });

  it('keeps body line height for sizes it already fits', async () => {
    expect(await lineHeightOf({ fontSize: typeScale.bodySm })).toBe(22);
  });

  it('lets an explicit line height win', async () => {
    expect(await lineHeightOf({ fontSize: typeScale.display, lineHeight: 40 })).toBe(40);
  });
});
