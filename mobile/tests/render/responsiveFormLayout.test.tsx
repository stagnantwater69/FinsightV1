import React from 'react';
import { StyleSheet } from 'react-native';
import { expect, it } from 'vitest';
import { render } from '@testing-library/react-native';
import { HeaderHeightContext } from '@react-navigation/elements';
import { FormScreen } from '../../src/components/FormScreen';
import { Button, T } from '../../src/components/ui';
import { ThemeProvider } from '../../src/context/ThemeContext';

type Fiber = { memoizedProps?: Record<string, any>; return?: Fiber };
function ancestor(node: unknown, property: string): { props: Record<string, any> } {
  let current: Fiber | undefined = (node as { unstable_fiber: Fiber }).unstable_fiber;
  while (current && !(property in (current.memoizedProps ?? {}))) current = current.return;
  expect(current, `ancestor containing ${property}`).not.toBeNull();
  return { props: current!.memoizedProps! };
}

it('uses the actual native header height as the iOS keyboard offset and bounds expanded form content', async () => {
  const screen = await render(<ThemeProvider initialMode="light"><HeaderHeightContext.Provider value={96}>
    <FormScreen><T>Long form content</T></FormScreen>
  </HeaderHeightContext.Provider></ThemeProvider>);
  const label = screen.getByText('Long form content');
  const keyboard = ancestor(label, 'keyboardVerticalOffset');
  expect(keyboard.props.keyboardVerticalOffset).toBe(96);
  expect(keyboard.props.behavior).toBe('padding');
  const scroll = ancestor(label, 'contentContainerStyle');
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
  expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
  expect(scroll.props.keyboardDismissMode).toBe('on-drag');
});

it('respects an explicit keyboard offset and lets a long action label wrap', async () => {
  const title = 'Save this business profile and return to the complete list of businesses';
  const screen = await render(<ThemeProvider initialMode="light"><FormScreen keyboardVerticalOffset={140}>
    <Button title={title} onPress={() => {}} />
  </FormScreen></ThemeProvider>);
  const label = screen.getByText(title);
  expect(ancestor(label, 'keyboardVerticalOffset').props.keyboardVerticalOffset).toBe(140);
  expect(label.props.numberOfLines).toBeUndefined();
  expect(screen.getByRole('button', { name: title })).toBeTruthy();
});
