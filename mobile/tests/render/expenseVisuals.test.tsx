import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';
import { CategoryBars, DailySpending, SpendHero, SpendingComparison } from '../../src/components/ExpenseVisuals';
import { ExpenseCloserLook, ExpenseGlance } from '../../src/components/ExpenseSummary';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { expenseSummaryFigures } from '../../src/lib/expenseSummary';
import type { CategoryTrend } from '../../src/lib/types';

const withTheme = (children: React.ReactNode) => (
  <ThemeProvider initialMode="light">{children}</ThemeProvider>
);

describe('Expense figures', () => {
  it('aggregates remaining current categories without losing their individual records or prior-only comparisons', async () => {
    const trends: CategoryTrend[] = [
      { categoryId: 10, categoryName: 'Stock', current: 500.5, previous: 400, change: 500.5 - 400, direction: 'up', percentChange: 25.125, recordCount: 5 },
      { categoryId: 11, categoryName: 'Utilities', current: 250.25, previous: 200, change: 250.25 - 200, direction: 'up', percentChange: 25.125, recordCount: 2 },
      { categoryId: 12, categoryName: 'Transport', current: 125.125, previous: 150, change: 125.125 - 150, direction: 'down', percentChange: -16.583, recordCount: 1 },
      { categoryId: 13, categoryName: 'Supplies', current: 75.075, previous: 50, change: 75.075 - 50, direction: 'up', percentChange: 50.15, recordCount: 1 },
      { categoryId: 14, categoryName: 'Repairs', current: 50.05, previous: 0, change: 50.05, direction: 'up', percentChange: null, recordCount: 1 },
      { categoryId: 15, categoryName: 'Prior rent', current: 0, previous: 300, change: -300, direction: 'down', percentChange: -100, recordCount: 0 },
    ];
    const onOpen = vi.fn();
    const queries = await render(withTheme(<CategoryBars trends={trends} total={1001} previousTotal={1100}
      comparedWith="August 2026" onOpen={onOpen} />));
    const distribution = queries.getByRole('image', { name: /^Category distribution\./ });
    expect(distribution.props.accessibilityLabel).toContain('Stock');
    expect(distribution.props.accessibilityLabel).toContain('50.0 percent');
    expect(distribution.props.accessibilityLabel).toContain('Other');
    expect(distribution.props.accessibilityLabel).toContain('PHP 125.13');
    expect(distribution.props.accessibilityLabel).toContain('12.5 percent');
    expect(distribution.props.accessibilityLabel).not.toContain('Prior rent');
    await fireEvent.press(queries.getByRole('button', { name: /^Other,/ }));
    expect(queries.getByRole('button', { name: 'Show fewer' }).props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(queries.getByRole('button', { name: /Repairs,.*View these records/ }));
    expect(onOpen).toHaveBeenLastCalledWith(14);
    expect(queries.getByRole('button', { name: /Prior rent,.*PHP 300\.00.*View these records/ })).toBeTruthy();
  });

  it('omits an unavailable record count instead of showing a recorded zero', async () => {
    const queries = await render(withTheme(<SpendHero total={500}
      recordCount={null} categoryCount={1} changeAmount={500}
      changePercent={null} comparedWith="August 2026" />));
    expect(queries.getByText('1 category')).toBeTruthy();
    expect(queries.getByText('PHP 500')).toBeTruthy();
    expect(queries.queryByText(/0 expenses/)).toBeNull();
    expect(queries.getByText('No expenses in August 2026 to compare.')).toBeTruthy();
    expect(queries.queryByText(/Spending is .*%/)).toBeNull();
  });

  it('names both comparison amounts and the exact reduction from the supplied totals', async () => {
    const queries = await render(withTheme(<>
      <SpendHero total={1200.5} recordCount={4} categoryCount={2} changeAmount={-300.25}
        changePercent={-20} comparedWith="August 2026" />
      <SpendingComparison total={1200.5} previousTotal={1500.75} period="September 2026" comparedWith="August 2026" />
    </>));
    expect(queries.getByText('20% lower')).toBeTruthy();
    expect(queries.getByLabelText('September 2026, PHP 1,200.50')).toBeTruthy();
    expect(queries.getByLabelText('August 2026, PHP 1,500.75')).toBeTruthy();
    expect(queries.getByText('PHP 300.25 less than August 2026')).toBeTruthy();
    expect(queries.queryByRole('image')).toBeNull();
  });

  it('does not invent a percentage for a category without earlier spending', async () => {
    const queries = await render(withTheme(<CategoryBars trends={[{
      categoryId: 7, categoryName: 'Stock', current: 300, previous: 0,
      change: 300, direction: 'up', percentChange: null, recordCount: 2,
    }]} total={1000} previousTotal={0} comparedWith="August 2026" onOpen={vi.fn()} />));
    await fireEvent.press(queries.getByRole('button', { name: 'All 1 category' }));
    expect(queries.getByText('No earlier expenses to compare')).toBeTruthy();
    expect(queries.queryByText(/\(.*%\)/)).toBeNull();
    expect(queries.getByRole('image', { name: 'Category distribution. Stock, PHP 300.00, 30.0 percent' })).toBeTruthy();
  });

  it('shows recorded zeros without inventing a comparison or record count', async () => {
    const queries = await render(withTheme(
      <SpendHero
        total={0}
        recordCount={0}
        categoryCount={0}
        changeAmount={0}
        changePercent={null}
        comparedWith="August 2026"
      />,
    ));

    expect(queries.getByRole('header', { name: 'Recorded expenses' })).toBeTruthy();
    expect(queries.getByText('PHP 0')).toBeTruthy();
    expect(queries.getByText('0 expenses · 0 categories')).toBeTruthy();
    expect(queries.getByText('No expenses in August 2026 to compare.')).toBeTruthy();
    expect(queries.queryByText('Spending unchanged')).toBeNull();
  });

  it('uses the overview total for category shares and names the previous amount', async () => {
    const onOpen = vi.fn();
    const queries = await render(withTheme(
      <CategoryBars
        trends={[{
          categoryId: 7,
          categoryName: 'Stock',
          current: 300,
          previous: 200,
          change: 100,
          direction: 'up',
          percentChange: 50,
          recordCount: 2,
        }]}
        total={1000}
        previousTotal={800}
        comparedWith="August 2026"
        onOpen={onOpen}
      />,
    ));

    await fireEvent.press(queries.getByRole('button', { name: 'All 1 category' }));
    expect(queries.getByText('30.0% · 2 expenses')).toBeTruthy();
    expect(queries.getByText('PHP 300.00')).toBeTruthy();
    expect(queries.getByText('Previous: PHP 200.00 · August 2026')).toBeTruthy();
    expect(queries.getByRole('image', { name: 'Category distribution. Stock, PHP 300.00, 30.0 percent' })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', {
      name: 'Stock, PHP 300.00, 30.0 percent of spending, 2 expenses. Previous PHP 200.00 in August 2026. PHP 100.00 more (50%). View these records.',
    }));
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it('distinguishes unavailable funds, a recorded zero balance, and a genuine zero spending share', async () => {
    const figures = (availableFunds: number | null) => withTheme(
      <ExpenseGlance
        summary={expenseSummaryFigures({
          totals: { current: 0, previous: 0 },
          categoryTrends: [],
          dailyTotals: [],
        }, availableFunds)}
        availableFunds={availableFunds}
        fundsLoading={false}
      />,
    );
    const queries = await render(figures(null));
    expect(queries.getByText('Funds unavailable')).toBeTruthy();
    expect(queries.queryByRole('progressbar')).toBeNull();

    await queries.rerender(figures(0));
    expect(queries.getByText('No balance')).toBeTruthy();
    expect(queries.queryByText('Funds unavailable')).toBeNull();
    expect(queries.queryByRole('progressbar')).toBeNull();

    await queries.rerender(figures(1000));
    expect(queries.getByText('0%')).toBeTruthy();
    expect(queries.getByLabelText('PHP 0.00 spent, 0% of PHP 1,000.00 recorded available funds')).toBeTruthy();
    expect(queries.getByRole('progressbar', {
      name: 'Spending as a share of recorded available funds',
    }).props.accessibilityValue.now).toBe(0);
  });

});

describe('Spending comparisons', () => {
  it.each([
    { total: 1250, previousTotal: 1000, percentage: 25, difference: 250, description: 'higher', direction: 'more' },
    { total: 750, previousTotal: 1000, percentage: -25, difference: -250, description: 'lower', direction: 'less' },
  ])('names a $description total with exact period amounts', async ({ total, previousTotal, percentage, difference, description, direction }) => {
    const q = await render(withTheme(<>
      <SpendHero total={total} recordCount={4} categoryCount={2} changePercent={percentage} changeAmount={difference} comparedWith="August 2026" />
      <SpendingComparison total={total} previousTotal={previousTotal} period="September 2026" comparedWith="August 2026" />
    </>));
    expect(q.getByText(`25% ${description}`)).toBeTruthy();
    expect(q.getByText(`PHP 250.00 ${direction} than August 2026`)).toBeTruthy();
    expect(q.getByLabelText(`September 2026, PHP ${total.toLocaleString('en-US')}.00`)).toBeTruthy();
    expect(q.getByLabelText('August 2026, PHP 1,000.00')).toBeTruthy();
    expect(q.queryByRole('image')).toBeNull();
  });

  it('keeps a zero previous amount without inventing a percentage', async () => {
    const q = await render(withTheme(<>
      <SpendHero total={500} recordCount={1} categoryCount={1} changePercent={null} changeAmount={500} comparedWith="August 2026" />
      <SpendingComparison total={500} previousTotal={0} period="September 2026" comparedWith="August 2026" />
    </>));
    expect(q.getByLabelText('August 2026, PHP 0.00')).toBeTruthy();
    expect(q.getByText('No expenses in August 2026 to compare.')).toBeTruthy();
    expect(q.queryByText(/% (higher|lower)/)).toBeNull();
  });

  it('names equal nonzero totals as unchanged rather than higher or lower', async () => {
    const q = await render(withTheme(<>
      <SpendHero total={500} recordCount={1} categoryCount={1} changePercent={0} changeAmount={0} comparedWith="August 2026" />
      <SpendingComparison total={500} previousTotal={500} period="September 2026" comparedWith="August 2026" />
    </>));
    expect(q.getByText('No change')).toBeTruthy();
    expect(q.getByText('Same total as the previous period')).toBeTruthy();
    expect(q.getByLabelText('September 2026, PHP 500.00')).toBeTruthy();
    expect(q.getByLabelText('August 2026, PHP 500.00')).toBeTruthy();
    expect(q.queryByText(/% (higher|lower)/)).toBeNull();
  });

  it('uses an unnamed previous period without fabricating dates or percentage change', async () => {
    const q = await render(withTheme(<>
      <SpendHero total={500} recordCount={null} categoryCount={1} changePercent={null} changeAmount={500} comparedWith={null} />
      <SpendingComparison total={500} previousTotal={0} period="This week" comparedWith={null} />
    </>));
    expect(q.getByLabelText('This week, PHP 500.00')).toBeTruthy();
    expect(q.getByLabelText('Previous period, PHP 0.00')).toBeTruthy();
    expect(q.getByText('No expenses in the previous period to compare.')).toBeTruthy();
    expect(q.queryByText(/% (higher|lower)/)).toBeNull();
  });
});

describe('Expense follow-up actions', () => {
  it.each([0, 3])('keeps review and recurring destinations usable with %i flagged expenses', async (flaggedCount) => {
    const onReview = vi.fn();
    const onRecurring = vi.fn();
    const q = await render(withTheme(<ExpenseCloserLook flaggedCount={flaggedCount} flaggedLoading={false} flaggedStale={false}
      overdueCount={2} recurringLoading={false} recurringStale={false} onReview={onReview} onRecurring={onRecurring} />));
    await fireEvent.press(q.getByRole('button', { name: new RegExp(`^Review flagged expenses\\. Business-wide expense flags.*${flaggedCount} flags$`) }));
    await fireEvent.press(q.getByRole('button', { name: 'Recurring expenses. 2 overdue' }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onRecurring).toHaveBeenCalledOnce();
  });

  it.each([
    { loading: true, status: 'Loading…' },
    { loading: false, status: 'Unavailable' },
  ])('labels unknown counts as $status instead of recorded zeros', async ({ loading, status }) => {
    const onReview = vi.fn();
    const onRecurring = vi.fn();
    const q = await render(withTheme(<ExpenseCloserLook flaggedCount={null} flaggedLoading={loading} flaggedStale={false}
      overdueCount={null} recurringLoading={loading} recurringStale={false} onReview={onReview} onRecurring={onRecurring} />));
    await fireEvent.press(q.getByRole('button', { name: `Review flagged expenses. Business-wide expense flags. ${status}` }));
    await fireEvent.press(q.getByRole('button', { name: new RegExp(`^Recurring expenses\\..*${status}$`) }));
    expect(q.queryByText('0')).toBeNull();
    expect(q.queryByText('All clear')).toBeNull();
    expect(onReview).toHaveBeenCalledOnce();
    expect(onRecurring).toHaveBeenCalledOnce();
  });

  it('identifies saved counts when refresh fails', async () => {
    const q = await render(withTheme(<ExpenseCloserLook flaggedCount={3} flaggedLoading={false} flaggedStale
      overdueCount={2} recurringLoading={false} recurringStale onReview={vi.fn()} onRecurring={vi.fn()} />));
    expect(q.getByRole('button', { name: /^Review flagged expenses\. Business-wide expense flags.*3 flags\. Saved data$/ })).toBeTruthy();
    expect(q.getByRole('button', { name: 'Recurring expenses. 2 overdue. Saved data' })).toBeTruthy();
    expect(q.getByText('3')).toBeTruthy();
    expect(q.getByText('2')).toBeTruthy();
  });
});

describe('Daily spending details', () => {
  it('selects a tapped day and reads exact daily or accumulated values without losing zero days', async () => {
    const queries = await render(withTheme(<DailySpending days={[
      { date: '2026-09-01', total: 150.25, count: 1 },
      { date: '2026-09-02', total: 0, count: 0 },
      { date: '2026-09-03', total: 500.5, count: 2 },
    ]} />));
    expect(queries.getByText('Sep 3 · Daily spending')).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Next day' }).props.accessibilityState.disabled).toBe(true);
    const plot = queries.getByRole('button', { name: /Daily spending chart/ });
    await fireEvent(plot, 'layout', { nativeEvent: { layout: { width: 300 } } });
    await fireEvent.press(plot, { nativeEvent: { locationX: 125 } });
    expect(queries.getByText('Sep 2 · Daily spending')).toBeTruthy();
    expect(queries.getByText('PHP 0.00')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Running total' }));
    expect(queries.getByRole('button', { name: 'Running total' }).props.accessibilityState.selected).toBe(true);
    expect(queries.getByText('Sep 2 · Running total')).toBeTruthy();
    expect(queries.getByText('PHP 150.25')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Next day' }));
    expect(queries.getByText('Sep 3 · Running total')).toBeTruthy();
    expect(queries.getByText('PHP 650.75')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Previous day' }));
    await fireEvent.press(queries.getByRole('button', { name: 'Previous day' }));
    expect(queries.getByText('Sep 1 · Running total')).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Previous day' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(queries.getByRole('button', { name: 'Daily' }));
    expect(queries.getByText('Sep 1 · Daily spending')).toBeTruthy();
    expect(queries.getByText('PHP 150.25')).toBeTruthy();
  });

  it.each([
    { days: [] },
    { days: [{ date: '2026-09-01', total: 0, count: 0 }, { date: '2026-09-02', total: 0, count: 0 }] },
  ])('does not present an empty period as a highest spending day ($days)', async ({ days }) => {
    const queries = await render(withTheme(<DailySpending days={days} />));

    expect(queries.getByText('No daily spending in this period.')).toBeTruthy();
    expect(queries.queryByRole('image')).toBeNull();
    expect(queries.queryByRole('button', { name: 'View daily amounts' })).toBeNull();
  });

  it('opens and closes every daily amount, including days with zero spending', async () => {
    const queries = await render(withTheme(
      <DailySpending days={[
        { date: '2026-09-01', total: 150, count: 1 },
        { date: '2026-09-02', total: 0, count: 0 },
        { date: '2026-09-03', total: 500, count: 2 },
      ]} />,
    ));

    expect(queries.getByRole('button', { name: /Daily spending chart/ }).props.accessibilityLabel).toContain('Highest: PHP 500.00 on Sep 3.');
    expect(queries.queryByText('PHP 150.00')).toBeNull();
    const show = queries.getByRole('button', { name: 'View daily amounts' });
    expect(show.props.accessibilityState.expanded).toBe(false);
    await fireEvent.press(show);
    expect(queries.getByText('PHP 150.00')).toBeTruthy();
    expect(queries.getByText('Sep 2')).toBeTruthy();
    expect(queries.getByText('PHP 0.00')).toBeTruthy();
    expect(queries.getAllByText('PHP 500.00')).toHaveLength(3);
    const hide = queries.getByRole('button', { name: 'Hide daily amounts' });
    expect(hide.props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(hide);
    expect(queries.queryByText('PHP 150.00')).toBeNull();
    expect(queries.queryByText('PHP 0.00')).toBeNull();
  });
});
