import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecoveryCheckpoint, RecoveryInsight, RecoveryTargets } from '../../src/lib/types';

/**
 * Recovery Target Phase 1 (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §8.1) — the
 * server's explicit `status` field is now authoritative over the old
 * `onTrack`/`needsSetup` booleans. `no_current_month_data`, `covered` and
 * `ahead` have no boolean equivalent at all, so they are the cases most at
 * risk of silently falling back to a wrong boolean-derived treatment.
 */

const { RecoveryMeter } = await import('../../src/components/RecoveryMeter');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const withTheme = (node: React.ReactNode) => <ThemeProvider initialMode="light">{node}</ThemeProvider>;

const baseTargets: RecoveryTargets = {
  expectedMonthlyExpenses: 40000,
  operatingDays: 26,
  dailyNeededTarget: 1538,
  salesThisMonth: 18000,
  remainingTarget: 22000,
  daysInMonth: 30,
  calendarDaysLeftInMonth: 12,
  remainingOperatingDays: 10,
  remainingOperatingDaysIsApproximated: false,
  adjustedDailyTarget: 2200,
  todaysTarget: 2200,
  todaysSales: 900,
  todaysGap: -1300,
  todaysStatus: 'below',
  monthCoveragePercent: 45,
  onTrack: false,
};

describe('RecoveryMeter — status-driven rendering', () => {
  it('shows a distinct informational treatment for no_current_month_data, not the boolean fallback', async () => {
    const queries = await render(
      withTheme(<RecoveryMeter data={{ ...baseTargets, status: 'no_current_month_data', onTrack: false, needsSetup: false }} />),
    );
    expect(queries.getByText('No sales recorded yet this month')).toBeTruthy();
    // Must not fall back to the boolean-derived "behind" copy.
    expect(queries.queryByText('Behind pace for the month')).toBeNull();
  });

  it('shows the "target reached" copy for covered, distinct from plain on-pace', async () => {
    const queries = await render(
      withTheme(<RecoveryMeter data={{ ...baseTargets, status: 'covered', onTrack: true, needsSetup: false }} />),
    );
    expect(queries.getByText('Sales coverage target reached')).toBeTruthy();
    expect(queries.queryByText('On pace for the month')).toBeNull();
  });

  it('shows "Ahead of pace" for ahead, distinct from plain on-pace', async () => {
    const queries = await render(
      withTheme(<RecoveryMeter data={{ ...baseTargets, status: 'ahead', onTrack: true, needsSetup: false }} />),
    );
    expect(queries.getByText('Ahead of pace')).toBeTruthy();
    expect(queries.queryByText('On pace for the month')).toBeNull();
  });

  it('falls back to the old onTrack/needsSetup booleans when status is undefined (older/cached response)', async () => {
    const queries = await render(withTheme(<RecoveryMeter data={{ ...baseTargets, onTrack: false }} />));
    expect(queries.getByText('Behind pace for the month')).toBeTruthy();

    const onTrackQueries = await render(withTheme(<RecoveryMeter data={{ ...baseTargets, onTrack: true }} />));
    expect(onTrackQueries.getByText('On pace for the month')).toBeTruthy();

    const needsSetupQueries = await render(
      withTheme(<RecoveryMeter data={{ ...baseTargets, onTrack: false, needsSetup: true }} />),
    );
    expect(needsSetupQueries.getByText("Recovery Target isn't ready yet")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- RecoveryTargetScreen

const apiGet = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: fixtures.businessProfile,
    categories: fixtures.categories,
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories: vi.fn(),
    createCategory: vi.fn(),
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../src/context/AiChatContext', () => ({
  useAiChat: () => ({ prepareQuestion: vi.fn() }),
}));
vi.mock('../../src/components/AskFinSight', () => ({ AskFinSight: () => null }));
vi.mock('../../src/components/AskFinSightFab', () => ({ AskFinSightFab: () => null, FAB_CLEARANCE: 0 }));

// DateField's own DateTimePicker dialog is native UI with no render-harness
// coverage (see tests/render/README.md) — same stub as
// tests/render/operatingSchedule.test.tsx. RecoveryTargetScreen only reaches
// it through the §7.5 saved-plan edit form, which none of these tests open.
vi.mock('../../src/components/DateField', () => ({
  DateField: ({ label, value, onChange }: { label: string; value: string; onChange: (iso: string) => void }) => {
    const { TextInput } = require('react-native');
    return React.createElement(TextInput, {
      accessibilityLabel: label,
      value,
      onChangeText: onChange,
    });
  },
}));

const baseInsight: RecoveryInsight = {
  ...baseTargets,
  monthStart: '2026-08-01',
  today: '2026-08-15',
  coverageDays: 14,
  dailyCoverage: [],
  monthHasNoRecords: false,
  latestSaleDate: '2026-08-14',
};

const navigation = { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() };

async function renderScreen(insight: RecoveryInsight) {
  apiGet.mockImplementation((path: string) => {
    if (path === '/insights/recovery') return Promise.resolve(insight);
    // §7.5 saved-plan lookup, fetched alongside the main load — absent by
    // default in these tests, none of which are about it.
    if (path.endsWith('/recovery-plans')) return Promise.resolve([]);
    if (path === '/records/months') return Promise.resolve({ months: [] });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  const { RecoveryTargetScreen } = await import('../../src/screens/RecoveryTargetScreen');
  return render(
    <ThemeProvider initialMode="light">
      <RecoveryTargetScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
});

describe('RecoveryTargetScreen — terminology and freshness', () => {
  it('keeps the required Sales Coverage Target definition one tap away, before the first status', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    await queries.findByText('Behind pace for the month');
    await fireEvent.press(queries.getByRole('button', { name: 'About the recovery target' }));
    expect(await queries.findByText('About this target')).toBeTruthy();
    expect(
      queries.getByText('Your Sales Coverage Target compares recorded sales references with your expected monthly expense amount.'),
    ).toBeTruthy();
    expect(
      queries.getByText('It is a planning guide and does not calculate profit, cash flow, or formal break-even.'),
    ).toBeTruthy();
  });

  it('shows the as-of date on the status card, and the full date and timezone in the definition sheet', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'on_pace',
      asOfDate: '2026-08-15',
      timezone: 'Asia/Manila',
    });
    expect(await queries.findByText('As of Aug 15')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'About the recovery target' }));
    expect(await queries.findByText('As of August 15, 2026 · Asia/Manila time')).toBeTruthy();
  });

  it('renders nothing extra for freshness when asOfDate is missing (older cached response)', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText(/As of /)).toBeNull();
  });

  it('renders the no_current_month_data status from the screen end to end', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'no_current_month_data' });
    expect(await queries.findByText('No sales recorded yet this month')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- Phase 2: operating schedule

/**
 * Recovery Target Improvement Plan §7.2/§8.3/§10.5/§11 Phase 2 — the exact
 * operating calendar. Two things land on this screen: closed days in the
 * "Day by day" list must render distinctly and never crash on the `null`
 * `gap`/`neededTarget` a closed day carries, and "Edit operating schedule"
 * must appear only while the remaining-days figure is still an
 * approximation (i.e. no schedule has been configured yet).
 */
describe('RecoveryTargetScreen — Ask FinSight card', () => {
  it('leads with "Why am I behind this month?" when the month is behind', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    expect(await queries.findByRole('button', { name: 'Why am I behind this month? Ask FinSight' })).toBeTruthy();
  });

  it('falls back to a neutral prompt when the month is not behind', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'on_pace', onTrack: true });
    expect(await queries.findByRole('button', { name: 'Ask about this period. Ask FinSight' })).toBeTruthy();
    expect(queries.queryByText(/Why am I behind/)).toBeNull();
  });
});

describe('RecoveryTargetScreen — day calendar', () => {
  it('opens a day\'s sold-vs-target sheet when its square is tapped, and closes it again', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      dailyCoverage: [
        { date: '2026-08-01', neededTarget: null, sales: 0, gap: null, status: 'closed', isOperatingDay: false },
        { date: '2026-08-02', neededTarget: 1500, sales: 1200, gap: -300, status: 'below', isOperatingDay: true },
      ],
    });
    await fireEvent.press(await queries.findByRole('button', { name: /Aug 2, sold PHP 1,200, below target/ }));

    expect(await queries.findByText('Short by')).toBeTruthy();
    expect(queries.getByText('Below target')).toBeTruthy();

    await fireEvent.press(queries.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(queries.queryByText('Short by')).toBeNull());
  });

  it('does not let a future day open an empty sheet', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    const future = await queries.findByRole('button', { name: /Aug 20, not yet/ });
    expect(future.props.accessibilityState?.disabled).toBe(true);
  });
});

describe('RecoveryTargetScreen — operating schedule (Phase 2)', () => {
  it('renders a closed day as "Closed" in a neutral tone, not a critical/warning/good one, without touching Money formatting on a null gap', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      dailyCoverage: [
        { date: '2026-08-01', neededTarget: null, sales: 0, gap: null, status: 'closed', isOperatingDay: false },
        { date: '2026-08-02', neededTarget: 1500, sales: 1200, gap: -300, status: 'below', isOperatingDay: true },
      ],
    });
    expect(await queries.findByText('Closed')).toBeTruthy();
    // The open day beside it still renders its ordinary gap wording.
    expect(await queries.findByText('PHP 300 below target')).toBeTruthy();
  });

  it('offers "Edit operating schedule" while remaining days are approximated and no schedule is configured', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      remainingOperatingDaysIsApproximated: true,
      operatingScheduleConfigured: false,
    });
    const editSchedule = await queries.findByRole('link', { name: /^Edit operating schedule/ });
    await fireEvent.press(editSchedule);
    expect(navigation.navigate).toHaveBeenLastCalledWith('More', {
      screen: 'OperatingSchedule', initial: false, params: { from: 'RecoveryTarget' },
    });
  });
});

// ---------------------------------------------------------------- Phase 3: primary action, "why changed", data warnings

/**
 * Recovery Target Improvement Plan §10.1/§10.2/§10.3/§11 Phase 3 — the
 * state-specific primary action, the deterministic "why your target
 * changed" explanation, and the confirmed/provisional data-quality caption.
 */
describe('RecoveryTargetScreen — primary action (Phase 3, §10.2)', () => {
  it('shows "Complete setup" for needs_setup', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'needs_setup', needsSetup: true });
    expect(await queries.findByText('Complete setup')).toBeTruthy();
  });

  it('shows "Record or import sales" for no_current_month_data', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'no_current_month_data' });
    expect(await queries.findByText('Record or import sales')).toBeTruthy();
  });

  it('shows "Review sales" for data_incomplete', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'data_incomplete' as any });
    expect(await queries.findByText('Review sales')).toBeTruthy();
  });

  it('shows a "View today\'s plan" button for behind that jumps to the daily plan on this screen', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    expect(await queries.findByRole('button', { name: "View today's plan" })).toBeTruthy();
  });

  it('shows "Record today\'s sales" for on_pace', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'on_pace' });
    expect(await queries.findByText("Record today's sales")).toBeTruthy();
  });

  it('shows an informational, non-navigating label for ahead', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'ahead' });
    expect(await queries.findByText('Maintain current pace')).toBeTruthy();
  });

  it('shows an informational label for covered', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'covered' });
    expect(await queries.findByText(/Review month summary/)).toBeTruthy();
  });

  it('renders nothing extra when status is undefined (older/cached response)', async () => {
    const queries = await renderScreen({ ...baseInsight });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText('Complete setup')).toBeNull();
    expect(queries.queryByText('Maintain current pace')).toBeNull();
  });
});

describe('RecoveryTargetScreen — "Why your target changed" (Phase 3, §10.3)', () => {
  const baseChange = {
    adjustedDailyTargetDelta: 600,
    salesAdded: 0,
    remainingOpenDaysDelta: -1,
    primaryReason: 'open_day_elapsed' as const,
  };

  it('renders the increased wording and reason when the target got harder', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      changeSincePreviousDay: { ...baseChange, adjustedDailyTargetDelta: 600 },
    });
    expect(await queries.findByText('Why your target changed')).toBeTruthy();
    expect(await queries.findByText(/increased by PHP 600\.00/)).toBeTruthy();
    expect(await queries.findByText(/fewer days/)).toBeTruthy();
  });

  it('renders the decreased wording and "sales_added" reason, plus the sales-added line, when the target got easier', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      changeSincePreviousDay: {
        adjustedDailyTargetDelta: -400,
        salesAdded: 2500,
        remainingOpenDaysDelta: 0,
        primaryReason: 'sales_added',
      },
    });
    expect(await queries.findByText(/decreased by PHP 400\.00/)).toBeTruthy();
    expect(await queries.findByText(/closing the gap|helping close the gap/)).toBeTruthy();
    expect(await queries.findByText(/You recorded PHP 2,500\.00 in sales since yesterday/)).toBeTruthy();
  });

  it('renders a fractional sub-peso delta with decimals visible, not rounded away to zero', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      changeSincePreviousDay: { ...baseChange, adjustedDailyTargetDelta: 0.49, salesAdded: 0.01 },
    });
    expect(await queries.findByText(/increased by PHP 0\.49/)).toBeTruthy();
    expect(await queries.findByText(/You recorded PHP 0\.01 in sales since yesterday/)).toBeTruthy();
  });

  it('is absent when changeSincePreviousDay is null', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', changeSincePreviousDay: null });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText('Why your target changed')).toBeNull();
  });

  it('is absent when primaryReason is no_material_change', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      changeSincePreviousDay: { ...baseChange, adjustedDailyTargetDelta: 5, primaryReason: 'no_material_change' },
    });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText('Why your target changed')).toBeNull();
  });
});

describe('RecoveryTargetScreen — data-quality caption (Phase 3, §8.2/§10.5)', () => {
  it('shows the pending-review/duplicate caption when dataWarnings is non-empty', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      confirmedSalesThisMonth: 15000,
      provisionalSalesThisMonth: 3000,
      dataWarnings: ['records_pending_review'],
    });
    expect(
      await queries.findByText('Includes PHP 3,000 pending review or flagged as a possible duplicate.'),
    ).toBeTruthy();
  });

  it('does not show the caption when dataWarnings is empty', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      confirmedSalesThisMonth: 18000,
      provisionalSalesThisMonth: 0,
      dataWarnings: [],
    });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText(/pending review or flagged/)).toBeNull();
  });

  it('hides "Edit operating schedule" once a schedule is configured, even though the flag is still approximated', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      remainingOperatingDaysIsApproximated: true,
      operatingScheduleConfigured: true,
    });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText('Edit operating schedule')).toBeNull();
  });

  it('hides "Edit operating schedule" when remaining days are already exact', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      remainingOperatingDaysIsApproximated: false,
    });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText('Edit operating schedule')).toBeNull();
  });
});

// ---------------------------------------------------------------- Phase 4: weekly checkpoints (§10.4)

describe('RecoveryTargetScreen — weekly checkpoints (Phase 4, §10.4)', () => {
  const checkpoints: RecoveryCheckpoint[] = [
    { endDate: '2026-08-07', cumulativeTarget: 5000, recordedAmount: 5200, variance: 200, status: 'ahead' },
    { endDate: '2026-08-14', cumulativeTarget: 10000, recordedAmount: 9000, variance: -1000, status: 'behind' },
    { endDate: '2026-08-21', cumulativeTarget: 15000, recordedAmount: null, variance: null, status: 'pending' },
    { endDate: '2026-08-28', cumulativeTarget: 20000, recordedAmount: null, variance: null, status: 'pending' },
    { endDate: '2026-08-31', cumulativeTarget: 22000, recordedAmount: null, variance: null, status: 'pending' },
  ];

  it('renders nothing extra when weeklyCheckpoints is absent (older/cached response)', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    await queries.findByText('Behind pace for the month');
    expect(queries.queryByText('Weekly checkpoints')).toBeNull();
  });

  it('shows the last passed and the next checkpoint prominently', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15', weeklyCheckpoints: checkpoints });
    expect(await queries.findByText('Weekly checkpoints')).toBeTruthy();
    // "today" is 2026-08-15: the last checkpoint is 8/14 (already passed, missed by 1,000), the next is 8/21.
    expect(await queries.findByLabelText(/By Aug 14 · last checkpoint, Missed\..*Short by PHP 1,000/)).toBeTruthy();
    expect(await queries.findByLabelText(/By Aug 21 · next checkpoint, 6 days away\..*Still needed/)).toBeTruthy();
  });

  it('renders the next checkpoint card without crashing on its null recordedAmount/variance', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15', weeklyCheckpoints: checkpoints });
    await queries.findByText('Weekly checkpoints');
    expect(queries.getByText('Sold so far')).toBeTruthy();
  });

  it('counts the days to the next checkpoint when today is a full ISO timestamp', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15T00:00:00.000Z', weeklyCheckpoints: checkpoints });
    await queries.findByText('Weekly checkpoints');
    expect(await queries.findByLabelText(/By Aug 21 · next checkpoint, 6 days away/)).toBeTruthy();
  });

  it('shows only the next checkpoint before the first one has passed', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-03', weeklyCheckpoints: checkpoints });
    await queries.findByText('Weekly checkpoints');
    expect(queries.queryByLabelText(/last checkpoint/)).toBeNull();
    expect(await queries.findByLabelText(/By Aug 7 · next checkpoint, 4 days away/)).toBeTruthy();
  });

  it('keeps the full checkpoint list secondary, behind an expand/collapse disclosure', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15', weeklyCheckpoints: checkpoints });
    await queries.findByText('Weekly checkpoints');

    const toggle = await queries.findByRole('button', { name: /All checkpoints this month/ });
    expect(toggle.props.accessibilityState.expanded).toBe(false);
    // Every date shows on the flag row, so the list itself is checked by its
    // own row: Aug 7's target line only appears once the list is expanded.
    expect(queries.queryByText('Target PHP 5,000')).toBeNull();

    await fireEvent.press(toggle);
    expect(await queries.findByText('Target PHP 5,000')).toBeTruthy();
  });
});

describe('RecoveryTargetScreen — reporting period', () => {
  const weekPeriod = {
    kind: 'week' as const,
    month: null,
    start: '2026-08-10',
    end: '2026-08-16',
    asOfDate: '2026-08-15',
    timezone: 'Asia/Manila',
    isCurrent: true,
    isComplete: false,
    targetBasis: 'prorated_monthly_expenses' as const,
    monthlyExpenseBases: [],
    target: 1000,
    sales: 300,
    confirmedSales: 300,
    provisionalSales: 0,
    remainingTarget: 700,
    coveragePercent: 30,
    dailyTarget: 150,
    adjustedDailyTarget: 350,
    operatingDays: 7,
    elapsedOperatingDays: 5,
    remainingOperatingDays: 2,
    operatingScheduleConfigured: false,
    operatingDaysIsApproximated: false,
    expectedSalesToDate: 700,
    paceVarianceAmount: -400,
    status: 'behind' as const,
    confidence: 'limited' as const,
    recordCount: 3,
    dataWarnings: [],
  };

  it('shows a week on its own terms and hides what only describes the current month', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', reportingPeriod: weekPeriod });
    expect(await queries.findByText('Behind pace')).toBeTruthy();
    expect(queries.getByText('Remaining weekly target')).toBeTruthy();
    expect(queries.getByText('Why PHP 350 a day?')).toBeTruthy();
    expect(queries.getAllByText('of PHP 1,000').length).toBeGreaterThan(0);
    expect(
      queries.getByText(
        'Recorded sales this week are PHP 300 against a PHP 1,000 target. Behind pace. The remaining target is PHP 700, or about PHP 350 per remaining operating day.',
      ),
    ).toBeTruthy();
    // Month-to-date only: these would show monthly figures under a weekly heading.
    expect(queries.queryByRole('header', { name: /Today's goal/ })).toBeNull();
    expect(queries.queryByRole('button', { name: 'Type amount' })).toBeNull();
    expect(queries.queryByText('Remaining recovery target')).toBeNull();
  });

  it('keeps the month-to-date cards for the current month and adds today', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      reportingPeriod: { ...weekPeriod, kind: 'month', month: '2026-08', start: '2026-08-01', end: '2026-08-31' },
    });
    expect(await queries.findByRole('button', { name: 'Type amount' })).toBeTruthy();
    expect(queries.getByRole('header', { name: /Today's goal/ })).toBeTruthy();
    expect(queries.getByText('Remaining recovery target')).toBeTruthy();
  });
});

it('binds the recovery-target view to its own reporting period scope', async () => {
  const { RecoveryTargetScreen } = await import('../../src/screens/RecoveryTargetScreen');
  const wrapper = RecoveryTargetScreen({});
  expect(wrapper.props.scope).toBe('recovery-target');
  expect(typeof wrapper.props.children.type).toBe('function');
});
