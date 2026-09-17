import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react-native';

/**
 * Every chart's spoken summary has to be reachable.
 *
 * WHY THIS FILE EXISTS. DESIGN.md requires a chart to carry exact values and a
 * textual summary, and charts.tsx did write one for each of them — a real
 * sentence, kept in step with the data. Six of the seven were set as
 * `accessibilityLabel` on a plain `View`. React Native maps `accessible`
 * straight onto isAccessibilityElement and it is false unless set, so those
 * six sentences were attached to something the platform never surfaces: a
 * screen-reader user reaching a chart heard the title and then nothing. The
 * seventh (CategoryComparison) had already been fixed, which is exactly why
 * the other six were worth looking for — the same defect rarely appears once.
 *
 * A source check cannot catch this class. `accessibilityLabel={...}` is
 * present and correct in the source either way; only a mounted tree can say
 * whether anything is standing there to speak it. So these tests query the way
 * assistive technology traverses — by role and by accessible name.
 *
 * WHAT THIS IS NOT. It is not evidence that VoiceOver or TalkBack reads these
 * sentences well, at the right moment, or in a useful order. That needs a
 * device.
 */

const charts = await import('../../src/components/charts');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const mount = (node: React.ReactNode) =>
  render(<ThemeProvider initialMode="light">{node}</ThemeProvider>);

describe('Chart summaries are surfaced, not just written', () => {
  it('announces the category breakdown with each amount AND its share', async () => {
    // The share is on screen as a number printed inside each bar, so a summary
    // that stopped at the peso amount left the spoken version poorer than the
    // seen one.
    const queries = await mount(
      <charts.CategoryBreakdown
        data={[
          { categoryId: 1, categoryName: 'Stock', total: 750 },
          { categoryId: 2, categoryName: 'Rent', total: 250 },
        ]}
      />,
    );

    const summary = queries.getByRole('image');
    expect(summary.props.accessibilityLabel).toContain('Stock');
    expect(summary.props.accessibilityLabel).toContain('75 percent');
    expect(summary.props.accessibilityLabel).toContain('25 percent');
  });

  it('announces the donut with the total that only exists inside the ring', async () => {
    // Collapsing the chart into one element hides the "Total ₱1,000" printed
    // in the hole, so the summary has to say it.
    const queries = await mount(
      <charts.DonutChart
        data={[
          { categoryName: 'Stock', total: 750 },
          { categoryName: 'Rent', total: 250 },
        ]}
      />,
    );

    const summary = queries.getByRole('image');
    expect(summary.props.accessibilityLabel).toContain('1,000');
    expect(summary.props.accessibilityLabel).toContain('Stock');
  });

  it('announces the spend trend, its running total and its busiest day', async () => {
    const queries = await mount(
      <charts.SpendTrend
        data={[
          { date: '2026-09-01', total: 100 },
          { date: '2026-09-02', total: 400 },
        ]}
      />,
    );

    const summary = queries.getByRole('image');
    expect(summary.props.accessibilityLabel).toContain('Running total over 2 days');
    expect(summary.props.accessibilityLabel).toContain('busiest single day');
  });

  it('announces cashflow totals in both directions', async () => {
    const queries = await mount(
      <charts.CashflowChart
        data={[
          { date: '2026-09-01', sales: 500, expenses: 200 },
          { date: '2026-09-02', sales: 300, expenses: 100 },
        ]}
      />,
    );

    const summary = queries.getByRole('image');
    expect(summary.props.accessibilityLabel).toContain('Total money in');
    expect(summary.props.accessibilityLabel).toContain('total money out');
  });

  it('announces which direction each category moved', async () => {
    const queries = await mount(
      <charts.CategoryChange
        data={[{ categoryName: 'Stock', direction: 'up', percentChange: 12 }]}
      />,
    );

    expect(queries.getByRole('image').props.accessibilityLabel).toContain('Stock up 12 percent');
  });

  it('announces how many days met the daily target', async () => {
    const queries = await mount(
      <charts.CoverageColumns
        data={[
          { date: '2026-09-01', amount: 600 },
          { date: '2026-09-02', amount: 100 },
        ]}
        target={500}
      />,
    );

    expect(queries.getByRole('image').props.accessibilityLabel).toContain('1 of 2 days met it');
  });

  it('still announces the comparison chart that was fixed first', async () => {
    // A regression guard rather than a new fix: this one already carried
    // `accessible`, and the point of the sweep was that it should not be the
    // only one that does.
    const queries = await mount(
      <charts.CategoryComparison
        data={[{ categoryName: 'Stock', current: 400, previous: 300, percentChange: 33 }]}
      />,
    );

    expect(queries.getByRole('image').props.accessibilityLabel).toContain('Stock');
  });
});
