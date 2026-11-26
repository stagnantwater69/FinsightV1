import { testScreen } from './support/screen';
import React from 'react';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { BusinessProfile, RecordItem } from '../../src/lib/types';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { amountInputError, parseAmountInput } from '../../src/lib/money';
import * as fixtures from './support/fixtures';

/*
 * The manual record forms' Amount box and their unsaved-changes guard.
 *
 * Both came from the 2026-11-26 mobile QA pass: a bare Number() turned "1e3"
 * into a 1000 sale and called "1,250.50" not above zero, and backing out of
 * Add/Edit dropped typed edits without asking.
 */

const apiPost = vi.fn();
const apiPatch = vi.fn();
const goBack = vi.fn();
const dispatch = vi.fn();
const preventRemove = vi.fn();
let selected: BusinessProfile;
const refresh = vi.fn();

vi.mock('@react-navigation/native', () => ({
  usePreventRemove: (...args: unknown[]) => preventRemove(...args),
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ selected, categories: fixtures.categories, refresh, refreshCategories: refresh }),
}));
vi.mock('../../src/context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 17 } }) }));
vi.mock('../../src/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ origin: null }),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed.',
}));
vi.mock('../../src/lib/flash', () => ({ setFlash: vi.fn() }));
vi.mock('../../src/components/DateField', () => ({ DateField: () => null }));

const { AddSalesScreen: TypedAddSalesScreen } = await import('../../src/screens/records/AddSalesScreen');
const AddSalesScreen = testScreen(TypedAddSalesScreen);
const { EditRecordScreen: TypedEditRecordScreen } = await import('../../src/screens/records/EditRecordScreen');
const EditRecordScreen = testScreen(TypedEditRecordScreen);
const record = {
  id: 7, type: 'sales', businessProfileId: 1, date: '2026-10-01',
  description: 'Synthetic daily sales', amount: 500, source: 'Manual',
  duplicateStatus: 'Not a Duplicate', reviewStatus: 'Reviewed',
} as RecordItem;
const navigation = { goBack, dispatch };

async function openAddSales() {
  const screen = await render(<ThemeProvider initialMode="light"><AddSalesScreen navigation={navigation} /></ThemeProvider>);
  await waitFor(() => expect(screen.getByLabelText('Amount (PHP)').props.editable).toBe(true));
  return screen;
}

async function submitAddSales(amount: string) {
  const screen = await openAddSales();
  await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), amount);
  await fireEvent.press(screen.getByRole('button', { name: 'Save sales record' }));
  return screen;
}

async function openEdit() {
  const screen = await render(<ThemeProvider initialMode="light"><EditRecordScreen navigation={navigation} route={{ params: { record } }} /></ThemeProvider>);
  await waitFor(() => expect(screen.getByLabelText('Amount (PHP)').props.value).toBe('500'));
  return screen;
}

/** The guard's latest state: whether leaving is intercepted, and what runs when it is. */
function guard() {
  const [enabled, onRemove] = preventRemove.mock.lastCall as [boolean, (event: { data: { action: object } }) => void];
  return { enabled, onRemove };
}

beforeEach(() => {
  selected = { ...fixtures.businessProfile, id: 1 };
  apiPost.mockReset().mockResolvedValue({ id: 91, type: 'sales', businessProfileId: 1 });
  apiPatch.mockReset().mockResolvedValue({});
  goBack.mockReset(); dispatch.mockReset(); preventRemove.mockReset();
  refresh.mockReset().mockResolvedValue(undefined);
  (SecureStore as unknown as { __reset: () => void }).__reset();
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('parseAmountInput', () => {
  it.each([
    ['1234.56', 1234.56], [' 75 ', 75], ['0.01', 0.01], ['.5', 0.5], ['12.', 12],
    ['1,250.50', 1250.5], ['1,000,000', 1_000_000], ['-5', -5], ['0', 0],
  ])('reads %j as %d', (typed, value) => expect(parseAmountInput(typed)).toBe(value));

  it.each(['', '   ', '.', '1e3', '0x10', 'Infinity', '12,50', '1,2345', ',500', '1.2.3', '--5', 'PHP 50'])('refuses %j', (typed) => {
    expect(parseAmountInput(typed)).toBeNull();
  });

  it('separates a malformed amount from a missing or zero one', () => {
    expect(amountInputError('1e3')).toBe('Enter the amount in numbers, like 1250.50.');
    expect(amountInputError('')).toBe('Enter an amount greater than zero.');
    expect(amountInputError('0')).toBe('Enter an amount greater than zero.');
    expect(amountInputError('1,250.50')).toBeNull();
  });
});

describe('manual record amount parsing', () => {
  it.each([['1234.56', 1234.56], ['0.01', 0.01], [' 75 ', 75], ['1,250.50', 1250.5]])('sends %j as %d', async (typed, sent) => {
    await submitAddSales(typed);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ amount: sent }));
  });

  it.each(['0', '', '-5'])('refuses %j locally as not above zero', async (typed) => {
    const screen = await submitAddSales(typed);
    expect(await screen.findByText('Enter an amount greater than zero.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each(['1e3', '0x10', '12,50', '.'])('Add sales refuses the non-decimal amount %j locally', async (typed) => {
    const screen = await submitAddSales(typed);
    expect(await screen.findByText('Enter the amount in numbers, like 1250.50.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('Edit record refuses the non-decimal amount "1e3" locally', async () => {
    const screen = await openEdit();
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '1e3');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter the amount in numbers, like 1250.50.')).toBeTruthy();
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('unsaved changes on manual record forms', () => {
  it('lets an untouched Add sales form go without asking', async () => {
    await openAddSales();
    expect(guard().enabled).toBe(false);
  });

  it('asks before Add sales drops a typed amount, and leaves only on Discard', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const screen = await openAddSales();
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '800');
    expect(guard().enabled).toBe(true);
    const action = { type: 'GO_BACK' };
    await act(async () => { guard().onRemove({ data: { action } }); });
    expect(alert).toHaveBeenCalledWith('Discard changes?', 'Your unsaved changes will be lost.', expect.any(Array));
    expect(dispatch).not.toHaveBeenCalled();
    const buttons = alert.mock.lastCall?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === 'Discard changes')?.onPress?.(); });
    expect(dispatch).toHaveBeenCalledWith(action);
  });

  it('guards Edit record only once a field differs from the saved record', async () => {
    const screen = await openEdit();
    expect(guard().enabled).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '650');
    expect(guard().enabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '500');
    expect(guard().enabled).toBe(false);
  });

  it('leaves Edit record after a successful save without asking', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const screen = await openEdit();
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '650');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    const action = { type: 'GO_BACK' };
    await act(async () => { guard().onRemove({ data: { action } }); });
    expect(alert).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(action);
  });
});
