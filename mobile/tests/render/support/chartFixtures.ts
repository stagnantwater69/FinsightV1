import type { CategoryTrend, DailyCoverageRow, RecoveryCheckpoint, RecoveryInsight } from '../../../src/lib/types';
import { legacyReportingPeriod } from '../../../src/lib/recoveryPeriodView';

export const chartCategories = [
  { categoryId: 10, categoryName: 'Stock', total: 750.25 },
  { categoryId: 11, categoryName: 'Rent', total: 250.75 },
];
export const chartTrends: CategoryTrend[] = [
  { categoryId: 10, categoryName: 'Stock', current: 750.25, previous: 500.75, change: 750.25 - 500.75, direction: 'up', percentChange: 49.83, recordCount: 4 },
  { categoryId: 11, categoryName: 'Rent', current: 250.75, previous: 300.25, change: 250.75 - 300.25, direction: 'down', percentChange: -16.49, recordCount: 2 },
];
export const chartDays = [
  { date: '2026-10-01', total: 150.25, count: 1 },
  { date: '2026-10-02', total: 0, count: 0 },
  { date: '2026-10-03', total: 500.5, count: 2 },
];
export const chartCashflow = [
  { date: '2026-10-01', sales: 1000.25, expenses: 250.75 },
  { date: '2026-10-02', sales: 0, expenses: 100.05 },
  { date: '2026-10-03', sales: 2250.75, expenses: 400.25 },
];
export const chartCumulative = [
  { date: '2026-10-01', sales: 0, target: 100.05, estimated: false },
  { date: '2026-10-02', sales: 300.25, target: 200.1, estimated: false },
  { date: '2026-10-03', sales: null, target: 350.5, estimated: true },
];
export const chartCoverage: DailyCoverageRow[] = [
  { date: '2026-10-01', sales: 0, neededTarget: 100.05, gap: -100.05, status: 'below', isOperatingDay: true },
  { date: '2026-10-02', sales: 0, neededTarget: null, gap: null, status: 'closed', isOperatingDay: false },
  { date: '2026-10-03', sales: 150.75, neededTarget: 150.75, gap: 0, status: 'at', isOperatingDay: true },
];
export const chartCheckpoints: RecoveryCheckpoint[] = [
  { endDate: '2026-10-02', cumulativeTarget: 200.25, recordedAmount: 100, variance: -100.25, status: 'behind' },
  { endDate: '2026-10-05', cumulativeTarget: 500.75, recordedAmount: null, variance: null, status: 'pending' },
];
export const chartRecovery: RecoveryInsight = {
  expectedMonthlyExpenses: 1000.5,
  operatingDays: 10,
  dailyNeededTarget: 100.05,
  salesThisMonth: 400.25,
  remainingTarget: 600.25,
  daysInMonth: 31,
  calendarDaysLeftInMonth: 28,
  remainingOperatingDays: 3,
  remainingOperatingDaysIsApproximated: false,
  adjustedDailyTarget: 200.08,
  todaysTarget: 150.75,
  todaysSales: 0,
  todaysGap: -150.75,
  todaysStatus: 'below',
  monthCoveragePercent: 40,
  onTrack: false,
  status: 'behind',
  monthStart: '2026-10-01',
  today: '2026-10-03',
  coverageDays: 3,
  dailyCoverage: chartCoverage,
  expectedSalesToDate: 450.75,
  paceVarianceAmount: -50.5,
  weeklyCheckpoints: chartCheckpoints,
};
export const chartPeriod = {
  ...legacyReportingPeriod(chartRecovery),
  start: '2026-10-01', end: '2026-10-05', asOfDate: '2026-10-03',
};
