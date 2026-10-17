import { fireEvent } from '@testing-library/react-native';
import { vi } from 'vitest';
import type { render } from '@testing-library/react-native';

export type ChartQueries = Awaited<ReturnType<typeof render>>;
export function chartReadout(queries: ChartQueries, chartLabel: string) {
  return queries.getByRole('text', { name: (new RegExp(`^${chartLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} selected value\\.`)) });
}
export function queryChartReadout(queries: ChartQueries, chartLabel: string) {
  return queries.queryByRole('text', { name: (new RegExp(`^${chartLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} selected value\\.`)) });
}
export async function tapChart(queries: ChartQueries, chartLabel: string, x = 150, y = 60, width = 300, height = 120) {
  const plot = queries.getAllByLabelText(`${chartLabel} plot`, { includeHiddenElements: true })[0]!;
  let wrapper = plot.parent;
  while (wrapper && !wrapper.props.onLayout) wrapper = wrapper.parent;
  if (!wrapper) throw new Error(`${chartLabel} plot has no measured layout`);
  await fireEvent(wrapper, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  await fireEvent.press(plot, { nativeEvent: { locationX: x, locationY: y }, stopPropagation: vi.fn() });
}
export async function hoverChart(queries: ChartQueries, chartLabel: string, x: number, y = 60, pointerType = 'mouse', buttons = 0) {
  const plot = queries.getAllByLabelText(`${chartLabel} plot`, { includeHiddenElements: true })[0]!;
  await fireEvent(plot, 'pointerMove', { nativeEvent: { locationX: x, locationY: y, pointerType, buttons } });
}
