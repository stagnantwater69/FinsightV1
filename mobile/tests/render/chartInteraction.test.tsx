import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartDatum, ChartSelection } from '../../src/components/ChartInteraction';
import { chartReadout, hoverChart, queryChartReadout, tapChart } from './support/chartInteractions';

let businessId = 1;
let period = { kind: 'month', month: '2026-10' };
vi.mock('../../src/context/BusinessProfileContext', () => ({ useBusinessProfiles: () => ({ selected: { id: businessId } }) }));
vi.mock('../../src/context/ReportingPeriodContext', () => ({ useReportingPeriod: () => ({ selection: period }) }));
const { useChartSelection, ChartValueReadout, ChartPlotPressArea } = await import('../../src/components/ChartInteraction');
const { ThemeProvider, useThemeControl } = await import('../../src/context/ThemeContext');
let selection: ChartSelection;
let themeControl: ReturnType<typeof useThemeControl>;
const data: ChartDatum[] = [
  { key: 'one', label: 'October 1, 2026', values: [{ label: 'Sales', value: 0 }, { label: 'Target', value: 100.05 }] },
  { key: 'two', label: 'October 2, 2026', values: [{ label: 'Sales', value: 300.25 }, { label: 'Target', value: 200.10 }] },
  { key: 'three', label: 'October 3, 2026', values: [{ label: 'Sales', value: null, display: 'PHP 0.00', unavailableLabel: 'Future day' }, { label: 'Target', value: 350.50 }], note: 'Estimated target' },
];
function Demo({ rows = data, scope = 'account-one', mode = 'points' }: { rows?: ChartDatum[]; scope?: string; mode?: 'points' | 'bands' }) {
  selection = useChartSelection(rows, scope);
  themeControl = useThemeControl();
  return <View><ChartPlotPressArea selection={selection} count={rows.length} chartLabel="Test chart" mode={mode}><View /></ChartPlotPressArea>
    {rows.map((row, i) => <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={row.key} {...selection.bind(i)} />)}
    <ChartValueReadout data={rows} selection={selection} chartLabel="Test chart" /></View>;
}
const tree = (props: React.ComponentProps<typeof Demo> = {}, theme: 'light' | 'dark' = 'light') => <ThemeProvider initialMode={theme}><Demo {...props} /></ThemeProvider>;
beforeEach(() => { businessId = 1; period = { kind: 'month', month: '2026-10' }; vi.clearAllMocks(); });

describe('Chart value interaction', () => {
  it('pins measured point selection and retains named exact multiple series', async () => {
    const q = await render(tree());
    await tapChart(q, 'Test chart', 150);
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('Sales: PHP 300.25. Target: PHP 200.10');
    await hoverChart(q, 'Test chart', 0);
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('Sales: PHP 0.00');
    await fireEvent(q.getByLabelText('Test chart plot', { includeHiddenElements: true }), 'hoverOut');
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('Sales: PHP 300.25');
    await fireEvent.press(q.getByRole('button', { name: 'Clear Test chart value' }));
    expect(queryChartReadout(q, 'Test chart')).toBeNull();
  });

  it('uses current dimensions after resize and ignores touch movement or pressed dragging', async () => {
    const q = await render(tree({ mode: 'bands' }));
    await tapChart(q, 'Test chart', 125, 60, 300);
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 2');
    await tapChart(q, 'Test chart', 125, 60, 600);
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 1');
    await hoverChart(q, 'Test chart', 600, 60, 'touch');
    await hoverChart(q, 'Test chart', 600, 60, 'mouse', 1);
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 1');
    await hoverChart(q, 'Test chart', 600, 60, 'pen');
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('Future day');
  });

  it('supports focus exploration without overwriting a pinned value', async () => {
    const q = await render(tree());
    await fireEvent.press(q.getByRole('button', { name: 'one' }));
    await fireEvent(q.getByRole('button', { name: 'two' }), 'focus');
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 2');
    await fireEvent(q.getByRole('button', { name: 'two' }), 'blur');
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 1');
  });

  it('maps a raw browser hover event using current element bounds', async () => {
    const q = await render(tree());
    await tapChart(q, 'Test chart', 0);
    const plot = q.getByLabelText('Test chart plot', { includeHiddenElements: true });
    const original = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      await fireEvent(plot, 'hoverIn', { clientX: 550, clientY: 90, pointerType: 'mouse', buttons: 0, currentTarget: { getBoundingClientRect: () => ({ left: 400, top: 30, width: 300, height: 120 }) } });
    } finally { Object.defineProperty(Platform, 'OS', original); }
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 2');
    await fireEvent(plot, 'hoverOut');
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 1');
  });

  it('explores sequentially with bounded controls and separates missing values from recorded zero', async () => {
    const q = await render(tree());
    await fireEvent.press(q.getByRole('button', { name: 'Explore Test chart values' }));
    expect(q.getByRole('button', { name: 'Previous value in Test chart' }).props.accessibilityState.disabled).toBe(true);
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('PHP 0.00');
    await act(() => { selection.next(); selection.next(); });
    const name = chartReadout(q, 'Test chart').props.accessibilityLabel;
    expect(name).toContain('Sales: Future day. Target: PHP 350.50. Estimated target');
    expect(name).not.toContain('PHP 0.00');
    expect(q.getByRole('button', { name: 'Next value in Test chart' }).props.accessibilityState.disabled).toBe(true);
  });

  it('rejects nonfinite values before custom display and preserves valid negative/share formatting', async () => {
    const rows: ChartDatum[] = [{ key: 'one', label: 'Amounts', values: [
      { label: 'Invalid', value: NaN, display: 'PHP 0.00' },
      { label: 'Net', value: -100.05 }, { label: 'Share', value: 40.25, display: '40.25%' },
    ] }];
    const q = await render(tree({ rows }));
    await fireEvent.press(q.getByRole('button', { name: 'Explore Test chart values' }));
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('Invalid: Not recorded. Net: −PHP 100.05. Share: 40.25%');
    expect(q.getByRole('button', { name: 'Next value in Test chart' }).props.accessibilityState.disabled).toBe(true);
  });

  it.each(['business', 'period', 'account', 'data'])('clears identical/stale selection when %s changes and rejects old callbacks including A-B-A', async (boundary) => {
    const q = await render(tree());
    await fireEvent.press(q.getByRole('button', { name: 'two' }));
    const stale = selection.select;
    let props: React.ComponentProps<typeof Demo> = {};
    if (boundary === 'business') businessId = 2;
    if (boundary === 'period') period = { kind: 'month', month: '2026-09' };
    if (boundary === 'account') props = { scope: 'account-two' };
    if (boundary === 'data') props = { rows: data.map((row, i) => i === 1 ? { ...row, values: [{ label: 'Sales', value: 999.99 }] } : row) };
    await q.rerender(tree(props));
    expect(queryChartReadout(q, 'Test chart')).toBeNull();
    businessId = 1; period = { kind: 'month', month: '2026-10' };
    await q.rerender(tree());
    await act(() => stale(2));
    expect(queryChartReadout(q, 'Test chart')).toBeNull();
  });

  it('retains selected value across equivalent data and swatch/theme changes', async () => {
    const q = await render(tree());
    await fireEvent.press(q.getByRole('button', { name: 'two' }));
    await act(() => themeControl.setMode('dark'));
    expect(themeControl.mode).toBe('dark');
    await q.rerender(tree({ rows: data.map((row) => ({ ...row, values: row.values.map((value) => ({ ...value, color: '#123456' })) })) }));
    expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 2');
  });

  it('offers no value controls for empty data and ignores callbacks after unmount', async () => {
    const q = await render(tree({ rows: [] }));
    expect(q.queryByRole('button', { name: 'Explore Test chart values' })).toBeNull();
    const stale = selection.select;
    await q.unmount();
    await act(() => stale(0));
  });

  it('handles web keyboard exploration only inside its controls, Escape dismissal and listener cleanup', async () => {
    const original = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
    const listeners = new Set<(event: KeyboardEvent) => void>();
    const add = vi.fn((_type: string, listener: (event: KeyboardEvent) => void) => listeners.add(listener));
    const remove = vi.fn((_type: string, listener: (event: KeyboardEvent) => void) => listeners.delete(listener));
    vi.stubGlobal('document', { addEventListener: add, removeEventListener: remove });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const target = {};
    const nodes: { contains?: (node: unknown) => boolean }[] = [];
    let q: Awaited<ReturnType<typeof render>> | undefined;
    try {
      q = await render(tree());
      let fiber = q.getByRole('button', { name: 'Explore Test chart values' }).unstable_fiber;
      while (fiber) {
        if (fiber.stateNode?.measureInWindow) { const node = fiber.stateNode as { contains?: (node: unknown) => boolean }; node.contains = (nodeTarget) => nodeTarget === target; nodes.push(node); }
        fiber = fiber.return;
      }
      const key = async (name: string, eventTarget: unknown = target) => {
        const event = { key: name, target: eventTarget, preventDefault: vi.fn() } as unknown as KeyboardEvent;
        await act(() => { for (const listener of [...listeners]) listener(event); });
        return event;
      };
      await key('ArrowRight', {});
      expect(queryChartReadout(q, 'Test chart')).toBeNull();
      const first = await key('ArrowRight');
      expect(first.preventDefault).toHaveBeenCalled();
      expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 1');
      await key('ArrowDown');
      expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 2');
      await key('ArrowLeft');
      expect(chartReadout(q, 'Test chart').props.accessibilityLabel).toContain('October 1');
      await key('Escape', {});
      expect(queryChartReadout(q, 'Test chart')).toBeNull();
      await q.unmount(); q = undefined;
      expect(listeners.size).toBe(0);
      expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    } finally {
      if (q) await q.unmount();
      for (const node of nodes) delete node.contains;
      Object.defineProperty(Platform, 'OS', original); vi.unstubAllGlobals();
    }
  });
});
