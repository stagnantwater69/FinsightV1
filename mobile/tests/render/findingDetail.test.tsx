import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';
import type { AnomalyFinding, UnusualExpense } from '../../src/lib/types';

const apiPatch = vi.fn();
const prepareQuestion = vi.fn();

vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));

vi.mock('../../src/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: (...args: unknown[]) => apiPatch(...args), delete: vi.fn() },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ profiles: [fixtures.businessProfile], selected: fixtures.businessProfile, categories: fixtures.categories }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../src/context/AiChatContext', () => ({ useAiChat: () => ({ prepareQuestion }) }));
vi.mock('../../src/components/AskFinSight', () => ({ AskFinSight: () => null }));
vi.mock('../../src/components/AskFinSightFab', () => ({ AskFinSightFab: () => null, FAB_CLEARANCE: 0 }));

const { FindingDetailScreen } = await import('../../src/screens/FindingDetailScreen');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { takeFlash } = await import('../../src/lib/flash');

const finding: AnomalyFinding = {
  id: 77, expenseRecordId: 101, type: 'POSSIBLE_DUPLICATE', severity: 'MEDIUM', score: 0.8,
  title: 'Possible duplicate purchase', reasons: ['Same amount and date', 'Recorded two minutes apart'],
  status: 'OPEN', detectedAt: '2026-08-20T02:00:00.000Z', feedback: null,
};
const expense: UnusualExpense = {
  id: 101, description: 'Bulk stock purchase', amount: 3500, date: '2026-08-20', categoryId: 10,
  categoryName: 'Stock', zScore: 3, categoryMean: 1000, categoryStdDev: 500,
};

const navigation = { goBack: vi.fn(), navigate: vi.fn() };

function renderScreen(params: { finding?: AnomalyFinding; expense?: UnusualExpense }) {
  return render(
    <ThemeProvider initialMode="light">
      <FindingDetailScreen {...({ navigation, route: { key: 'FindingDetail', name: 'FindingDetail', params } } as any)} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  apiPatch.mockReset().mockResolvedValue(undefined);
  prepareQuestion.mockReset();
  navigation.goBack.mockReset();
  takeFlash();
});
afterEach(cleanup);

describe('FindingDetailScreen', () => {
  it('explains why it was flagged and what each answer does, with no evidence toggle', async () => {
    const q = await renderScreen({ finding, expense });
    expect(q.getByText('Why this was flagged')).toBeTruthy();
    for (const reason of finding.reasons) expect(q.getByText(`• ${reason}`)).toBeTruthy();
    expect(q.getByText('Finding #77 · Record #101')).toBeTruthy();
    expect(q.getByText('3.5× the category average')).toBeTruthy();
    expect(q.getAllByText('PHP 3,500.00').length).toBeGreaterThan(0);
    expect(q.getAllByText('PHP 1,000.00').length).toBeGreaterThan(0);
    expect(q.getByText('What each choice does')).toBeTruthy();
    expect(q.getByText(/The two are different purchases/)).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Evidence for Possible duplicate purchase' })).toBeNull();
  });

  it.each([
    ['Yes — this was unusual', 'CONFIRMED_UNUSUAL', 'CONFIRMED'],
    ['This is normal for my business', 'EXPECTED_TRANSACTION', 'DISMISSED'],
    ['It is a duplicate', 'DUPLICATE', 'CONFIRMED'],
    ['Wrong match — these are different', 'INCORRECT_MATCH', 'DISMISSED'],
    ['No longer relevant', 'NO_LONGER_RELEVANT', 'RESOLVED'],
  ])('keeps the answer "%s" reachable, sends it scoped to the business, and goes back', async (label, feedback, status) => {
    const q = await renderScreen({ finding });
    await fireEvent.press(q.getByRole('button', { name: 'Other answers for Possible duplicate purchase' }));
    await q.findByRole('header', { name: 'What was this, really?' });
    const options = q.getAllByRole('button', { name: label });
    await fireEvent.press(options[options.length - 1]!);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledExactlyOnceWith(
      '/insights/findings/77/review', { status, feedback },
      { cacheScope: { businessProfileId: fixtures.businessProfile.id } },
    ));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(takeFlash()).toBeTruthy();
  });

  it('stays on the page and names the failure when the answer is not saved', async () => {
    apiPatch.mockRejectedValue(new Error('Could not save that answer.'));
    const q = await renderScreen({ finding });
    await fireEvent.press(q.getByRole('button', { name: 'It is a duplicate' }));
    expect(await q.findByText('Could not save that answer.')).toBeTruthy();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it('asks Fin about this exact finding', async () => {
    const q = await renderScreen({ finding });
    await fireEvent.press(q.getByRole('button', { name: 'Explain why FinSight flagged Possible duplicate purchase' }));
    expect(prepareQuestion).toHaveBeenCalledWith(expect.stringContaining('Possible duplicate purchase'), undefined, { kind: 'finding', findingId: 77 });
  });

  it('shows an unusual expense without a finding as a comparison with nothing to answer', async () => {
    const q = await renderScreen({ expense });
    expect(q.getByText('Bulk stock purchase')).toBeTruthy();
    expect(q.getByText('3.5× the category average')).toBeTruthy();
    expect(q.getByText('This expense is well above what you usually spend on Stock.')).toBeTruthy();
    expect(q.queryByText('What each choice does')).toBeNull();
    expect(q.queryByRole('button', { name: /^Other answers/ })).toBeNull();
  });
});
