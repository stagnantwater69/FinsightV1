import React from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('react-native-web');
});
vi.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: { background: '#ffffff' } }),
  NavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('../node_modules/@react-navigation/elements/src/useFrameSize', () => ({
  useFrameSize: (selector: (size: { width: number; height: number }) => number) => selector({ width: 411, height: 914 }),
}));

const require = createRequire(import.meta.url);
const { StyleSheet, Text, View } = require('react-native-web');
const renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup as (element: React.ReactNode) => string;
const screenPath = '../node_modules/@react-navigation/elements/src/Screen';
const resourcePath = '../node_modules/@react-navigation/elements/src/ResourceSavingView';
const { Screen } = await import(screenPath);
const { ResourceSavingView } = await import(resourcePath);

function compiledPointerRules(html: string) {
  const classes = [...new Set(html.match(/r-pointerEvents-[a-z0-9]+/g) ?? [])];
  expect(classes).toHaveLength(1);
  const selector = `.${classes[0]}`;
  const css = StyleSheet.getSheet().textContent as string;
  return {
    parent: css.match(new RegExp(`${selector.replace('.', '\\.')}\\{([^}]+)\\}`))?.[1],
    children: css.match(new RegExp(`${selector.replace('.', '\\.')}>\\*\\s*\\{([^}]+)\\}`))?.[1],
  };
}

describe('Installed navigation pointer events on the real web adapter', () => {
  it('compiles header box-none into a non-intercepting wrapper with interactive children', () => {
    const html = renderToStaticMarkup(React.createElement(Screen, {
      focused: true,
      navigation: {},
      route: { key: 'insights', name: 'Insights' },
      header: React.createElement(View, { accessibilityRole: 'button' }, React.createElement(Text, null, 'Back')),
    }, React.createElement(Text, null, 'Insight content')));
    expect(html).toContain('Insight content');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('pointer-events:box-none');
    expect(compiledPointerRules(html)).toEqual({
      parent: 'pointer-events:none!important;',
      children: 'pointer-events:auto;',
    });
  });

  it.each([
    { visible: false, parent: 'pointer-events:none!important;', children: 'pointer-events:none;' },
    { visible: true, parent: 'pointer-events:auto!important;', children: undefined },
  ])('compiles visible=$visible resource-screen guards without losing descendant behavior', ({ visible, parent, children }) => {
    const html = renderToStaticMarkup(React.createElement(ResourceSavingView, { visible },
      React.createElement(View, { accessibilityRole: 'button' }, React.createElement(Text, null, 'Open insight'))));
    expect(html).toContain(`display:${visible ? 'flex' : 'none'}`);
    expect(html).toContain('Open insight');
    expect(compiledPointerRules(html)).toEqual({ parent, children });
  });
});
