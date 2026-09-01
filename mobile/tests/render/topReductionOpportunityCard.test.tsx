import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react-native';

import type { ReductionOpportunity } from '../../src/lib/types';

/**
 * Rendered coverage for the Dashboard's one compact reduction-opportunity
 * card — plan §13.1/§15 Phase 5.
 *
 * The confidence/emptiness gate itself is covered separately in
 * tests/topReductionOpportunity.test.ts as a pure function; this file only
 * proves the card draws what it is given and navigates on press.
 */

function opportunity(overrides: Partial<ReductionOpportunity> = {}): ReductionOpportunity {
  return {
    id: 'opp-1',
    type: 'CATEGORY_PRESSURE',
    categoryId: 10,
    categoryName: 'Stock',
    priority: 'high',
    confidence: 'strong',
    observation: 'Stock rose sharply against the period before.',
    rationale: 'Stock is 42% of expenses this period, up from 28%.',
    evidence: {
      currentAmount: 8400,
      previousAmount: 5200,
      changeAmount: 3200,
      changePercent: 61.5,
      expenseSharePercent: 42,
      recordCount: 9,
      unusualRecordCount: 0,
      possibleDuplicateCount: 0,
    },
    costBehavior: 'unclassified',
    suggestedChecks: [],
    relatedRecordIds: [],
    limitations: [],
    ...overrides,
  };
}

describe('TopReductionOpportunityCard', () => {
  it('shows the category, observation and one evidence figure, and reviews on press', async () => {
    const { TopReductionOpportunityCard } = await import(
      '../../src/components/TopReductionOpportunityCard'
    );
    const { ThemeProvider } = await import('../../src/context/ThemeContext');
    const onPress = vi.fn();

    const queries = await render(
      <ThemeProvider initialMode="light">
        <TopReductionOpportunityCard opportunity={opportunity()} onPress={onPress} />
      </ThemeProvider>,
    );

    expect(queries.getByText('Stock')).toBeTruthy();
    expect(queries.getByText('Stock rose sharply against the period before.')).toBeTruthy();
    expect(queries.getByText('Review opportunity')).toBeTruthy();

    await fireEvent.press(
      queries.getByRole('button', {
        name: /Reduction opportunity: Stock, Stock rose sharply/,
      }),
    );
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
