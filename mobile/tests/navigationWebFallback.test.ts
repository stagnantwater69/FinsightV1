import React from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('react-native-web');
});

const require = createRequire(import.meta.url);
const { StyleSheet } = require('react-native-web');
const renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup as (element: React.ReactNode) => string;
const webScreenPath = '../node_modules/react-native-screens/src/components/Screen.web';
const { NativeScreen } = await import(webScreenPath);

describe('Installed web screen fallback', () => {
  it('preserves inactive pointer guards, positioning and forwarded view props when native screens are disabled', () => {
    const style = [StyleSheet.absoluteFill, { pointerEvents: 'none', zIndex: -1 }];
    const props = { enabled: false, activityState: 0, style, testID: 'inactive-screen', accessibilityLabel: 'Inactive insight' };
    const rendered = new NativeScreen(props).render();
    expect(rendered.props.style).toBe(style);
    expect(StyleSheet.flatten(rendered.props.style)).toMatchObject({
      pointerEvents: 'none', position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: -1,
    });
    expect(rendered.props.testID).toBe('inactive-screen');
    expect(rendered.props.accessibilityLabel).toBe('Inactive insight');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const html = renderToStaticMarkup(React.createElement(NativeScreen, props));
      expect(html).toContain('data-testid="inactive-screen"');
      expect(html).toContain('aria-label="Inactive insight"');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { activityState: 0, display: 'none', hidden: true, pointerEvents: 'none', zIndex: -1 },
    { activityState: 2, display: 'flex', hidden: false, pointerEvents: 'box-none', zIndex: 0 },
  ])('retains enabled-screen visibility and pointer guards for activity $activityState', ({ activityState, display, hidden, pointerEvents, zIndex }) => {
    const rendered = new NativeScreen({ enabled: true, activityState, style: { pointerEvents, zIndex } }).render();
    expect(rendered.props.hidden).toBe(hidden);
    expect(StyleSheet.flatten(rendered.props.style)).toMatchObject({ pointerEvents, zIndex, display });
  });
});
