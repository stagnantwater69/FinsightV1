import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { CategoryBars, DailySpending, SpendingComparison } from '../../src/components/ExpenseVisuals';
import { MoneyFlowPanel, SpendingSplitCard, TodayGoalSummary } from '../../src/components/HomeVisuals';
import { CheckpointFlags, DailyTargetBreakdown, DayCalendar, RecoveryCoachCard, TodayGoalCard } from '../../src/components/RecoveryVisuals';
import { RecoveryMeter } from '../../src/components/RecoveryMeter';
import { RecoveryPaceCard, RecoveryTodayCard, RecoveryTargetBreakdown } from '../../src/components/RecoveryPeriodCards';
import { ExpenseGlance, ExpenseSummaryCard } from '../../src/components/ExpenseSummary';
import { expenseSummaryFigures, expenseSummaryPoints } from '../../src/lib/expenseSummary';
import { chartReadout, hoverChart, queryChartReadout, tapChart } from './support/chartInteractions';
import { chartCategories, chartCheckpoints, chartCoverage, chartDays, chartPeriod, chartRecovery, chartTrends } from './support/chartFixtures';
const mount = (node: React.ReactNode) => render(<ThemeProvider initialMode="light">{node}</ThemeProvider>);
const summary = expenseSummaryFigures({ totals: { current: 1001, previous: 801 }, categoryTrends: chartTrends, dailyTotals: chartDays }, 2000.5);

describe('Expense chart exploration', () => {
  it('selects comparison rows and preserves exact earlier/current periods', async () => {
    const q = await mount(<SpendingComparison total={1001} previousTotal={801.25} period="October 2026" comparedWith="September 2026" />);
    await fireEvent.press(q.getByRole('button', { name: 'September 2026, PHP 801.25' }));
    expect(chartReadout(q, 'Spending comparison').props.accessibilityLabel).toContain('September 2026');
    expect(chartReadout(q, 'Spending comparison').props.accessibilityLabel).toContain('PHP 801.25');
  });
  it('selects donut values without triggering category drilldown, which remains available', async () => {
    const open = vi.fn();
    const q = await mount(<CategoryBars trends={chartTrends} total={1001} previousTotal={801} comparedWith="September" onOpen={open} />);
    await tapChart(q, 'Category distribution', 18, 36, 112, 112);
    expect(chartReadout(q, 'Category distribution').props.accessibilityLabel).toContain('Rent');
    expect(open).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole('button', { name: 'All 2 categories' }));
    await tapChart(q, 'Stock comparison');
    expect(chartReadout(q, 'Category comparison').props.accessibilityLabel).toContain('PHP 750.25');
    expect(chartReadout(q, 'Category comparison').props.accessibilityLabel).toContain('PHP 500.75');
    await fireEvent.press(q.getAllByRole('button', { name: /Stock,.*View these records/ })[0]!);
    expect(open).toHaveBeenCalledWith(10);
  });
  it('retains the original selected day after hover and preserves it when changing daily/running mode', async () => {
    const q = await mount(<DailySpending days={chartDays} />);
    const plot = q.getByRole('button', { name: /^Daily spending chart/ });
    await fireEvent(plot, 'layout', { nativeEvent: { layout: { width: 300, height: 120 } } });
    await fireEvent(plot, 'hoverIn', { nativeEvent: { locationX: 125, locationY: 60 } });
    expect(q.getByText(/Oct 2.*Daily spending/)).toBeTruthy();
    await fireEvent(plot, 'hoverOut');
    expect(q.getByText(/Oct 3.*Daily spending/)).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Running total' }));
    expect(q.getByText(/Oct 3.*Running total/)).toBeTruthy();
    expect(q.getByText('PHP 650.75')).toBeTruthy();
  });
  it('does not select an unpainted category arc when the overview total includes other spending', async () => {
    const q = await mount(<CategoryBars trends={[{ ...chartTrends[0]!, current: 300 }]} total={1000} previousTotal={500.75} comparedWith="September" onOpen={vi.fn()} />);
    await tapChart(q, 'Category distribution', 84, 28, 112, 112);
    expect(chartReadout(q, 'Category distribution').props.accessibilityLabel).toContain('Stock');
    await fireEvent.press(q.getByRole('button', { name: 'Clear Category distribution value' }));
    await hoverChart(q, 'Category distribution', 20, 76);
    expect(queryChartReadout(q, 'Category distribution')).toBeNull();
  });
  it('explores glance rings and summary comparison bars with named figures', async () => {
    const q = await mount(<><ExpenseGlance summary={summary} availableFunds={2000.5} fundsLoading={false} /><ExpenseSummaryCard summary={summary} points={expenseSummaryPoints(summary, { periodText: 'in October', comparedWith: 'September', allTime: false, flaggedCount: 0, unusualCount: 0 })} comparedWith="September" flaggedCount={0} unusualCount={0} questions={[]} onAsk={vi.fn()} /></>);
    await fireEvent.press(q.getByRole('button', { name: 'Explore Spending at a glance values' }));
    expect(chartReadout(q, 'Spending at a glance').props.accessibilityLabel).toContain('Recorded available funds: PHP 2,000.50');
    await tapChart(q, 'Largest spending category');
    expect(chartReadout(q, 'Spending at a glance').props.accessibilityLabel).toContain('Stock');
    await tapChart(q, 'Largest category share');
    expect(chartReadout(q, 'Expense summary').props.accessibilityLabel).toContain('PHP 750.25');
    await tapChart(q, 'Summary spending comparison');
    expect(chartReadout(q, 'Expense summary').props.accessibilityLabel).toContain('Current period: PHP 1,001.00. September: PHP 801.00');
  });
  it('does not present unavailable funds as zero', async () => {
    const missing = expenseSummaryFigures({ totals: { current: 1001, previous: 801 }, categoryTrends: chartTrends, dailyTotals: [] }, null);
    const q = await mount(<ExpenseGlance summary={missing} availableFunds={null} fundsLoading />);
    await fireEvent.press(q.getByRole('button', { name: 'Explore Spending at a glance values' }));
    expect(chartReadout(q, 'Spending at a glance').props.accessibilityLabel).toContain('Loading funds');
    expect(chartReadout(q, 'Spending at a glance').props.accessibilityLabel).not.toContain('PHP 0.00');
  });
});

describe('Home chart exploration', () => {
  it('explores both money-flow marks with exact cents and keeps provenance disclosure', async () => {
    const q = await mount(<MoneyFlowPanel sales={1000.25} expenses={250.75} funds={2000.50} periodPhrase="in October" provenance="Opening funds plus sales, less expenses" salesDelta={null} expensesDelta={null} netDelta={null} against={null} />);
    await fireEvent.press(q.getByRole('button', { name: /^Money in values,/ }));
    expect(chartReadout(q, 'Money flow').props.accessibilityLabel).toContain('Recorded sales: PHP 1,000.25');
    await fireEvent(q.getByRole('button', { name: /^Money out values,/ }), 'hoverIn');
    expect(chartReadout(q, 'Money flow').props.accessibilityLabel).toContain('Recorded expenses: PHP 250.75');
    await fireEvent(q.getByRole('button', { name: /^Money out values,/ }), 'hoverOut');
    expect(chartReadout(q, 'Money flow').props.accessibilityLabel).toContain('Recorded sales');
    await fireEvent.press(q.getByRole('button', { name: 'How available funds are worked out' }));
    expect(q.getByText('Opening funds plus sales, less expenses')).toBeTruthy();
  });
  it('explores day/month goal figures without opening recovery', async () => {
    const open = vi.fn();
    const q = await mount(<TodayGoalSummary recovery={chartRecovery} statusLabel="Below target" tone="critical" basisNote="Monthly estimate" onOpenRecovery={open} action={null} />);
    await tapChart(q, "Today's sales goal");
    expect(chartReadout(q, 'Sales goals').props.accessibilityLabel).toContain('Sales recorded: PHP 0.00');
    expect(chartReadout(q, 'Sales goals').props.accessibilityLabel).toContain("Today's target: PHP 150.75");
    await tapChart(q, 'Monthly expenses covered by sales');
    expect(chartReadout(q, 'Sales goals').props.accessibilityLabel).toContain('Expense basis: PHP 1,000.50');
    expect(open).not.toHaveBeenCalled();
  });
  it('maps spending segments by amount and retains navigation actions', async () => {
    const trends = vi.fn(); const flow = vi.fn();
    const q = await mount(<SpendingSplitCard rows={chartCategories} onTrends={trends} onMoneyFlow={flow} />);
    await tapChart(q, 'Spending split', 280);
    expect(chartReadout(q, 'Spending split').props.accessibilityLabel).toContain('Rent. Spending: PHP 250.75');
    expect(chartReadout(q, 'Spending split').props.accessibilityLabel).toContain('25.0%');
    expect(trends).not.toHaveBeenCalled(); expect(flow).not.toHaveBeenCalled();
  });
});

describe('Recovery chart exploration', () => {
  it('explores coverage and current day, retaining progressbar summaries', async () => {
    const q = await mount(<><RecoveryCoachCard data={chartRecovery} period={chartPeriod} isCurrentMonth /><TodayGoalCard data={chartRecovery} /></>);
    await tapChart(q, 'Sales coverage');
    expect(chartReadout(q, 'Sales coverage').props.accessibilityLabel).toContain('Sales recorded: PHP 400.25');
    expect(chartReadout(q, 'Sales coverage').props.accessibilityLabel).toContain('Sales coverage target: PHP 1,000.50');
    await tapChart(q, "Today's goal");
    expect(chartReadout(q, "Today's goal").props.accessibilityLabel).toContain('Sales recorded: PHP 0.00');
    expect(q.getAllByRole('progressbar')).toHaveLength(2);
  });
  it('keeps calendar closed/future days distinct and preserves the existing day modal', async () => {
    const q = await mount(<DayCalendar period={chartPeriod} rows={chartCoverage} />);
    await fireEvent.press(q.getByRole('button', { name: 'Explore Daily coverage values' }));
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).toContain('Sales recorded: PHP 0.00');
    await fireEvent.press(q.getByRole('button', { name: 'Next value in Daily coverage' }));
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).toContain('Closed day');
    await fireEvent.press(q.getByRole('button', { name: 'Next value in Daily coverage' }));
    await fireEvent.press(q.getByRole('button', { name: 'Next value in Daily coverage' }));
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).toContain('Future day');
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).not.toContain('Sales recorded: PHP 0.00');
    await fireEvent.press(q.getByRole('button', { name: /^Thu, Oct 1,/ }));
    expect(q.getByRole('button', { name: 'Done' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Explore Sold values' }));
    expect(chartReadout(q, 'Sold').props.accessibilityLabel).toContain('Sold: PHP 0.00');
    await fireEvent.press(q.getByRole('button', { name: 'Explore Target values' }));
    expect(chartReadout(q, 'Target').props.accessibilityLabel).toContain('PHP 100.05');
    await fireEvent.press(q.getByRole('button', { name: 'Done' }));
    expect(q.queryByRole('button', { name: 'Done' })).toBeNull();
  });
  it.each(['mouse', 'pen'])('previews a disabled future calendar cell through its parent for %s and restores the pinned day', async (pointerType) => {
    const rows = [...chartCoverage, { date: '2026-10-04', sales: 0, neededTarget: 200.05, gap: -200.05, status: 'below' as const, isOperatingDay: true }];
    const q = await mount(<DayCalendar period={chartPeriod} rows={rows} />);
    await fireEvent.press(q.getByRole('button', { name: 'Explore Daily coverage values' }));
    const future = q.getByRole('button', { name: 'Sun, Oct 4, not yet recorded' });
    expect(future.props.accessibilityState.disabled).toBe(true);
    expect(future.props.accessibilityLabel).not.toContain('sold');
    let cell = future.parent;
    while (cell && !cell.props.onPointerEnter) cell = cell.parent;
    if (!cell) throw new Error('Future calendar cell has no parent pointer handler');
    await fireEvent(cell, 'pointerEnter', { nativeEvent: { pointerType, buttons: 0 } });
    const name = chartReadout(q, 'Daily coverage').props.accessibilityLabel;
    expect(name).toContain('Sun, Oct 4');
    expect(name).toContain('Sales recorded: Not yet recorded');
    expect(name).toContain('Daily target: PHP 200.05');
    expect(name).not.toContain('Sales recorded: PHP 0.00');
    await fireEvent.press(future);
    expect(q.queryByRole('button', { name: 'Done' })).toBeNull();
    await fireEvent(cell, 'pointerLeave', { nativeEvent: { pointerType } });
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).toContain('Thu, Oct 1');
    expect(chartReadout(q, 'Daily coverage').props.accessibilityLabel).toContain('Sales recorded: PHP 0.00');
  });
  it('ignores touch and pressed mouse movement over a future calendar cell', async () => {
    const q = await mount(<DayCalendar period={chartPeriod} rows={chartCoverage} />);
    const future = q.getByRole('button', { name: 'Sun, Oct 4, not yet recorded' });
    let cell = future.parent;
    while (cell && !cell.props.onPointerEnter) cell = cell.parent;
    if (!cell) throw new Error('Future calendar cell has no parent pointer handler');
    await fireEvent(cell, 'pointerEnter', { nativeEvent: { pointerType: 'touch', buttons: 0 } });
    expect(queryChartReadout(q, 'Daily coverage')).toBeNull();
    await fireEvent(cell, 'pointerEnter', { nativeEvent: { pointerType: 'mouse', buttons: 1 } });
    expect(queryChartReadout(q, 'Daily coverage')).toBeNull();
    await fireEvent.press(future);
    expect(q.queryByRole('button', { name: 'Done' })).toBeNull();
  });
  it('explores checkpoint marks with pending values and status', async () => {
    const q = await mount(<CheckpointFlags checkpoints={chartCheckpoints} today="2026-10-03" />);
    const marks = q.getAllByRole('button', { name: /^Checkpoint / });
    await fireEvent.press(marks[0]!);
    expect(chartReadout(q, 'Weekly checkpoints').props.accessibilityLabel).toContain('Cumulative target: PHP 200.25. Sales recorded: PHP 100.00');
    await fireEvent(marks[1]!, 'hoverIn');
    expect(chartReadout(q, 'Weekly checkpoints').props.accessibilityLabel).toContain('Checkpoint ahead');
    await fireEvent(marks[1]!, 'hoverOut');
    expect(chartReadout(q, 'Weekly checkpoints').props.accessibilityLabel).toContain('Behind target');
  });
  it('names remaining target and estimated operating-day tiles', async () => {
    const q = await mount(<DailyTargetBreakdown period={{ ...chartPeriod, operatingDaysIsApproximated: true }} />);
    await tapChart(q, 'Remaining target breakdown');
    expect(chartReadout(q, 'Daily target breakdown').props.accessibilityLabel).toContain('Remaining target: PHP 600.25');
    await tapChart(q, 'Remaining operating days');
    expect(chartReadout(q, 'Daily target breakdown').props.accessibilityLabel).toMatch(/Operating days: .*3 days/);
    expect(chartReadout(q, 'Daily target breakdown').props.accessibilityLabel).toContain('Operating days are estimated');
  });
  it('explores legacy meter, pace, today and target breakdown charts', async () => {
    const q = await mount(<><RecoveryMeter data={chartRecovery} /><RecoveryPaceCard period={chartPeriod} /><RecoveryTodayCard data={chartRecovery} /><RecoveryTargetBreakdown sales={400.25} target={1000.50} /></>);
    for (const [label, amount] of [['Month-to-date coverage', '400.25'], ["Today's progress", '150.75'], ['Period sales coverage', '1,000.50'], ["Today's sales coverage", '150.75'], ['Target breakdown', '600.25']]) {
      await fireEvent.press(q.getByRole('button', { name: `Explore ${label} values` }));
      expect(chartReadout(q, label!).props.accessibilityLabel).toContain(amount);
    }
  });
  it('resets a recovery value when period boundaries change with equal totals', async () => {
    const q = await mount(<RecoveryCoachCard data={chartRecovery} period={chartPeriod} isCurrentMonth />);
    await tapChart(q, 'Sales coverage');
    await q.rerender(<ThemeProvider initialMode="light"><RecoveryCoachCard data={chartRecovery} period={{ ...chartPeriod, start: '2026-09-01', end: '2026-09-05' }} isCurrentMonth={false} /></ThemeProvider>);
    expect(queryChartReadout(q, 'Sales coverage')).toBeNull();
  });
});
