import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Animated, Platform, StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { QuickActionMenu } from '../../src/components/QuickActionMenu';
import { CaptureStatusPill } from '../../src/components/receipt-camera/CaptureChrome';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { shadowStyle } from '../../src/theme/shadow';

vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: () => false }));

const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
const setPlatform = (platform: 'web' | 'ios' | 'android') =>
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });

afterEach(() => {
  Object.defineProperty(Platform, 'OS', originalPlatform);
  vi.restoreAllMocks();
});

describe('Platform presentation', () => {
  it.each(['ios', 'android'] as const)('preserves native shadow geometry and elevation on %s', (platform) => {
    setPlatform(platform);
    expect(shadowStyle({ color: '#123456', opacity: 0.2, offsetX: 2, offsetY: 3, blurRadius: 8, elevation: 6 })).toEqual({
      shadowColor: '#123456', shadowOpacity: 0.2,
      shadowOffset: { width: 2, height: 3 }, shadowRadius: 8, elevation: 6,
    });
  });

  it('uses the same color and geometry as a web box shadow, including existing color alpha', () => {
    setPlatform('web');
    const opaque = shadowStyle({ color: '#123456', opacity: 0.2, offsetX: 2, offsetY: 3, blurRadius: 8, elevation: 6 });
    expect(opaque).toEqual({ boxShadow: '2px 3px 8px rgba(18, 52, 86, 0.2)' });
    const translucent = shadowStyle({ color: '#12345680', opacity: 0.2, offsetY: 3, blurRadius: 8, elevation: 6 });
    expect(translucent).toEqual({ boxShadow: `0px 3px 8px rgba(18, 52, 86, ${128 / 255 * 0.2})` });
    for (const legacy of ['shadowColor', 'shadowOpacity', 'shadowOffset', 'shadowRadius', 'elevation']) {
      expect(opaque).not.toHaveProperty(legacy);
      expect(translucent).not.toHaveProperty(legacy);
    }
  });

  it.each(['web', 'ios', 'android'] as const)('animates the menu using the available driver on %s and stops it on unmount', async (platform) => {
    setPlatform(platform);
    const spring = vi.spyOn(Animated, 'spring');
    const stop = vi.fn();
    vi.spyOn(Animated, 'parallel').mockReturnValue({ start: vi.fn(), stop, reset: vi.fn() });
    const q = await render(
      <ThemeProvider initialMode="light">
        <QuickActionMenu visible onClose={vi.fn()} actions={[{
          key: 'expense', label: 'Add expense', icon: 'receipt-outline',
          color: '#f5a524', onColor: '#1a2022', onPress: vi.fn(),
        }]} />
      </ThemeProvider>,
    );
    expect(spring).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ useNativeDriver: platform !== 'web' }));
    expect(q.getByRole('button', { name: 'Add expense' })).toBeTruthy();
    await q.unmount();
    expect(stop).toHaveBeenCalled();
  });

  it('keeps camera guidance passthrough in style and retains its loading announcement', async () => {
    const q = await render(
      <ThemeProvider initialMode="light">
        <CaptureStatusPill message="Checking receipt" working />
      </ThemeProvider>,
    );
    expect(StyleSheet.flatten(q.root!.props.style).pointerEvents).toBe('none');
    expect(q.root!.props.pointerEvents).toBeUndefined();
    expect(q.getByText('Checking receipt').props.accessibilityLiveRegion).toBe('polite');
  });
});
