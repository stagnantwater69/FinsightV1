import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * Rendered coverage for the cost-behavior classification on the category
 * create form — Expense Reduction Opportunities plan §5.2/§15 Phase 5.
 *
 * Only mobile's create path is covered here (see CategoriesScreen.tsx —
 * there is no separate edit form on mobile today); it stays optional and
 * omitted entirely when the owner does not choose one, matching the
 * backend's own "omission means UNCLASSIFIED" contract.
 */

const createCategory = vi.fn();
const refreshCategories = vi.fn();
let categories = [...fixtures.categories];
let categoriesLoading = false;
let categoriesError: string | null = null;

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: fixtures.businessProfile,
    categories,
    categoriesLoading,
    categoriesError,
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories,
    createCategory,
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const navigation = { navigate: vi.fn() };

async function renderScreen() {
  const { CategoriesScreen } = await import('../../src/screens/CategoriesScreen');
  const { ThemeProvider } = await import('../../src/context/ThemeContext');
  return render(
    <ThemeProvider initialMode="light">
      <CategoriesScreen navigation={navigation} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  createCategory.mockReset();
  refreshCategories.mockReset();
  refreshCategories.mockResolvedValue(undefined);
  categories = [];
  categoriesLoading = false;
  categoriesError = null;
  createCategory.mockResolvedValue({ id: 99, businessProfileId: 1, name: 'Rent', description: null, createdAt: '2026-01-01', costBehavior: 'FIXED' });
});

describe('Category create form — cost-behavior classification', () => {
  it('offers Fixed/Variable/Mixed chips and sends nothing extra when left unset', async () => {
    const queries = await renderScreen();

    await fireEvent.press(queries.getByRole('button', { name: '+ New category' }));

    expect(queries.getByText("How this cost behaves (optional)")).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Fixed cost' })).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Variable cost' })).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Mixed cost' })).toBeTruthy();

    await fireEvent.changeText(queries.getByLabelText('Name'), 'Delivery fees');
    await fireEvent.press(queries.getByRole('button', { name: 'Save category' }));

    await waitFor(() => expect(createCategory).toHaveBeenCalledTimes(1));
    expect(createCategory).toHaveBeenCalledWith({
      name: 'Delivery fees',
      description: undefined,
      costBehavior: undefined,
    });
  });

  it('sends the chosen classification when the owner picks one', async () => {
    const queries = await renderScreen();

    await fireEvent.press(queries.getByRole('button', { name: '+ New category' }));
    await fireEvent.changeText(queries.getByLabelText('Name'), 'Rent');
    await fireEvent.press(queries.getByRole('button', { name: 'Fixed cost' }));
    await fireEvent.press(queries.getByRole('button', { name: 'Save category' }));

    await waitFor(() => expect(createCategory).toHaveBeenCalledTimes(1));
    expect(createCategory).toHaveBeenCalledWith({
      name: 'Rent',
      description: undefined,
      costBehavior: 'FIXED',
    });
  });

  it('deselects on a second tap of the same chip, back to unclassified', async () => {
    const queries = await renderScreen();

    await fireEvent.press(queries.getByRole('button', { name: '+ New category' }));
    const fixedChip = queries.getByRole('button', { name: 'Fixed cost' });
    await fireEvent.press(fixedChip);
    expect(fixedChip.props.accessibilityState?.selected).toBe(true);

    await fireEvent.press(fixedChip);
    expect(fixedChip.props.accessibilityState?.selected).toBe(false);
  });
});

describe('Category list request states', () => {
  it('shows loading separately from a genuine empty list', async () => {
    categoriesLoading = true;

    const queries = await renderScreen();

    expect(queries.getByText('Loading categories…')).toBeTruthy();
    expect(queries.queryByText('No categories yet')).toBeNull();
  });

  it('shows a recoverable load error instead of the empty state', async () => {
    categoriesError = 'Network unavailable.';

    const queries = await renderScreen();

    expect(queries.getByText("Couldn't load categories. Network unavailable.")).toBeTruthy();
    expect(queries.queryByText('No categories yet')).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Try loading again' }));
    expect(refreshCategories).toHaveBeenCalledTimes(1);
  });

  it('keeps safe stale rows visible when a refresh fails', async () => {
    categories = [fixtures.categories[0]!];
    categoriesError = 'Request timed out.';

    const queries = await renderScreen();

    expect(queries.getByText('Stock')).toBeTruthy();
    expect(
      queries.getByText("Couldn't refresh categories. The list below may be out of date. Request timed out."),
    ).toBeTruthy();
    expect(queries.queryByText('No categories yet')).toBeNull();
  });

  it('uses the empty state only after a successful empty response', async () => {
    const queries = await renderScreen();

    expect(queries.getByText('No categories yet')).toBeTruthy();
    expect(queries.queryByText('Loading categories…')).toBeNull();
    expect(queries.queryByRole('button', { name: 'Try loading again' })).toBeNull();
  });
});
