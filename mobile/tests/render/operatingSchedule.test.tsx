import React from 'react';
import { Alert } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, fireEvent, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * Rendered coverage for the operating-schedule setup screen — Recovery
 * Target Improvement Plan §7.2/§7.3/§11 Phase 2.
 *
 * Follows the same mocking shape as recoveryScenario.test.tsx: useFocusEffect
 * stands in for a mount effect since there is no NavigationContainer in this
 * harness, and api.get/put/post/delete are routed by path.
 *
 * DateField is stubbed to a plain text input keyed by label — its own
 * DateTimePicker dialog is native UI with no render-harness coverage (see
 * tests/render/README.md), and this screen's own logic (defaulting,
 * toggling, save/add/delete wiring) does not depend on how the date is
 * entered.
 */

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
let selected = fixtures.businessProfile;
let profiles = [fixtures.businessProfile];

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    put: (...args: unknown[]) => apiPut(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: vi.fn(),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles,
    selected,
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

const { ThemeProvider } = await import('../../src/context/ThemeContext');
const withTheme = (node: React.ReactNode) => <ThemeProvider initialMode="light">{node}</ThemeProvider>;

async function renderScreen(opts: { schedule?: unknown[]; overrides?: unknown[]; businessProfileId?: number } = {}) {
  const schedule = opts.schedule ?? [];
  const overrides = opts.overrides ?? [];
  apiGet.mockImplementation((path: string) => {
    if (path.endsWith('/operating-schedule')) return Promise.resolve(schedule);
    if (path.endsWith('/operating-overrides')) return Promise.resolve(overrides);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  const { OperatingScheduleScreen } = await import('../../src/screens/OperatingScheduleScreen');
  return render(withTheme(<OperatingScheduleScreen route={{ params: { businessProfileId: opts.businessProfileId } }} />));
}

beforeEach(() => {
  selected = fixtures.businessProfile;
  profiles = [fixtures.businessProfile];
  apiGet.mockReset();
  apiPut.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
  apiPut.mockResolvedValue({});
  apiPost.mockImplementation((_path: string, body: unknown) =>
    Promise.resolve({ id: 99, businessProfileId: fixtures.businessProfile.id, ...(body as object) }),
  );
  apiDelete.mockResolvedValue(undefined);
});

describe('Operating schedule business scope', () => {
  it('loads and saves the business being edited even when another business is active', async () => {
    const edited = { ...fixtures.businessProfile, id: 2, name: 'Edited synthetic business' };
    profiles = [selected, edited];
    const screen = await renderScreen({ businessProfileId: 2 });
    await screen.findByRole('checkbox', { name: 'Monday' });
    expect(apiGet.mock.calls.map(([path]) => path)).toEqual([
      '/business-profiles/2/operating-schedule', '/business-profiles/2/operating-overrides',
    ]);
    await fireEvent.press(screen.getByRole('button', { name: 'Save weekly schedule' }));
    expect(apiPut.mock.calls[0]?.[0]).toBe('/business-profiles/2/operating-schedule');
    expect(selected.id).toBe(1);
  });

  it('ignores an older business response after switching to the next business', async () => {
    let finish!: (rows: unknown[]) => void;
    const old = new Promise<unknown[]>((resolve) => { finish = resolve; });
    const next = { ...fixtures.businessProfile, id: 2, name: 'Second synthetic store' };
    profiles = [selected, next];
    apiGet.mockImplementation((path: string) => {
      if (path === '/business-profiles/1/operating-schedule') return old;
      if (path.endsWith('/operating-schedule')) return Promise.resolve(Array.from({ length: 7 }, (_, weekday) => ({ weekday: weekday + 1, isOpen: false })));
      return Promise.resolve([]);
    });
    const { OperatingScheduleScreen } = await import('../../src/screens/OperatingScheduleScreen');
    const tree = () => withTheme(<OperatingScheduleScreen />);
    const screen = await render(tree());
    selected = next;
    await screen.rerender(tree());
    expect((await screen.findByRole('checkbox', { name: 'Monday' })).props.accessibilityState.checked).toBe(false);
    await act(async () => { finish(Array.from({ length: 7 }, (_, weekday) => ({ weekday: weekday + 1, isOpen: true }))); await old; });
    expect(screen.getByRole('checkbox', { name: 'Monday' }).props.accessibilityState.checked).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Save weekly schedule' }));
    expect(apiPut.mock.calls[0]?.[0]).toBe('/business-profiles/2/operating-schedule');
  });
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OperatingScheduleScreen — weekly pattern', () => {
  it('defaults an unconfigured schedule (empty array) to all seven days pre-checked, without auto-submitting', async () => {
    const queries = await renderScreen({ schedule: [] });
    await queries.findByRole('checkbox', { name: 'Monday' });
    const checkboxes = queries.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(7);
    for (const box of checkboxes) {
      expect(box.props.accessibilityState?.checked).toBe(true);
    }
    expect(queries.getByText('7 open days · every week')).toBeTruthy();
    expect(queries.getByText('Suggested starting week · not saved yet')).toBeTruthy();
    // Pre-checked, not submitted — nothing is saved until Save is tapped.
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('renders a previously-saved schedule as the server sent it, not the all-open default', async () => {
    const saved = [
      { weekday: 1, isOpen: true },
      { weekday: 2, isOpen: true },
      { weekday: 3, isOpen: true },
      { weekday: 4, isOpen: true },
      { weekday: 5, isOpen: true },
      { weekday: 6, isOpen: true },
      { weekday: 7, isOpen: false },
    ];
    const queries = await renderScreen({ schedule: saved });
    await queries.findByRole('checkbox', { name: 'Sunday' });
    const checkboxes = queries.getAllByRole('checkbox');
    // Six open, one closed (Sunday, the last row).
    expect(checkboxes.filter((c) => c.props.accessibilityState?.checked).length).toBe(6);
    expect(checkboxes[6].props.accessibilityState?.checked).toBe(false);
    expect(queries.getByText('6 open days · every week')).toBeTruthy();
    expect(queries.queryByText('Suggested starting week · not saved yet')).toBeNull();
  });

  it('toggling a day and saving PUTs all seven entries with that day closed', async () => {
    const queries = await renderScreen({ schedule: [] });
    const sunday = await queries.findByRole('checkbox', { name: 'Sunday' });
    await fireEvent.press(sunday);
    expect(queries.getByText('6 open days · every week')).toBeTruthy();

    const saveButton = await queries.findByText('Save weekly schedule');
    await fireEvent.press(saveButton);

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [path, body] = apiPut.mock.calls[0];
    expect(path).toBe(`/business-profiles/${fixtures.businessProfile.id}/operating-schedule`);
    const entries = (body as { entries: { weekday: number; isOpen: boolean }[] }).entries;
    expect(entries).toHaveLength(7);
    expect(entries.find((e) => e.weekday === 7)?.isOpen).toBe(false);
    expect(entries.filter((e) => e.isOpen).length).toBe(6);
    expect(await queries.findByText('Saved.')).toBeTruthy();
    await fireEvent.press(queries.getByRole('checkbox', { name: 'Monday' }));
    expect(queries.queryByText('Saved.')).toBeNull();
  });

  it('keeps the edited pattern when saving fails and lets the owner retry', async () => {
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('checkbox', { name: 'Sunday' }));
    apiPut.mockRejectedValueOnce(new Error('Could not save your schedule.'));
    await fireEvent.press(queries.getByRole('button', { name: 'Save weekly schedule' }));
    expect(await queries.findByText('Could not save your schedule.')).toBeTruthy();
    expect(queries.getByRole('checkbox', { name: 'Sunday' }).props.accessibilityState.checked).toBe(false);
    expect(queries.queryByText('Saved.')).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Save weekly schedule' }));
    expect(await queries.findByText('Saved.')).toBeTruthy();
    expect(apiPut).toHaveBeenCalledTimes(2);
  });
});

describe('OperatingScheduleScreen — holiday and closure overrides', () => {
  it('fetches only the current and following business month with bounded paging', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:30:00.000Z'));
    selected = { ...fixtures.businessProfile, timezone: 'America/Los_Angeles' };
    profiles = [selected];
    const queries = await renderScreen();
    await queries.findByRole('button', { name: 'Add special date' });
    expect(apiGet).toHaveBeenCalledWith(
      `/business-profiles/${fixtures.businessProfile.id}/operating-overrides`,
      { pageSize: 50, from: '2026-10-01', to: '2026-11-30', cursor: undefined },
    );
  });

  it('lists existing overrides sorted by date', async () => {
    const queries = await renderScreen({
      overrides: [
        { id: 2, businessProfileId: fixtures.businessProfile.id, date: '2026-08-25', type: 'CLOSED', reason: 'Fiesta' },
        { id: 1, businessProfileId: fixtures.businessProfile.id, date: '2026-08-01', type: 'OPEN', reason: null },
      ],
    });
    expect(await queries.findByText('2026-08-01')).toBeTruthy();
    expect(await queries.findByText('2026-08-25')).toBeTruthy();
    expect(await queries.findByText(/Fiesta/)).toBeTruthy();
  });

  it('adds a new override via POST and shows it in the list', async () => {
    const queries = await renderScreen({ overrides: [] });
    await queries.findByRole('button', { name: 'Add special date' });
    await fireEvent.changeText(queries.getByLabelText('Special dates from'), '2026-09-01');
    await fireEvent.changeText(queries.getByLabelText('Special dates through'), '2026-09-30');
    await fireEvent.press(queries.getByRole('button', { name: 'Load date range' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      `/business-profiles/${fixtures.businessProfile.id}/operating-overrides`,
      { pageSize: 50, from: '2026-09-01', to: '2026-09-30', cursor: undefined },
    ));
    await fireEvent.press(await queries.findByRole('button', { name: 'Add special date' }));

    await fireEvent.changeText(queries.getByLabelText('Date'), '2026-09-01');
    await fireEvent.press(queries.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [path, body] = apiPost.mock.calls[0];
    expect(path).toBe(`/business-profiles/${fixtures.businessProfile.id}/operating-overrides`);
    expect(body).toMatchObject({ date: '2026-09-01', type: 'CLOSED' });
    expect(await queries.findByText('2026-09-01')).toBeTruthy();
    expect(queries.queryByRole('header', { name: 'Add special date' })).toBeNull();
  });

  it('saves a special opening with a trimmed reason and resets the successful form', async () => {
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'Add special date' }));
    expect(queries.getByRole('button', { name: 'This date is, Closed' }).props.accessibilityState.selected).toBe(true);
    expect(queries.getByRole('button', { name: 'Add' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(queries.getByLabelText('Date'), '2026-11-01');
    await fireEvent.press(queries.getByRole('button', { name: 'This date is, Open' }));
    await fireEvent.changeText(queries.getByLabelText('Reason (optional)'), '  Holiday market  ');
    await fireEvent.press(queries.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      `/business-profiles/${fixtures.businessProfile.id}/operating-overrides`,
      { date: '2026-11-01', type: 'OPEN', reason: 'Holiday market' },
    ));
    expect(queries.queryByRole('header', { name: 'Add special date' })).toBeNull();
    expect(queries.getByText('Open · Holiday market')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Add special date' }));
    expect(queries.getByLabelText('Date').props.value).toBe('');
    expect(queries.getByLabelText('Reason (optional)').props.value).toBe('');
    expect(queries.getByRole('button', { name: 'This date is, Closed' }).props.accessibilityState.selected).toBe(true);
  });

  it('retains the sheet and entered date and reason after a failed POST', async () => {
    const queries = await renderScreen();
    apiPost.mockRejectedValueOnce(new Error('Could not add this special date.'));
    await fireEvent.press(await queries.findByRole('button', { name: 'Add special date' }));
    await fireEvent.changeText(queries.getByLabelText('Date'), '2026-11-01');
    await fireEvent.changeText(queries.getByLabelText('Reason (optional)'), 'Inventory count');
    await fireEvent.press(queries.getByRole('button', { name: 'Add' }));
    expect(await queries.findByText('Could not add this special date.')).toBeTruthy();
    expect(queries.getByRole('header', { name: 'Add special date' })).toBeTruthy();
    expect(queries.getByLabelText('Date').props.value).toBe('2026-11-01');
    expect(queries.getByLabelText('Reason (optional)').props.value).toBe('Inventory count');
    expect(queries.queryByText('Closed · Inventory count')).toBeNull();
  });

  it('dismisses the special-date sheet without submitting the draft', async () => {
    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'Add special date' }));
    await fireEvent.changeText(queries.getByLabelText('Date'), '2026-11-01');
    await fireEvent.press(queries.getByRole('button', { name: 'Close special date form' }));
    expect(queries.queryByRole('header', { name: 'Add special date' })).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('keeps an existing override until the owner confirms its removal', async () => {
    const confirmation = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const queries = await renderScreen({
      overrides: [{ id: 5, businessProfileId: fixtures.businessProfile.id, date: '2026-08-25', type: 'CLOSED', reason: 'Fiesta' }],
    });
    await fireEvent.press(await queries.findByRole('button', { name: 'Remove the closure on 2026-08-25' }));
    expect(confirmation).toHaveBeenCalledWith('Remove 2026-08-25?', expect.any(String), expect.arrayContaining([
      expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
      expect.objectContaining({ text: 'Remove', style: 'destructive' }),
    ]));
    expect(apiDelete).not.toHaveBeenCalled();
    expect(queries.getByText('2026-08-25')).toBeTruthy();
  });

  it('deletes an override after the destructive confirmation', async () => {
    vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const queries = await renderScreen({
      overrides: [{ id: 5, businessProfileId: fixtures.businessProfile.id, date: '2026-08-25', type: 'CLOSED', reason: 'Fiesta' }],
    });
    await queries.findByText('2026-08-25');

    await fireEvent.press(queries.getByLabelText('Remove the closure on 2026-08-25'));

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith(
      `/business-profiles/${fixtures.businessProfile.id}/operating-overrides/5`,
    ));
    expect(queries.queryByText('2026-08-25')).toBeNull();
  });
});
