import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';
import { InsightHeader, type InsightScreenId } from '../../src/components/InsightsShared';
import { ThemeProvider } from '../../src/context/ThemeContext';

function mount(active: InsightScreenId, title: string) {
  const navigation = { navigate: vi.fn() };
  const queries = render(
    <ThemeProvider initialMode="light">
      <InsightHeader navigation={navigation} active={active} title={title} />
    </ThemeProvider>,
  );
  return { navigation, queries };
}

describe('InsightHeader title switcher', () => {
  it('lists the three insight screens with a plain description of each', async () => {
    const { queries } = mount('ExpenseBehavior', 'Expenses');
    const q = await queries;
    await fireEvent.press(q.getByRole('button', { name: 'Expenses. Switch insight' }));
    expect(q.getByText('Explore insights')).toBeTruthy();
    for (const text of [
      'Spending impact', 'How spending affects your business',
      'Recovery target', 'How much to sell to cover costs',
      'Where your money goes',
    ]) {
      expect(q.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(q.queryByText('Ask FinSight')).toBeNull();
  });

  it('navigates to the chosen screen', async () => {
    const { navigation, queries } = mount('ExpenseBehavior', 'Expenses');
    const q = await queries;
    await fireEvent.press(q.getByRole('button', { name: 'Expenses. Switch insight' }));
    await fireEvent.press(q.getByText('Recovery target'));
    expect(navigation.navigate).toHaveBeenCalledWith('RecoveryTarget');
  });

  it('does not navigate when the current screen is chosen again', async () => {
    const { navigation, queries } = mount('RecoveryTarget', 'Recovery target');
    const q = await queries;
    await fireEvent.press(q.getByRole('button', { name: 'Recovery target. Switch insight' }));
    await fireEvent.press(q.getAllByText('Recovery target').at(-1)!);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
