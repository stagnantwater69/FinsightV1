import React from 'react';
import { describe, expect, it } from 'vitest';
import { Platform, Pressable, Text, View } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

/**
 * Guards the render harness itself. If React Native ever stops loading under
 * Vitest (Flow dialect change, new native-backed module, renderer swap), this
 * fails first and unambiguously instead of every screen test failing in a
 * confusing way.
 *
 * NOTE ON `screen`: @testing-library/react-native's module-level `screen`
 * export is reassigned by `render()`, and that reassignment is invisible across
 * the CommonJS/ESM boundary Vitest uses. Tests in this directory therefore
 * destructure queries from the `render()` return value rather than importing
 * `screen`.
 */
describe('render harness', () => {
  it('mounts a React Native tree and finds nodes by accessibility role', async () => {
    const { getByRole } = await render(
      <View>
        <Text accessibilityRole="header">Hello</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Tap me">
          <Text>Tap me</Text>
        </Pressable>
      </View>,
    );

    expect(getByRole('header', { name: 'Hello' })).toBeTruthy();
    expect(getByRole('button', { name: 'Tap me' })).toBeTruthy();
  });

  it('reports accessibilityValue.text through role queries', async () => {
    const { getByRole } = await render(
      // `accessible` is required for a View to be exposed as a single
      // accessibility element — RNTL models the same rule the platform does,
      // so role queries will not find a View that only sets a role.
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Impact"
        accessibilityValue={{ text: '84.0% of your available funds' }}
      />,
    );

    const gauge = getByRole('progressbar', { name: 'Impact' });
    expect(gauge.props.accessibilityValue?.text).toBe(
      '84.0% of your available funds',
    );
  });

  it('dispatches press events to handlers', async () => {
    let pressed = 0;
    const { getByRole } = await render(
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increment"
        onPress={() => {
          pressed += 1;
        }}
      />,
    );

    fireEvent.press(getByRole('button', { name: 'Increment' }));
    expect(pressed).toBe(1);
  });

  it('resolves platform-specific React Native modules', () => {
    // The harness pins the iOS branch, mirroring the Jest preset's
    // `haste.defaultPlatform`. Platform-divergent behavior is therefore only
    // exercised on iOS here.
    expect(Platform.OS).toBe('ios');
  });
});
