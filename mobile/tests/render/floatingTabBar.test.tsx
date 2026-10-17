import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Dimensions, Pressable, StyleSheet } from 'react-native';
import { FloatingTabBar } from '../../src/components/FloatingTabBar';
import { QuickActionMenu, type RadialAction } from '../../src/components/QuickActionMenu';
import { ThemeProvider } from '../../src/context/ThemeContext';

const routes = ['Dashboard', 'Records', 'Scan', 'Insights', 'More'].map((name) => ({ key: `${name}-key`, name, params: undefined }));

function mountBar({ index = 0, defaultPrevented = false, mutedRoute }: { index?: number; defaultPrevented?: boolean; mutedRoute?: string } = {}) {
  const navigation = {
    emit: vi.fn(() => ({ defaultPrevented })),
    navigate: vi.fn(),
  };
  const descriptors = Object.fromEntries(routes.map((r) => [r.key, {
    options: { tabBarLabel: r.name === 'Dashboard' ? 'Home' : r.name, tabBarIcon: () => null },
  }]));
  const onAdd = vi.fn();
  const queries = render(
    <ThemeProvider initialMode="light">
      <FloatingTabBar
        state={{ index, routes } as never}
        descriptors={descriptors as never}
        navigation={navigation as never}
        insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
        hiddenRoutes={['Scan']}
        mutedRoute={mutedRoute}
        addButton={<Pressable accessibilityRole="button" accessibilityLabel="Add a record" onPress={onAdd} />}
      />
    </ThemeProvider>,
  );
  return { navigation, onAdd, queries };
}

describe('FloatingTabBar', () => {
  it('shows the four destinations as tabs and "+" on its own', async () => {
    const q = await mountBar().queries;
    expect(q.getAllByRole('tab').map((n) => n.props.accessibilityLabel)).toEqual(['Home', 'Records', 'Insights', 'More']);
    expect(q.getByRole('button', { name: 'Add a record' })).toBeTruthy();
    expect(q.getByRole('tab', { name: 'Home' }).props.accessibilityState.selected).toBe(true);
  });

  it('emits tabPress before navigating, so a tab listener can intercept it', async () => {
    const { navigation, queries } = mountBar();
    const q = await queries;
    await fireEvent.press(q.getByRole('tab', { name: 'Insights' }));
    expect(navigation.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tabPress', target: 'Insights-key', canPreventDefault: true }));
    expect(navigation.navigate).toHaveBeenCalledWith('Insights', undefined);
  });

  it('does not navigate when the listener prevents the press', async () => {
    const { navigation, queries } = mountBar({ defaultPrevented: true });
    const q = await queries;
    await fireEvent.press(q.getByRole('tab', { name: 'Records' }));
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('draws a muted route as unfocused', async () => {
    const q = await mountBar({ index: 1, mutedRoute: 'Records' }).queries;
    expect(q.getByRole('tab', { name: 'Records' }).props.accessibilityState.selected).toBe(false);
  });

  it.each([1.3, 2])('keeps all destinations accessible on a 320px phone at text scale %s', async (fontScale) => {
    const before = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    try {
      await act(async () => Dimensions.set({
        window: { ...before.window, width: 320, fontScale },
        screen: { ...before.screen, width: 320, fontScale },
      }));
      const { navigation, queries } = mountBar({ index: 3 });
      const q = await queries;
      for (const name of ['Home', 'Records', 'Insights', 'More']) {
        const tab = q.getByRole('tab', { name });
        const style = StyleSheet.flatten(tab.props.style);
        expect(style.minWidth).toBeGreaterThanOrEqual(48);
        expect(style.minHeight).toBeGreaterThanOrEqual(48);
      }
      expect(q.queryByText('Records')).toBeNull();
      if (fontScale === 1.3) expect(q.getByText('Insights').props.numberOfLines).toBe(1);
      else expect(q.queryByText('Insights')).toBeNull();
      await fireEvent.press(q.getByRole('tab', { name: 'Records' }));
      expect(navigation.navigate).toHaveBeenCalledWith('Records', undefined);
    } finally {
      await act(async () => Dimensions.set(before));
    }
  });
});

describe('QuickActionMenu speed dial', () => {
  it('labels every action and runs the chosen one after closing', async () => {
    const onClose = vi.fn();
    const onExpense = vi.fn();
    const actions: RadialAction[] = [
      { key: 'expense', label: 'Add expense', icon: 'receipt-outline', color: '#f5a524', onColor: '#1a2022', onPress: onExpense },
      { key: 'sales', label: 'Add sale', icon: 'cash-outline', color: '#1baf7a', onColor: '#ffffff', onPress: vi.fn() },
      { key: 'scan', label: 'Scan a receipt', icon: 'camera-outline', color: '#0f504b', onColor: '#ffffff', onPress: vi.fn() },
    ];
    const q = await render(
      <ThemeProvider initialMode="light">
        <QuickActionMenu visible actions={actions} onClose={onClose} />
      </ThemeProvider>,
    );
    for (const label of ['Add expense', 'Add sale', 'Scan a receipt']) expect(q.getByText(label)).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Add expense' }));
    expect(onClose).toHaveBeenCalled();
    expect(onExpense).toHaveBeenCalled();
  });
});
