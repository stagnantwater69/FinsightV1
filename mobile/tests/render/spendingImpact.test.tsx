import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * Rendered accessibility tests for Spending Impact (plan ticket §9.12).
 *
 * These replace disclosure with evidence for the announcements the earlier
 * phases could only assert existed in the source: that the gauge is actually
 * reachable as a progressbar carrying its value text, that the stale banner
 * appears and names which half of the scenario moved, that the first check has
 * a live region, and that the AI-unavailable path still shows the calculated
 * figures.
 *
 * Out of scope, and still device-only: VoiceOver/TalkBack focus order and
 * announcement timing on a real screen reader, gesture handling, and anything
 * to do with the camera.
 */

const apiPost = vi.fn();
const apiGet = vi.fn();

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: vi.fn(),
    delete: vi.fn(),
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
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock('../../src/context/AiChatContext', () => ({
  useAiChat: () => ({
    input: '',
    setInput: vi.fn(),
    messages: [],
    conversations: [],
    sending: false,
    error: null,
    send: vi.fn(),
    subscribe: vi.fn(),
    getState: vi.fn(),
  }),
  AiChatProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// The FAB and the chat sheet are their own surfaces; keeping them out of the
// tree means a query for "the only progressbar on screen" stays unambiguous.
vi.mock('../../src/components/AskFinSight', () => ({
  AskFinSight: () => null,
}));
vi.mock('../../src/components/AskFinSightFab', () => ({
  AskFinSightFab: () => null,
  FAB_CLEARANCE: 0,
}));

const { SpendingImpactScreen } = await import(
  '../../src/screens/SpendingImpactScreen'
);
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const navigation = { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() };

function renderScreen() {
  return render(
    <ThemeProvider initialMode="light">
      <SpendingImpactScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

/** Types an amount and presses Check, resolving with the given impact. */
async function check(
  queries: Awaited<ReturnType<typeof renderScreen>>,
  amount: string,
  impact: unknown = fixtures.highImpact,
) {
  apiGet.mockResolvedValueOnce(impact);
  await fireEvent.changeText(
    queries.getByLabelText('Planned amount, in Philippine pesos'),
    amount,
  );
  await fireEvent.press(queries.getByLabelText('Check this planned amount'));
  await waitFor(() =>
    expect(
      queries.getByRole('progressbar', {
        name: 'This purchase as a share of your available funds',
      }),
    ).toBeTruthy(),
  );
}

beforeEach(() => {
  apiPost.mockReset();
  apiGet.mockReset();
});

describe('Spending Impact — the impact gauge', () => {
  it('exposes the gauge as a progressbar that announces its value in words', async () => {
    const queries = await renderScreen();
    await check(queries, '11000');

    const gauge = queries.getByRole('progressbar', {
      name: 'This purchase as a share of your available funds',
    });

    // The value text is the only thing that carries the meaning: the numeric
    // now/min/max say "84 out of 100" and nothing about what that implies.
    expect(gauge.props.accessibilityValue.text).toBe(
      '84.0% of your available funds — high impact.',
    );
    expect(gauge.props.accessibilityValue.now).toBe(84);
    expect(gauge.props.accessibilityValue.min).toBe(0);
  });

  it('rewords the gauge announcement when the band changes', async () => {
    const queries = await renderScreen();
    await check(queries, '500', fixtures.lowImpact);

    const gauge = queries.getByRole('progressbar', {
      name: 'This purchase as a share of your available funds',
    });
    expect(gauge.props.accessibilityValue.text).toContain('3.8%');
    expect(gauge.props.accessibilityValue.text).not.toContain('high impact');
  });
});

describe('Spending Impact — the stale banner', () => {
  it('appears once the amount moves away from the one that was checked, and names the amount', async () => {
    const queries = await renderScreen();
    await check(queries, '11000');

    expect(queries.queryByText('Amount changed — check again')).toBeNull();

    await fireEvent.changeText(
      queries.getByLabelText('Planned amount, in Philippine pesos'),
      '12000',
    );

    const banner = await queries.findByRole('button', {
      name: 'Amount changed — check again. These figures describe the previous scenario.',
    });
    expect(banner).toBeTruthy();
  });

  it('does not appear while the typed amount still matches the checked one', async () => {
    const queries = await renderScreen();
    await check(queries, '11000');

    await fireEvent.changeText(
      queries.getByLabelText('Planned amount, in Philippine pesos'),
      '11000',
    );

    await waitFor(() =>
      expect(
        queries.queryByRole('button', {
          name: /These figures describe the previous scenario/,
        }),
      ).toBeNull(),
    );
  });

  it('rechecks from the banner rather than making the owner find the Check button', async () => {
    const queries = await renderScreen();
    await check(queries, '11000');

    await fireEvent.changeText(
      queries.getByLabelText('Planned amount, in Philippine pesos'),
      '12000',
    );
    const banner = await queries.findByRole('button', {
      name: 'Amount changed — check again. These figures describe the previous scenario.',
    });

    apiGet.mockResolvedValueOnce({
      ...fixtures.highImpact,
      plannedAmount: 12000,
    });
    await fireEvent.press(banner);

    await waitFor(() =>
      expect(
        queries.queryByRole('button', {
          name: /These figures describe the previous scenario/,
        }),
      ).toBeNull(),
    );
  });
});

describe('Spending Impact — the first check', () => {
  it('renders a polite live region while the very first check is in flight', async () => {
    const queries = await renderScreen();

    // Nothing on screen yet: this is the case that used to announce nothing,
    // because "Updating…" only existed inside the result card.
    expect(queries.queryByLabelText('Updating the estimate')).toBeNull();

    let resolve: (value: unknown) => void = () => {};
    apiGet.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    await fireEvent.changeText(
      queries.getByLabelText('Planned amount, in Philippine pesos'),
      '11000',
    );
    // Deliberately not awaited: the press is what puts the screen into the
    // in-flight state we want to observe, and the request behind it is still
    // pending. Awaiting here would wait for a settlement that has not happened.
    void fireEvent.press(queries.getByLabelText('Check this planned amount'));

    const live = await queries.findByLabelText('Updating the estimate');
    expect(live.props.accessibilityLiveRegion).toBe('polite');
    expect(queries.getByText('Updating…')).toBeTruthy();

    // The button reports its own busy state at the same time, so a reader
    // parked on the button is not left waiting in silence either.
    const button = queries.getByLabelText('Checking this planned amount');
    expect(button.props.accessibilityState.busy).toBe(true);

    resolve(fixtures.highImpact);
    await waitFor(() =>
      expect(queries.queryByLabelText('Updating the estimate')).toBeNull(),
    );
  });
});

describe('Spending Impact — when the AI is unreachable', () => {
  /** Types an item and asks FinSight to describe it. */
  async function askAboutItem(
    queries: Awaited<ReturnType<typeof renderScreen>>,
    response: unknown,
  ) {
    await fireEvent.changeText(
      queries.getByLabelText('What are you planning to buy? (optional)'),
      'Display fridge',
    );
    apiPost.mockResolvedValueOnce(response);
    await fireEvent.press(
      queries.getByLabelText(
        'What am I buying? Ask FinSight to describe this item.',
      ),
    );
  }

  it('keeps the calculated figures on screen and says why the written half is missing', async () => {
    const queries = await renderScreen();
    await check(queries, '11000');

    await askAboutItem(queries, { review: null, priceContext: null });

    // The explanation has to distinguish the two halves, because the figures
    // are arithmetic and stay true whether or not the model answered.
    const note = await queries.findByText(/the AI is unreachable|couldn't describe this item/);
    expect(note).toBeTruthy();
    expect(
      queries.getByText(
        /Your figures above are calculated, not written by AI, so they are unaffected/,
      ),
    ).toBeTruthy();

    // And the figures really are still there, announced exactly as before.
    const gauge = queries.getByRole('progressbar', {
      name: 'This purchase as a share of your available funds',
    });
    expect(gauge.props.accessibilityValue.text).toBe(
      '84.0% of your available funds — high impact.',
    );
  });

  it('still shows the record-derived price context, and names it as counted rather than written', async () => {
    const queries = await renderScreen();
    await check(queries, '11000');

    await askAboutItem(queries, {
      review: null,
      priceContext: fixtures.priceContext,
    });

    // The panel's whole reason for existing is that these numbers are not the
    // model's, so it has to survive the model being unavailable.
    expect(
      await queries.findByText('Counted from your own records — not written by AI'),
    ).toBeTruthy();
    expect(queries.getByText('Chest freezer')).toBeTruthy();
  });
});

describe('Spending Impact — the period control', () => {
  it('reports which comparison period is selected', async () => {
    const queries = await renderScreen();

    const thirtyDays = queries.getByRole('button', { name: 'Month' });
    expect(thirtyDays.props.accessibilityState.selected).toBe(true);

    const today = queries.getByRole('button', { name: 'Today' });
    expect(today.props.accessibilityState.selected).toBe(false);
  });

  it('moves the selected state when a different period is chosen', async () => {
    const queries = await renderScreen();

    await fireEvent.press(queries.getByRole('button', { name: 'Today' }));

    await waitFor(() => {
      expect(
        queries.getByRole('button', { name: 'Today' }).props.accessibilityState
          .selected,
      ).toBe(true);
      expect(
        queries.getByRole('button', { name: 'Month' }).props
          .accessibilityState.selected,
      ).toBe(false);
    });
  });
});
