import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';

/**
 * The period control goes both ways.
 *
 * WHY THIS FILE EXISTS: "Show all time" used to be the ONLY thing on Home that
 * set the period, and it lived inside a callout that disappears as soon as the
 * period is no longer empty. An owner who tapped it to rescue a blank Home was
 * then stuck on lifetime totals until they restarted the app — the control
 * that got them there was gone.
 *
 * Driven, not read off source: this is about a control's state after two
 * presses, which a source check cannot answer.
 */

/** Mounts the selector with real state behind it, the way Home holds it. */
async function mountSelector(initial: number) {
  const { PeriodSelector } = await import('../../src/components/PeriodSelector');
  const { ThemeProvider } = await import('../../src/context/ThemeContext');

  function Host() {
    const [days, setDays] = React.useState(initial);
    return <PeriodSelector value={days} onChange={setDays} />;
  }

  return render(
    <ThemeProvider initialMode="light">
      <Host />
    </ThemeProvider>,
  );
}

/** Which option currently reads as selected to a screen reader. */
function checkedLabel(queries: Awaited<ReturnType<typeof mountSelector>>): string | undefined {
  const checked = queries
    .getAllByRole('radio')
    .filter((node) => node.props.accessibilityState?.checked === true);
  expect(checked, 'exactly one period should be selected').toHaveLength(1);
  return checked[0]!.props.accessibilityLabel;
}

describe('PeriodSelector', () => {
  it('starts on the default 30-day window', async () => {
    const queries = await mountSelector(30);
    expect(checkedLabel(queries)).toBe('Last 30 days');
  });

  it('switches to all time AND back again, without a remount', async () => {
    const queries = await mountSelector(30);

    await fireEvent.press(queries.getByRole('radio', { name: 'Across all records' }));
    expect(checkedLabel(queries)).toBe('Across all records');

    // The half that was missing: the way back is on screen the whole time.
    await fireEvent.press(queries.getByRole('radio', { name: 'Last 30 days' }));
    expect(checkedLabel(queries)).toBe('Last 30 days');
  });

  it('reaches every window from every other', async () => {
    const queries = await mountSelector(30);
    for (const name of ['Today', 'Last 7 days', 'Across all records', 'Last 30 days', 'Today']) {
      await fireEvent.press(queries.getByRole('radio', { name }));
      expect(checkedLabel(queries)).toBe(name);
    }
  });

  it('announces the window by its length, not as a calendar month', async () => {
    const queries = await mountSelector(30);
    const labels = queries.getAllByRole('radio').map((node) => node.props.accessibilityLabel);
    expect(labels).toEqual(['Today', 'Last 7 days', 'Last 30 days', 'Across all records']);
  });
});
