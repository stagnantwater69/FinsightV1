import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';
import { ExpenseSummaryCard } from '../../src/components/ExpenseSummary';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { expenseSummaryFigures, expenseSummaryPoints } from '../../src/lib/expenseSummary';
import type { CategoryTrend } from '../../src/lib/types';

const trends: CategoryTrend[] = [
  { categoryId: 1, categoryName: 'Rent', current: 4500, previous: 4500, change: 0, direction: 'flat', percentChange: 0, recordCount: 1 },
  { categoryId: 2, categoryName: 'Inventory', current: 731, previous: 459, change: 731 - 459, direction: 'up', percentChange: 59.3, recordCount: 1 },
  { categoryId: 3, categoryName: 'Raw Materials', current: 960, previous: 18603, change: 960 - 18603, direction: 'down', percentChange: -94.8, recordCount: 3 },
];

function renderCard(flaggedCount: number, onReviewFlags = vi.fn()) {
  const summary = expenseSummaryFigures({ totals: { current: 6191, previous: 23562 }, categoryTrends: trends, dailyTotals: [] }, null);
  const ctx = { periodText: 'in October 2026', comparedWith: 'Sep 1-11', allTime: false, flaggedCount, unusualCount: 0 };
  return render(
    <ThemeProvider initialMode="light">
      <ExpenseSummaryCard
        points={expenseSummaryPoints(summary, ctx)}
        summary={summary}
        comparedWith="Sep 1-11"
        flaggedCount={flaggedCount}
        unusualCount={0}
        questions={[]}
        onAsk={vi.fn()}
        onReviewFlags={flaggedCount > 0 ? onReviewFlags : undefined}
      />
    </ThemeProvider>,
  );
}

describe('ExpenseSummaryCard', () => {
  it('leads each point with a figure and keeps the full sentence as its spoken label', async () => {
    const queries = await renderCard(78);
    expect(queries.getByText('73%')).toBeTruthy();
    expect(queries.getByText('+PHP 272')).toBeTruthy();
    expect(queries.getByText('74%')).toBeTruthy();
    expect(queries.getByText('less than Sep 1-11')).toBeTruthy();
    expect(queries.getByText('78')).toBeTruthy();
    expect(queries.getByLabelText(/Rent is your highest expense category in October 2026: 72\.7% of expenses\./)).toBeTruthy();
    expect(queries.getByLabelText(/Total spending is 74% lower than Sep 1-11\./)).toBeTruthy();
  });

  it('opens the flagged records from the review tile', async () => {
    const onReviewFlags = vi.fn();
    const queries = await renderCard(78, onReviewFlags);
    await fireEvent.press(queries.getByRole('button', { name: /78 expenses to review/ }));
    expect(onReviewFlags).toHaveBeenCalledTimes(1);
  });

  it('drops the review tile when nothing is flagged', async () => {
    const queries = await renderCard(0);
    expect(queries.queryByRole('button', { name: /to review/ })).toBeNull();
    expect(queries.queryByText('to review')).toBeNull();
  });
});
