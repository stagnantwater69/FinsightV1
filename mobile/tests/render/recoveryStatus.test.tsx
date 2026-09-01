import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react-native';

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
  it('shows the required Sales Coverage Target definition before the first status', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    expect(
      await queries.findByText(
        'Your Sales Coverage Target compares recorded sales references with your expected monthly expense amount. It is a planning guide and does not calculate profit, cash flow, or formal break-even.',
      ),
    ).toBeTruthy();
  });

  it('shows the as-of date and timezone when the server sends them', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'on_pace',
      asOfDate: '2026-08-15',
      timezone: 'Asia/Manila',
    });
    expect(await queries.findByText(/As of August 15, 2026, Asia\/Manila time/)).toBeTruthy();
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
    expect(await queries.findByText('300 below')).toBeTruthy();
  });

  it('offers "Edit operating schedule" while remaining days are approximated and no schedule is configured', async () => {
    const queries = await renderScreen({
      ...baseInsight,
      status: 'behind',
      remainingOperatingDaysIsApproximated: true,
      operatingScheduleConfigured: false,
    });
    expect(await queries.findByText('Edit operating schedule')).toBeTruthy();
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

  it('shows an informational, non-button label for behind', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind' });
    expect(await queries.findByText(/View today's plan/)).toBeTruthy();
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

  it('shows the current (most recent passed) and next checkpoint prominently', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15', weeklyCheckpoints: checkpoints });
    expect(await queries.findByText('Weekly checkpoints')).toBeTruthy();
    // "today" is 2026-08-15: the current checkpoint is 8/14 (already passed), the next is 8/21.
    expect(await queries.findByText(/Current checkpoint · Aug 14/)).toBeTruthy();
    expect(await queries.findByText(/Next checkpoint · Aug 21/)).toBeTruthy();
  });

  it('shows "Not yet reached" for a pending future checkpoint without crashing on its null recordedAmount/variance', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15', weeklyCheckpoints: checkpoints });
    await queries.findByText('Weekly checkpoints');
    expect(queries.getAllByText('Not yet reached').length).toBeGreaterThan(0);
  });

  it('keeps the full checkpoint list secondary, behind an expand/collapse disclosure', async () => {
    const queries = await renderScreen({ ...baseInsight, status: 'behind', today: '2026-08-15', weeklyCheckpoints: checkpoints });
    await queries.findByText('Weekly checkpoints');

    const toggle = await queries.findByRole('button', { name: /All checkpoints this month/ });
    expect(toggle.props.accessibilityState.expanded).toBe(false);
    // Aug 7 only appears once the list is expanded — it isn't the current/next checkpoint.
    expect(queries.queryByText('Aug 7')).toBeNull();

    await fireEvent.press(toggle);
    expect(await queries.findByText('Aug 7')).toBeTruthy();
  });
});
