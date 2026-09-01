import React from 'react';
import { Alert } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

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

async function renderScreen(opts: { schedule?: unknown[]; overrides?: unknown[] } = {}) {
  const schedule = opts.schedule ?? [];
  const overrides = opts.overrides ?? [];
  apiGet.mockImplementation((path: string) => {
    if (path.endsWith('/operating-schedule')) return Promise.resolve(schedule);
    if (path.endsWith('/operating-overrides')) return Promise.resolve(overrides);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  const { OperatingScheduleScreen } = await import('../../src/screens/OperatingScheduleScreen');
  return render(withTheme(<OperatingScheduleScreen />));
}

beforeEach(() => {
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

describe('OperatingScheduleScreen — weekly pattern', () => {
  it('defaults an unconfigured schedule (empty array) to all seven days pre-checked, without auto-submitting', async () => {
    const queries = await renderScreen({ schedule: [] });
    await queries.findByText('Weekly pattern');
    const checkboxes = queries.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(7);
    for (const box of checkboxes) {
      expect(box.props.accessibilityState?.checked).toBe(true);
    }
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
    await queries.findByText('Sunday');
    const checkboxes = queries.getAllByRole('checkbox');
    // Six open, one closed (Sunday, the last row).
    expect(checkboxes.filter((c) => c.props.accessibilityState?.checked).length).toBe(6);
    expect(checkboxes[6].props.accessibilityState?.checked).toBe(false);
  });

  it('toggling a day and saving PUTs all seven entries with that day closed', async () => {
    const queries = await renderScreen({ schedule: [] });
    await queries.findByText('Sunday');
    const sunday = queries.getByText('Sunday');
    await fireEvent.press(sunday);

    const saveButton = await queries.findByText('Save weekly schedule');
    await fireEvent.press(saveButton);

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [path, body] = apiPut.mock.calls[0];
    expect(path).toBe(`/business-profiles/${fixtures.businessProfile.id}/operating-schedule`);
    const entries = (body as { entries: { weekday: number; isOpen: boolean }[] }).entries;
    expect(entries).toHaveLength(7);
    expect(entries.find((e) => e.weekday === 7)?.isOpen).toBe(false);
    expect(entries.filter((e) => e.isOpen).length).toBe(6);
  });
});

describe('OperatingScheduleScreen — holiday and closure overrides', () => {
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
    await queries.findByText('Holidays and one-off closures');

    await fireEvent.changeText(queries.getByLabelText('Date'), '2026-09-01');
    await fireEvent.press(queries.getByText('Add'));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [path, body] = apiPost.mock.calls[0];
    expect(path).toBe(`/business-profiles/${fixtures.businessProfile.id}/operating-overrides`);
    expect(body).toMatchObject({ date: '2026-09-01', type: 'CLOSED' });
    expect(await queries.findByText('2026-09-01')).toBeTruthy();
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
