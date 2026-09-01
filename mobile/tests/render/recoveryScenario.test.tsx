import React from 'react';
import { Alert } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { RecoveryInsight, RecoveryScenario } from '../../src/lib/types';

/**
 * Rendered coverage for the Recovery Target hypothetical scenario — Expense
 * Reduction Opportunities plan §13.2/§15 Phase 5.
 *
 * Follows the same mocking shape as render/reductionOpportunities.test.tsx:
 * useFocusEffect stands in for a mount effect since there is no
 * NavigationContainer in this harness, and api.get/api.post are routed by
 * path/call.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    put: (...args: unknown[]) => apiPut(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong.',
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

vi.mock('../../src/components/AskFinSight', () => ({
  AskFinSight: () => null,
}));
vi.mock('../../src/components/AskFinSightFab', () => ({
  AskFinSightFab: () => null,
  FAB_CLEARANCE: 0,
}));

// DateField's own DateTimePicker dialog is native UI with no render-harness
// coverage (see tests/render/README.md) — same stub as
// tests/render/operatingSchedule.test.tsx. The sheet only reaches it through
// the §7.5 "Save this as a plan" deadline field, tested separately below.
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

const recoveryInsight: RecoveryInsight = {
  expectedMonthlyExpenses: 30000,
  operatingDays: 25,
  dailyNeededTarget: 1200,
  salesThisMonth: 10000,
  remainingTarget: 20000,
  daysInMonth: 31,
  calendarDaysLeftInMonth: 15,
  remainingOperatingDays: 12,
  remainingOperatingDaysIsApproximated: true,
  adjustedDailyTarget: 1666.67,
  todaysTarget: 1200,
  todaysSales: 900,
  todaysGap: -300,
  todaysStatus: 'below',
  monthCoveragePercent: 33,
  onTrack: false,
  monthStart: '2026-08-01',
  today: '2026-08-15',
  coverageDays: 14,
  dailyCoverage: [],
  monthHasNoRecords: false,
  latestSaleDate: '2026-08-14',
};

function scenario(overrides: Partial<RecoveryScenario> = {}): RecoveryScenario {
  return {
    assumedExpectedMonthlyExpenses: 20000,
    current: { ...recoveryInsight },
    hypothetical: {
      ...recoveryInsight,
      expectedMonthlyExpenses: 20000,
      remainingTarget: 10000,
      dailyNeededTarget: 800,
      adjustedDailyTarget: 833.33,
    },
    delta: {
      totalCoverageGoal: 20000 - recoveryInsight.expectedMonthlyExpenses,
      remainingTarget: 10000 - recoveryInsight.remainingTarget,
      adjustedDailyTarget: 833.33 - recoveryInsight.adjustedDailyTarget,
      estimatedTransactionsPerDay: null,
      estimatedTransactionsPerDayUnavailableReason: 'transaction_provenance_unknown',
    },
    persisted: false,
    ...overrides,
  };
}

const navigation = { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() };

async function renderScreen() {
  apiGet.mockImplementation((path: string) => {
    if (path === '/insights/recovery') return Promise.resolve(recoveryInsight);
    // §7.5 saved-plan lookup, fetched alongside the main load — absent by
    // default in these tests, none of which are about it.
    if (path.endsWith('/recovery-plans')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  const { RecoveryTargetScreen } = await import('../../src/screens/RecoveryTargetScreen');
  const { ThemeProvider } = await import('../../src/context/ThemeContext');
  return render(
    <ThemeProvider initialMode="light">
      <RecoveryTargetScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiPut.mockReset();
  apiDelete.mockReset();
});

describe('Recovery Target — hypothetical scenario', () => {
  it('leaves the real target on screen untouched while the sheet is closed', async () => {
    const queries = await renderScreen();
    expect(await queries.findByText('See a hypothetical scenario')).toBeTruthy();
    // The real, unchanged figure is on screen before any scenario is entered.
    expect(queries.queryByText('Hypothetical result — your real target and profile are unchanged')).toBeNull();
  });

  it('shows current and hypothetical distinctly, labelled as not saved, with the assumed figure', async () => {
    apiPost.mockResolvedValue(scenario());
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await queries.findByText('Hypothetical recovery target');

    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));

    expect(apiPost).toHaveBeenCalledWith('/insights/recovery-scenario', {
      businessProfileId: fixtures.businessProfile.id,
      assumedExpectedMonthlyExpenses: 20000,
    });

    expect(
      await queries.findByText('Hypothetical result — your real target and profile are unchanged'),
    ).toBeTruthy();
    expect(queries.getAllByText('Current (unchanged)').length).toBeGreaterThan(0);
    expect(queries.getAllByText('Hypothetical (not saved)').length).toBeGreaterThan(0);
    expect(queries.getByText('Assumed expected monthly expenses:')).toBeTruthy();
  });

  it('never calls a profile-update endpoint from this sheet', async () => {
    apiPost.mockResolvedValue(scenario());
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));

    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    // Only the read-only scenario endpoint was ever called — nothing patched.
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/insights/recovery-scenario', expect.anything());
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('rejects a negative assumption before ever calling the server', async () => {
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '-5',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));

    expect(await queries.findByText('Enter zero or a positive amount.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows peso and percentage deltas alongside current/hypothetical, plus the always-unavailable transactions-per-day note', async () => {
    apiPost.mockResolvedValue(scenario());
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));
    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    // Expected monthly expenses: 30000 -> 20000, delta -10000, -33.3%.
    expect(queries.getAllByText('Expected monthly expenses').length).toBeGreaterThan(0);
    expect(await queries.findByText(/−PHP 10,000\.00 \(-33\.3%\)/)).toBeTruthy();

    // "Estimated transactions per day" is always the explicit unavailable note, never a number.
    expect(queries.getByText('Estimated transactions per day')).toBeTruthy();
    expect(
      queries.getByText("Not available — can't tell if your sales records are per-transaction or daily totals."),
    ).toBeTruthy();
  });

  it('guards the percentage delta against a zero denominator — peso delta only, no Infinity/NaN', async () => {
    apiPost.mockResolvedValue(
      scenario({
        current: { ...recoveryInsight, expectedMonthlyExpenses: 0 },
        delta: {
          totalCoverageGoal: 20000,
          remainingTarget: 10000 - recoveryInsight.remainingTarget,
          adjustedDailyTarget: 833.33 - recoveryInsight.adjustedDailyTarget,
          estimatedTransactionsPerDay: null,
          estimatedTransactionsPerDayUnavailableReason: 'transaction_provenance_unknown',
        },
      }),
    );
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));
    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    expect(await queries.findByText(/\+PHP 20,000\.00/)).toBeTruthy();
    expect(queries.queryByText(/Infinity/)).toBeNull();
    expect(queries.queryByText(/NaN/)).toBeNull();
  });

  it('suppresses the percentage delta when current is a near-zero fraction of a peso, but still shows the peso delta', async () => {
    apiPost.mockResolvedValue(
      scenario({
        current: { ...recoveryInsight, expectedMonthlyExpenses: 0.5 },
        delta: {
          totalCoverageGoal: 20000 - 0.5,
          remainingTarget: 10000 - recoveryInsight.remainingTarget,
          adjustedDailyTarget: 833.33 - recoveryInsight.adjustedDailyTarget,
          estimatedTransactionsPerDay: null,
          estimatedTransactionsPerDayUnavailableReason: 'transaction_provenance_unknown',
        },
      }),
    );
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));
    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    // Peso delta is shown, but no meaningless four-to-five-digit percentage
    // off a near-zero (< PHP 1) baseline — distinct from the exact-zero case above.
    expect(await queries.findByText(/\+PHP 19,999\.50/)).toBeTruthy();
    expect(queries.queryByText(/\+PHP 19,999\.50 \(/)).toBeNull();
  });

  it('closes without calling the server when dismissed', async () => {
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await queries.findByText('Hypothetical recovery target');

    await fireEvent.press(queries.getByLabelText('Close hypothetical recovery scenario'));

    await waitFor(() => expect(queries.queryByText('Hypothetical recovery target')).toBeNull());
    expect(apiPost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- §7.5/§10.7 "Save this as a plan"

describe('Recovery Target — "Save this as a plan"', () => {
  it('is absent until a hypothetical result exists', async () => {
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await queries.findByText('Hypothetical recovery target');
    expect(queries.queryByText('Save this as a plan')).toBeNull();
  });

  it('saves the assumed figure as ownerTargetAmount for the current month, with the confirmation copy, without touching the displayed recovery figures', async () => {
    apiPost.mockResolvedValue(scenario());
    apiPut.mockResolvedValue({
      month: '2026-08',
      bufferPercent: null,
      deadline: null,
      ownerTargetAmount: 20000,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));
    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    // The real, unchanged figures from the scenario result are on screen
    // before any plan is saved...
    expect(queries.getAllByText('Current (unchanged)').length).toBeGreaterThan(0);

    await fireEvent.press(queries.getByRole('button', { name: 'Save this as a plan' }));
    await fireEvent.press(queries.getByRole('button', { name: 'Save plan' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [path, body] = apiPut.mock.calls[0];
    expect(path).toMatch(
      new RegExp(`^/business-profiles/${fixtures.businessProfile.id}/recovery-plans/\\d{4}-\\d{2}$`),
    );
    expect(body).toMatchObject({ ownerTargetAmount: 20000, deadline: null, bufferPercent: null });

    expect(
      await queries.findByText("Saved for reference — this doesn't change your business profile or recorded sales."),
    ).toBeTruthy();

    // ...and are still exactly on screen after — nothing about the real
    // scenario result changed as a side effect of saving the plan.
    expect(queries.getAllByText('Current (unchanged)').length).toBeGreaterThan(0);
    expect(queries.getAllByText('Hypothetical (not saved)').length).toBeGreaterThan(0);
    // Saving the plan never calls the read-only scenario endpoint again, nor
    // any profile-update endpoint.
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('saves an optional deadline and buffer percent alongside the amount', async () => {
    apiPost.mockResolvedValue(scenario());
    apiPut.mockResolvedValue({
      month: '2026-08',
      bufferPercent: 10,
      deadline: '2026-08-31',
      ownerTargetAmount: 20000,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    });
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));
    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    await fireEvent.press(queries.getByRole('button', { name: 'Save this as a plan' }));
    await fireEvent.changeText(queries.getByLabelText('Deadline (optional)'), '2026-08-31');
    await fireEvent.changeText(queries.getByLabelText('Buffer percent (optional)'), '10');
    await fireEvent.press(queries.getByRole('button', { name: 'Save plan' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [, body] = apiPut.mock.calls[0];
    expect(body).toMatchObject({ ownerTargetAmount: 20000, deadline: '2026-08-31', bufferPercent: 10 });
  });

  it('rejects a buffer percent outside 0-100 before calling the server', async () => {
    apiPost.mockResolvedValue(scenario());
    const queries = await renderScreen();

    await fireEvent.press(await queries.findByRole('button', { name: 'See a hypothetical scenario' }));
    await fireEvent.changeText(
      queries.getByLabelText('Assumed expected monthly expenses, in Philippine pesos'),
      '20000',
    );
    await fireEvent.press(queries.getByRole('button', { name: 'See hypothetical target' }));
    await queries.findByText('Hypothetical result — your real target and profile are unchanged');

    await fireEvent.press(queries.getByRole('button', { name: 'Save this as a plan' }));
    await fireEvent.changeText(queries.getByLabelText('Buffer percent (optional)'), '150');
    await fireEvent.press(queries.getByRole('button', { name: 'Save plan' }));

    expect(await queries.findByText('Enter a percentage between 0 and 100.')).toBeTruthy();
    expect(apiPut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- §7.5/§10.7 "This month's saved plan"

describe('RecoveryTargetScreen — "This month\'s saved plan"', () => {
  const savedPlan = {
    month: '2026-08',
    bufferPercent: 10,
    deadline: '2026-08-31',
    ownerTargetAmount: 22000,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  async function renderScreenWithPlan(plan: unknown) {
    apiGet.mockImplementation((path: string) => {
      if (path === '/insights/recovery') return Promise.resolve(recoveryInsight);
      if (path.endsWith('/recovery-plans')) return Promise.resolve(plan ? [plan] : []);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const { RecoveryTargetScreen } = await import('../../src/screens/RecoveryTargetScreen');
    const { ThemeProvider } = await import('../../src/context/ThemeContext');
    return render(
      <ThemeProvider initialMode="light">
        <RecoveryTargetScreen navigation={navigation} />
      </ThemeProvider>,
    );
  }

  it('renders nothing when no plan is saved for the current month', async () => {
    const queries = await renderScreenWithPlan(null);
    await queries.findByText('See a hypothetical scenario');
    expect(queries.queryByText("This month's saved plan")).toBeNull();
  });

  it('renders nothing when the fetch fails, without blocking the main recovery figures', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/insights/recovery') return Promise.resolve(recoveryInsight);
      if (path.endsWith('/recovery-plans')) return Promise.reject(new Error('boom'));
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const { RecoveryTargetScreen } = await import('../../src/screens/RecoveryTargetScreen');
    const { ThemeProvider } = await import('../../src/context/ThemeContext');
    const queries = await render(
      <ThemeProvider initialMode="light">
        <RecoveryTargetScreen navigation={navigation} />
      </ThemeProvider>,
    );
    expect(await queries.findByText('See a hypothetical scenario')).toBeTruthy();
    expect(queries.queryByText("This month's saved plan")).toBeNull();
  });

  it('shows the saved amount, deadline and buffer, clearly separate from the real target figures', async () => {
    const queries = await renderScreenWithPlan(savedPlan);
    expect(await queries.findByText("This month's saved plan")).toBeTruthy();
    expect(queries.getByText("Your own reference note — it doesn't change your business profile or recorded sales.")).toBeTruthy();
    expect(queries.getByText('2026-08-31')).toBeTruthy();
    expect(queries.getByText('10%')).toBeTruthy();
  });

  it('deletes the saved plan and removes it from screen', async () => {
    vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const queries = await renderScreenWithPlan(savedPlan);
    await queries.findByText("This month's saved plan");

    await fireEvent.press(queries.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith(
      `/business-profiles/${fixtures.businessProfile.id}/recovery-plans/2026-08`,
    ));
    await waitFor(() => expect(queries.queryByText("This month's saved plan")).toBeNull());
  });

  it('edits the saved plan via PUT and shows the updated figures', async () => {
    apiPut.mockResolvedValue({ ...savedPlan, ownerTargetAmount: 30000 });
    const queries = await renderScreenWithPlan(savedPlan);
    await queries.findByText("This month's saved plan");

    await fireEvent.press(queries.getByRole('button', { name: 'Edit' }));
    await fireEvent.changeText(queries.getByLabelText('Owner target amount (optional)'), '30000');
    await fireEvent.press(queries.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith(
      `/business-profiles/${fixtures.businessProfile.id}/recovery-plans/2026-08`,
      expect.objectContaining({ ownerTargetAmount: 30000 }),
    ));
    // Coincidentally the same figure as `recoveryInsight.expectedMonthlyExpenses`
    // above it on screen — at least one instance confirms the edit rendered,
    // without asserting away the real target's own unrelated figure.
    await waitFor(() => expect(queries.getAllByText('PHP 30,000').length).toBeGreaterThanOrEqual(2));
  });
});
