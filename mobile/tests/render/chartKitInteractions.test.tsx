import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { describe, expect, it } from 'vitest';
import * as charts from '../../src/components/charts';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { chartReadout, hoverChart, queryChartReadout, tapChart } from './support/chartInteractions';
import { chartCashflow, chartCategories, chartCumulative, chartDays, chartTrends } from './support/chartFixtures';
const mount = (node: React.ReactNode) => render(<ThemeProvider initialMode="light">{node}</ThemeProvider>);

describe('Chart kit value exploration', () => {
  it('selects a category bar with exact spending/share, retaining the image summary', async () => {
    const q = await mount(<charts.CategoryBreakdown data={chartCategories} />);
    await tapChart(q, 'Where your money went: Rent');
    const name = chartReadout(q, 'Where your money went').props.accessibilityLabel;
    expect(name).toContain('Rent. Spending: PHP 250.75'); expect(name).toContain('Share of spending: 25.05%');
    expect(q.getByRole('image').props.accessibilityLabel).toContain('Stock');
  });
  it('selects a trend date with recorded zero and cumulative spending', async () => {
    const q = await mount(<charts.SpendTrend data={chartDays} />);
    await tapChart(q, 'Spending so far', 150);
    expect(chartReadout(q, 'Spending so far').props.accessibilityLabel).toContain('Spending that day: PHP 0.00. Running total: PHP 150.25');
    await hoverChart(q, 'Spending so far', 300);
    expect(chartReadout(q, 'Spending so far').props.accessibilityLabel).toContain('PHP 650.75');
    expect(q.getByRole('image').props.accessibilityLabel).toContain('Running total');
  });
  it('names both cashflow series and a negative net at the chosen date', async () => {
    const q = await mount(<charts.CashflowChart data={chartCashflow} />);
    await tapChart(q, 'Cashflow', 150);
    expect(chartReadout(q, 'Cashflow').props.accessibilityLabel).toContain('Money in: PHP 0.00. Money out: PHP 100.05. Net: −PHP 100.05');
    expect(q.getByRole('image').props.accessibilityLabel).toContain('Total money in');
  });
  it('explores a diverging change bar as a percentage', async () => {
    const q = await mount(<charts.CategoryChange data={chartTrends.map(({ categoryName, percentChange, direction }) => ({ categoryName, percentChange: percentChange!, direction }))} />);
    await tapChart(q, 'How each category moved: Rent');
    expect(chartReadout(q, 'How each category moved').props.accessibilityLabel).toContain('Rent. Change: -16.49%');
    expect(q.getByRole('image')).toBeTruthy();
  });
  it('maps coverage columns to equal bands and names sales plus target', async () => {
    const q = await mount(<charts.CoverageColumns data={chartDays.map((row) => ({ date: row.date, amount: row.total }))} target={200.10} />);
    await tapChart(q, 'Daily coverage', 110);
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).toContain('Sales: PHP 0.00. Target: PHP 200.10');
    expect(q.getByRole('image').props.accessibilityLabel).toContain('1 of 3 days met it');
  });
  it('maps a donut segment and keeps the total summary outside the interactive controls', async () => {
    const q = await mount(<charts.DonutChart data={chartCategories} />);
    await tapChart(q, 'Share of spending', 45, 40, 300, 120);
    expect(chartReadout(q, 'Share of spending').props.accessibilityLabel).toContain('Rent. Spending: PHP 250.75');
    expect(q.getByRole('image').props.accessibilityLabel).toContain('1,001');
    await fireEvent.press(q.getByRole('button', { name: 'Clear Share of spending value' }));
    expect(queryChartReadout(q, 'Share of spending')).toBeNull();
  });
  it('names both comparison series and missing prior comparison', async () => {
    const q = await mount(<charts.CategoryComparison data={[...chartTrends, { categoryName: 'New', current: 50.05, previous: 0, percentChange: null }]} />);
    await tapChart(q, 'This period vs last', 300);
    expect(chartReadout(q, 'This period vs last').props.accessibilityLabel).toContain('PHP 50.05');
    expect(chartReadout(q, 'This period vs last').props.accessibilityLabel).toContain('No previous amount to compare');
    expect(q.getByRole('image')).toBeTruthy();
  });
  it('keeps future sales unavailable and estimated target explicitly identified', async () => {
    const q = await mount(<charts.CumulativeSalesChart points={chartCumulative} />);
    await tapChart(q, 'Sales vs. target', 300);
    const name = chartReadout(q, 'Sales vs. target').props.accessibilityLabel;
    expect(name).toContain('350.50'); expect(name).toMatch(/not.*recorded|future/i); expect(name).toMatch(/estimated/i);
    expect(name).not.toContain('Sales: PHP 0.00');
    expect(q.getByRole('image').props.accessibilityLabel).toContain('Recorded sales reach');
    await fireEvent.press(q.getByRole('button', { name: 'Explore Sales vs. target values' }));
    expect(chartReadout(q, 'Sales vs. target').props.accessibilityLabel).toContain('PHP 0.00');
  });
  it('clears a displayed cashflow date when fresh data replaces it', async () => {
    const q = await mount(<charts.CashflowChart data={chartCashflow} />);
    await tapChart(q, 'Cashflow', 150);
    await q.rerender(<ThemeProvider initialMode="light"><charts.CashflowChart data={[{ date: '2026-09-01', sales: 42.25, expenses: 10.10 }]} /></ThemeProvider>);
    expect(queryChartReadout(q, 'Cashflow')).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Explore Cashflow values' }));
    expect(chartReadout(q, 'Cashflow').props.accessibilityLabel).toContain('PHP 42.25');
  });
  it('retains empty fallbacks without inventing values', async () => {
    const q = await mount(<><charts.CategoryBreakdown data={[]} /><charts.SpendTrend data={[]} /><charts.CashflowChart data={[]} /><charts.CategoryChange data={[]} /><charts.CoverageColumns data={[]} target={0} /><charts.DonutChart data={[]} /><charts.CategoryComparison data={[]} /><charts.CumulativeSalesChart points={[]} /></>);
    expect(q.queryAllByRole('button', { name: /^Explore / })).toHaveLength(0);
  });
  it('explores a single cumulative point safely', async () => {
    const q = await mount(<charts.CumulativeSalesChart points={[chartCumulative[0]!]} />);
    await tapChart(q, 'Sales vs. target', 150);
    expect(chartReadout(q, 'Sales vs. target').props.accessibilityLabel).toContain('Recorded sales: PHP 0.00');
    expect(q.getByRole('button', { name: 'Next value in Sales vs. target' }).props.accessibilityState.disabled).toBe(true);
  });
});
