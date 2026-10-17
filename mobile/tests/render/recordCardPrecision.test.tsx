import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import type { RecordItem } from '../../src/lib/types';

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ children, renderLeftActions, renderRightActions }: {
    children: React.ReactNode;
    renderLeftActions?: () => React.ReactNode;
    renderRightActions?: () => React.ReactNode;
  }) => <>{renderLeftActions?.()}{children}{renderRightActions?.()}</>,
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({ useBusinessProfiles: () => ({}) }));

const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;

function record(type: 'expense' | 'sales', amount: number): RecordItem {
  return {
    id: 7, type, businessProfileId: 1, categoryId: 10,
    duplicateOfRecordId: null, date: '2026-10-13T00:00:00.000Z',
    description: 'Stock delivery', amount, source: 'MANUAL_ENTRY',
    reviewStatus: 'Needs Review', duplicateStatus: 'Flagged', largeExpenseFlag: true,
    createdAt: '2026-10-13T01:00:00.000Z',
  };
}

async function mount(r: RecordItem, platform: 'ios' | 'android' = 'ios') {
  vi.resetModules();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
  vi.spyOn(Platform, 'select').mockImplementation((spec) => spec[platform] ?? spec.native ?? ('default' in spec ? spec.default : undefined));
  const { RecordCard } = await import('../../src/screens/records/RecordCard');
  const { ThemeProvider } = await import('../../src/context/ThemeContext');
  const onPress = vi.fn();
  const onDelete = vi.fn();
  const onResolve = vi.fn();
  const screen = await render(
    <ThemeProvider initialMode="light">
      <RecordCard r={r} categoryName="Stock" onPress={onPress} onDelete={onDelete} onResolve={onResolve} />
    </ThemeProvider>,
  );
  return { screen, onPress, onDelete, onResolve };
}

afterEach(async () => {
  await cleanup();
  Object.defineProperty(Platform, 'OS', originalPlatform);
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('RecordCard exact peso amounts', () => {
  it.each([
    { type: 'expense', amount: 250.01, printed: 'PHP 250.01', kind: 'expense, Stock' },
    { type: 'expense', amount: 1234.56, printed: 'PHP 1,234.56', kind: 'expense, Stock' },
    { type: 'sales', amount: 0.09, printed: 'PHP 0.09', kind: 'sales' },
    { type: 'sales', amount: 250, printed: 'PHP 250.00', kind: 'sales' },
  ] as const)('shows and speaks $printed for $type without rounding away cents', async ({ type, amount, printed, kind }) => {
    const { screen, onPress, onDelete, onResolve } = await mount(record(type, amount));
    expect(screen.getByText(printed)).toBeTruthy();
    const card = screen.getByRole('button', {
      name: `Stock delivery, ${printed}, 2026-10-13, ${kind}, possible duplicate, needs review, large expense, Manual Entry`,
    });
    expect(onDelete).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    await fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each([
    { platform: 'ios', floor: 44 },
    { platform: 'android', floor: 48 },
  ] as const)('keeps revealed actions at the $floor-point floor on $platform and acts only after a press', async ({ platform, floor }) => {
    const { screen, onPress, onDelete, onResolve } = await mount(record('expense', 1234.56), platform);
    const deletion = screen.getByRole('button', { name: 'Delete' });
    const resolution = screen.getByRole('button', { name: 'Resolve' });
    for (const action of [deletion, resolution]) {
      const style = StyleSheet.flatten(action.props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(floor);
      expect(style.width ?? style.minWidth).toBeGreaterThanOrEqual(floor);
    }
    expect(onDelete).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    await fireEvent.press(deletion);
    await fireEvent.press(resolution);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });
});
