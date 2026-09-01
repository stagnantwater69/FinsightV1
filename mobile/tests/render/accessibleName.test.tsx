import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react-native';

/**
 * Two defects, both of which look correct at the call site and both of which
 * are announced as silence.
 *
 * 1. A BUSY BUTTON WITH NO NAME. `Button` swaps its title for an
 *    ActivityIndicator while `loading`. A Pressable with no explicit label
 *    takes its accessible name from the Text it contains — so at the exact
 *    moment the button became busy, the name of the control a reader was
 *    parked on disappeared. It announced the busy state of *something*.
 *
 * 2. A ROLE ON A VIEW THAT IS NOT AN ELEMENT. React Native maps `accessible`
 *    onto `isAccessibilityElement`, which is false by default on a View, so a
 *    View carrying `accessibilityRole="progressbar"` is not offered to a
 *    screen reader at all. This has now been fixed in five places; these are
 *    the two that can be mounted in isolation.
 *
 * WHY THESE ARE RENDER TESTS. `tests/accessibleElements.test.ts` proves the
 * prop is written, across every file. It cannot prove the element is
 * REACHABLE — that a role query finds it and that it carries a name when it
 * does. That is exactly what a query-by-role does here, and it is the check
 * that would have failed on the original code.
 *
 * WHAT IT DOES NOT COVER: how VoiceOver or TalkBack sequences or times any of
 * this, and anything to do with the camera, permissions or lifecycle. Those
 * are device-only.
 */

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), profile: null }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ui = await import('../../src/components/ui');
const { RecoveryMeter } = await import('../../src/components/RecoveryMeter');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const withTheme = (node: React.ReactNode) => (
  <ThemeProvider initialMode="light">{node}</ThemeProvider>
);

/**
 * A mid-month business that is behind: both bars are partly filled, so neither
 * is at 0 or 100 where a missing value would be indistinguishable from a
 * default. The meter does no arithmetic of its own — it renders the backend's
 * computed object — so these are just consistent numbers.
 */
const recoveryTargets = {
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
  todaysStatus: 'below' as const,
  monthCoveragePercent: 45,
  onTrack: false,
};

describe('Accessible names that survive a state change', () => {
  it('keeps the button name while it is loading', async () => {
    const queries = await render(
      withTheme(<ui.Button title="Save this expense" onPress={() => {}} loading />),
    );

    // The whole point: the visible Text is gone, replaced by a spinner, and
    // the control is still findable BY NAME.
    const button = queries.getByRole('button', { name: 'Save this expense' });
    expect(button).toBeTruthy();
  });

  it('marks the loading button busy as well as disabled', async () => {
    const queries = await render(
      withTheme(<ui.Button title="Save this expense" onPress={() => {}} loading />),
    );

    const button = queries.getByRole('button', { name: 'Save this expense' });
    const state = button.props.accessibilityState as Record<string, boolean>;
    // `busy` is what says "wait"; `disabled` is what stops a reader offering
    // to activate a control that will not respond. Both are true, and neither
    // is a substitute for having a name.
    expect(state.busy).toBe(true);
    expect(state.disabled).toBe(true);
  });

  it('names the button the same way when it is idle', async () => {
    // The label is set unconditionally, so the name does not appear and
    // disappear as the button changes state. A resend control whose title is
    // a live countdown depends on this: the announced name has to track the
    // visible words rather than being pinned to a first render.
    const queries = await render(
      withTheme(<ui.Button title="Send again in 12s" onPress={() => {}} disabled />),
    );

    expect(queries.getByRole('button', { name: 'Send again in 12s' })).toBeTruthy();
    const button = queries.getByRole('button', { name: 'Send again in 12s' });
    expect((button.props.accessibilityState as Record<string, boolean>).busy).toBe(false);
  });
});

describe('Views that state a role are actually reachable', () => {
  it('surfaces the ErrorNote as an alert carrying its text', async () => {
    const queries = await render(
      withTheme(<ui.ErrorNote>That email is already registered.</ui.ErrorNote>),
    );

    // Without `accessible` on the View this query finds nothing at all: the
    // role is set on something the platform never offers.
    const alert = queries.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(queries.getByText('That email is already registered.')).toBeTruthy();
  });

  it('surfaces RecoveryMeter as progressbars with names and values', async () => {
    const queries = await render(withTheme(<RecoveryMeter data={recoveryTargets} />));

    const bars = queries.getAllByRole('progressbar');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      // A bar that is an element but has no name is the same problem one step
      // along: reachable, and still says nothing useful.
      expect(bar.props.accessibilityLabel).toBeTruthy();
      expect(bar.props.accessibilityValue).toBeTruthy();
    }
  });
});
