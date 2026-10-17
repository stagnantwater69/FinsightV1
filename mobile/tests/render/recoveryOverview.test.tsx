import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react-native';
import { RecoveryCoachCard, RecoveryNextGoal } from '../../src/components/RecoveryVisuals';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { legacyReportingPeriod } from '../../src/lib/recoveryPeriodView';
import type { RecoveryInsight, RecoveryReportingPeriod } from '../../src/lib/types';

const insight: RecoveryInsight = {
  expectedMonthlyExpenses: 40000,
  operatingDays: 26,
  dailyNeededTarget: 1538,
  salesThisMonth: 18000,
  remainingTarget: 22000,
  daysInMonth: 31,
  calendarDaysLeftInMonth: 16,
  remainingOperatingDays: 10,
  remainingOperatingDaysIsApproximated: false,
  adjustedDailyTarget: 2200,
  todaysTarget: 2200,
  todaysSales: 900,
  todaysGap: -1300,
  todaysStatus: 'below',
  monthCoveragePercent: 45,
  onTrack: false,
  status: 'behind',
  monthStart: '2026-08-01',
  today: '2026-08-15',
  coverageDays: 14,
  dailyCoverage: [],
  monthHasNoRecords: false,
  latestSaleDate: '2026-07-30',
  expectedSalesToDate: 24000,
  paceVarianceAmount: -6000,
};

const basePeriod = legacyReportingPeriod(insight);
const themed = (node: React.ReactNode) => <ThemeProvider initialMode="light">{node}</ThemeProvider>;

describe('Recovery overview', () => {
  it('uses server coverage, sales, pace and daily target values without a mascot', async () => {
    const period = { ...basePeriod, coveragePercent: 47 };
    const q = await render(themed(<>
      <RecoveryCoachCard data={insight} period={period} isCurrentMonth />
      <RecoveryNextGoal period={period} />
    </>));
    expect(q.getByText('47% reached')).toBeTruthy();
    const progress = q.getByRole('progressbar', { name: "Sales coverage: PHP 18,000 recorded against PHP 40,000 target. Today's pace: PHP 24,000" });
    expect(progress.props.accessibilityValue.now).toBe(47);
    expect(q.getByText("Today's pace · PHP 24,000")).toBeTruthy();
    expect(q.getByText('PHP 2,200 / day')).toBeTruthy();
    expect(q.getByText("PHP 6,000 behind today's pace")).toBeTruthy();
    expect(q.getByText('10 operating days')).toBeTruthy();
    expect(q.queryByRole('image')).toBeNull();
  });

  it('keeps coverage above 100 visible while bounding the progress value', async () => {
    const period = { ...basePeriod, sales: 44000, remainingTarget: 0, coveragePercent: 110, status: 'covered' as const };
    const q = await render(themed(<RecoveryCoachCard data={{ ...insight, status: 'covered' }} period={period} isCurrentMonth />));
    expect(q.getByText('110% reached')).toBeTruthy();
    expect(q.getByRole('progressbar').props.accessibilityValue.now).toBe(100);
    expect(q.getByText('Sales coverage target reached')).toBeTruthy();
  });

  it.each([
    { overrides: { status: 'needs_setup' as const }, label: "Recovery Target isn't ready yet" },
    { overrides: { target: 0 }, label: 'Behind pace' },
  ])('does not draw an undefined target when $label', async ({ overrides }) => {
    const period = { ...basePeriod, ...overrides };
    const q = await render(themed(<>
      <RecoveryCoachCard data={insight} period={period} isCurrentMonth={false} />
      <RecoveryNextGoal period={period} />
    </>));
    expect(q.getByText('Add a monthly expense estimate to calculate your target.')).toBeTruthy();
    expect(q.queryByRole('progressbar')).toBeNull();
    expect(q.queryByRole('header', { name: 'What to aim for next' })).toBeNull();
  });

  it('identifies no current sales and the latest recorded sale without a pace marker', async () => {
    const period = { ...basePeriod, sales: 0, coveragePercent: 0, status: 'no_data' as const };
    const q = await render(themed(<RecoveryCoachCard data={{ ...insight, monthHasNoRecords: true, status: 'no_current_month_data' }} period={period} isCurrentMonth />));
    expect(q.getByText('No sales recorded yet this month')).toBeTruthy();
    expect(q.getByText('Add a sale to start tracking. Your latest sale was July 30, 2026.')).toBeTruthy();
    expect(q.queryByText(/Today's pace ·/)).toBeNull();
    expect(q.getByRole('progressbar').props.accessibilityValue.now).toBe(0);
  });

  it.each([
    { status: 'ahead' as const, label: 'Ahead of pace' },
    { status: 'behind' as const, label: 'Behind pace' },
  ])('preserves the selected-period $status status', async ({ status, label }) => {
    const q = await render(themed(<RecoveryCoachCard data={insight} period={{ ...basePeriod, status }} isCurrentMonth={false} />));
    expect(q.getByText(label)).toBeTruthy();
  });

  it('shows a completed historical result without today markers or catch-up goals', async () => {
    const period = { ...basePeriod, isCurrent: false, isComplete: true };
    const q = await render(themed(<>
      <RecoveryCoachCard data={insight} period={period} isCurrentMonth={false} />
      <RecoveryNextGoal period={period} />
    </>));
    expect(q.getByText('Finished below target')).toBeTruthy();
    expect(q.getByText('Period result')).toBeTruthy();
    expect(q.getByText('short of target')).toBeTruthy();
    expect(q.getByText('August 2026')).toBeTruthy();
    expect(q.queryByText('Still to sell')).toBeNull();
    expect(q.queryByText(/Today's pace ·/)).toBeNull();
    expect(q.queryByRole('header', { name: 'What to aim for next' })).toBeNull();
  });

  it('uses the weekly response for its daily goal and gap', async () => {
    const period: RecoveryReportingPeriod = { ...basePeriod, kind: 'week', month: null, target: 1000, sales: 300,
      remainingTarget: 700, coveragePercent: 30, expectedSalesToDate: 700, paceVarianceAmount: -400,
      remainingOperatingDays: 2, adjustedDailyTarget: 350 };
    const q = await render(themed(<>
      <RecoveryCoachCard data={insight} period={period} isCurrentMonth={false} />
      <RecoveryNextGoal period={period} />
    </>));
    expect(q.getByText('of PHP 1,000 sales coverage target')).toBeTruthy();
    expect(q.getByText('PHP 350 / day')).toBeTruthy();
    expect(q.getByText('Sales needed per remaining operating day to reach the weekly target.')).toBeTruthy();
    expect(q.getByText("PHP 400 behind today's pace")).toBeTruthy();
    expect(q.queryByText('PHP 2,200 / day')).toBeNull();
  });
});

describe('Recovery next goal safeguards', () => {
  it.each<Partial<RecoveryReportingPeriod>>([
    { isCurrent: false },
    { remainingOperatingDays: 0 },
    { expectedSalesToDate: 0 },
    { paceVarianceAmount: 0 },
    { status: 'ahead' },
    { status: 'no_data' },
    { status: 'covered', remainingTarget: 0 },
  ])('does not claim a catch-up amount when the period is ineligible: %j', async (overrides) => {
    const q = await render(themed(<RecoveryNextGoal period={{ ...basePeriod, ...overrides }} />));
    expect(q.queryByText(/behind today's pace/)).toBeNull();
  });

  it('distinguishes an unavailable daily target from zero remaining operating days', async () => {
    const q = await render(themed(<RecoveryNextGoal period={{ ...basePeriod, adjustedDailyTarget: null }} />));
    expect(q.getByText('Daily target unavailable')).toBeTruthy();
    expect(q.queryByText('No operating days remaining')).toBeNull();
    await q.rerender(themed(<RecoveryNextGoal period={{ ...basePeriod, remainingOperatingDays: 0 }} />));
    expect(q.getByText('No operating days remaining')).toBeTruthy();
    expect(q.queryByText(/PHP .* \/ day/)).toBeNull();
  });

  it('keeps a reached goal from prompting additional sales', async () => {
    const q = await render(themed(<RecoveryNextGoal period={{ ...basePeriod, status: 'covered', remainingTarget: 0 }} />));
    expect(q.getByText('Sales coverage target reached')).toBeTruthy();
    expect(q.getByText("Recorded sales cover this period's expense basis.")).toBeTruthy();
    expect(q.queryByText(/PHP .* \/ day/)).toBeNull();
    expect(q.queryByText(/behind today's pace/)).toBeNull();
  });
});
