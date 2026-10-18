import { testScreen } from './support/screen';
import React from 'react';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { BusinessProfile, RecordItem } from '../../src/lib/types';
import { ThemeProvider } from '../../src/context/ThemeContext';
import * as fixtures from './support/fixtures';

const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const goBack = vi.fn();
const flash = vi.fn();
let selected: BusinessProfile;
const refresh = vi.fn();

vi.mock('@react-navigation/native', () => ({
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
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  ApiError: class ApiError extends Error {},
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed.',
}));
vi.mock('../../src/lib/flash', () => ({ setFlash: (...args: unknown[]) => flash(...args) }));
vi.mock('../../src/components/DateField', () => ({ DateField: () => null }));

const { AddSalesScreen: TypedAddSalesScreen } = await import('../../src/screens/records/AddSalesScreen');
const AddSalesScreen = testScreen(TypedAddSalesScreen);
const { EditRecordScreen: TypedEditRecordScreen } = await import('../../src/screens/records/EditRecordScreen');
const EditRecordScreen = testScreen(TypedEditRecordScreen);
const record = {
  id: 7, type: 'sales', businessProfileId: 1, date: '2026-10-01',
  description: 'Synthetic daily sales', amount: 1234.56, source: 'Manual',
  duplicateStatus: 'Flagged', reviewStatus: 'Needs Review',
} as RecordItem;
const addTree = () => <ThemeProvider initialMode="light"><AddSalesScreen navigation={{ goBack }} /></ThemeProvider>;
const editTree = () => <ThemeProvider initialMode="light"><EditRecordScreen navigation={{ goBack }} route={{ params: { record } }} /></ThemeProvider>;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function pressHandler(node: ReturnType<Awaited<ReturnType<typeof render>>['getByRole']>): () => void {
  type Fiber = { return?: Fiber; memoizedProps?: { onPress?: () => void } };
  let fiber = (node as unknown as { unstable_fiber: Fiber }).unstable_fiber;
  while (!fiber.memoizedProps?.onPress && fiber.return) fiber = fiber.return;
  expect(fiber.memoizedProps?.onPress).toBeTypeOf('function');
  return fiber.memoizedProps!.onPress!;
}

beforeEach(() => {
  selected = { ...fixtures.businessProfile, id: 1 };
  apiPost.mockReset(); apiPatch.mockReset(); apiDelete.mockReset();
  goBack.mockReset(); flash.mockReset(); refresh.mockReset().mockResolvedValue(undefined);
  (SecureStore as unknown as { __reset: () => void }).__reset();
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('sales and record mutation safety', () => {
  it('serializes two sales submit events before React can update the loading state', async () => {
    const pending = deferred(); apiPost.mockReturnValue(pending.promise);
    const screen = await render(addTree());
    await waitFor(() => expect(screen.getByLabelText('Amount (PHP)').props.editable).toBe(true));
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '1234.56');
    const submit = pressHandler(screen.getByRole('button', { name: 'Save sales record' }));
    await act(async () => { void submit(); void submit(); });
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0]?.slice(0, 2)).toEqual(['/records/sales', expect.objectContaining({ businessProfileId: 1, amount: 1234.56 })]);
    await act(async () => { pending.resolve({ id: 91, type: 'sales', businessProfileId: 1 }); await pending.promise; });
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(flash).toHaveBeenCalledExactlyOnceWith('Sales record saved.');
  });

  it.each(['success', 'failure'])('rejects a late sales %s after switching businesses and clears the old form', async (outcome) => {
    const pending = deferred(); apiPost.mockReturnValue(pending.promise);
    const screen = await render(addTree());
    await waitFor(() => expect(screen.getByLabelText('Amount (PHP)').props.editable).toBe(true));
    await fireEvent.changeText(screen.getByLabelText('Description'), 'Private first-business sale');
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '800');
    await act(async () => { void pressHandler(screen.getByRole('button', { name: 'Save sales record' }))(); });
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const signal = apiPost.mock.calls[0]?.[2].signal as AbortSignal;
    selected = { ...selected, id: 2 };
    await screen.rerender(addTree());
    expect(signal.aborted).toBe(true);
    expect(screen.getByLabelText('Description').props.value).toBe('Daily sales');
    expect(screen.getByLabelText('Amount (PHP)').props.value).toBe('');
    await act(async () => {
      if (outcome === 'success') pending.resolve({});
      else pending.reject(new Error('Old business request failed.'));
      await pending.promise.catch(() => {});
    });
    expect(goBack).not.toHaveBeenCalled(); expect(flash).not.toHaveBeenCalled();
    expect(screen.queryByText('Old business request failed.')).toBeNull();
  });

  it('keeps rejected sales values available for correction and never retries the write automatically', async () => {
    apiPost.mockRejectedValueOnce(Object.assign(new Error('Amount is invalid'), { status: 400 })).mockResolvedValueOnce({ id: 91, type: 'sales', businessProfileId: 1 });
    const screen = await render(addTree());
    await waitFor(() => expect(screen.getByLabelText('Amount (PHP)').props.editable).toBe(true));
    await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), '550');
    await fireEvent.press(screen.getByRole('button', { name: 'Save sales record' }));
    expect(screen.getByLabelText('Amount (PHP)').props.value).toBe('550');
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1)); expect(goBack).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save sales record' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Save sales record' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2)); await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
  });

  it('allows one record mutation at a time, including review and delete actions', async () => {
    const pending = deferred(); apiPatch.mockReturnValue(pending.promise);
    const alert = vi.spyOn(Alert, 'alert');
    const screen = await render(editTree());
    const save = pressHandler(screen.getByRole('button', { name: 'Save changes' }));
    const review = pressHandler(screen.getByRole('button', { name: 'Looks right — mark reviewed' }));
    await act(async () => { void save(); void save(); void review(); });
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Delete record' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Delete record' }));
    expect(alert).not.toHaveBeenCalled(); expect(apiDelete).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({}); await pending.promise; });
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it.each(['save', 'review', 'delete'])('does not navigate from a late record %s after the selected business changes', async (action) => {
    const pending = deferred(); apiPatch.mockReturnValue(pending.promise); apiDelete.mockReturnValue(pending.promise);
    const alert = vi.spyOn(Alert, 'alert');
    const screen = await render(editTree());
    if (action === 'delete') {
      await fireEvent.press(screen.getByRole('button', { name: 'Delete record' }));
      const buttons = alert.mock.calls[0]?.[2];
      await act(async () => { void buttons?.find((button) => button.text === 'Delete')?.onPress?.(); });
    } else {
      await act(async () => { void pressHandler(screen.getByRole('button', { name: action === 'save' ? 'Save changes' : 'Looks right — mark reviewed' }))(); });
    }
    selected = { ...selected, id: 2 };
    await screen.rerender(editTree());
    expect(screen.getByText('Record unavailable')).toBeTruthy();
    expect(screen.queryByLabelText('Amount (PHP)')).toBeNull();
    await act(async () => { pending.resolve({}); await pending.promise; });
    expect(goBack).not.toHaveBeenCalled(); expect(flash).not.toHaveBeenCalled();
  });
});
