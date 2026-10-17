import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { BusinessProfile } from '../../src/lib/types';
import { ThemeProvider } from '../../src/context/ThemeContext';
import * as fixtures from './support/fixtures';

const selectProfile = vi.fn();
const archiveProfile = vi.fn();
const restoreProfile = vi.fn();
const listArchived = vi.fn();
const refresh = vi.fn();
const navigate = vi.fn();
const goBack = vi.fn();
const apiGet = vi.fn();
type UploadProps = { url: string | null; endpoint: string; label: string; onUploaded(updated: unknown): void };
let uploadProps: UploadProps | null = null;
const first: BusinessProfile = { ...fixtures.businessProfile, id: 1, name: 'First store', availableFunds: 17000, expectedMonthlyExpenses: 6400, operatingDays: 22, expenseRecordsCompleteThroughMonth: null };
const active: BusinessProfile = { ...first, id: 2, name: 'Current bakery', availableFunds: 24500, expectedMonthlyExpenses: 8100, operatingDays: 26, expenseRecordsCompleteThroughMonth: '2026-08' };
const archivedProfile: BusinessProfile = { ...first, id: 3, name: 'Archived kiosk', archivedAt: '2026-08-29T00:00:00Z', isArchived: true };
let profiles: BusinessProfile[] = [];
let selected: BusinessProfile | null = null;
let profilesLoading = false;
let profilesError: string | null = null;
let refocus: (() => void | (() => void)) | undefined;

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: (effect: () => void | (() => void)) => {
  refocus = effect;
  React.useEffect(effect, [effect]);
} }));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ profiles, selected, loading: profilesLoading, error: profilesError, selectProfile, archiveProfile, restoreProfile, listArchived, refresh }),
}));
vi.mock('../../src/context/AuthContext', () => ({ useAuth: () => ({ profile: null }) }));
vi.mock('../../src/components/PhotoUpload', () => ({ PhotoUpload: (props: UploadProps) => { uploadProps = props; return null; } }));
vi.mock('../../src/lib/api', () => ({ api: { get: (...args: unknown[]) => apiGet(...args) }, errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Could not finish.' }));
const { BusinessProfilesScreen, BusinessProfileFormScreen } = await import('../../src/screens/BusinessScreens');
const tree = () => <ThemeProvider initialMode="light"><BusinessProfilesScreen navigation={{ navigate, goBack }} /></ThemeProvider>;

beforeEach(() => {
  profiles = [first, active]; selected = active;
  profilesLoading = false; profilesError = null;
  selectProfile.mockReset(); archiveProfile.mockReset().mockResolvedValue(undefined);
  restoreProfile.mockReset().mockResolvedValue(undefined); listArchived.mockReset().mockResolvedValue([archivedProfile]);
  refresh.mockReset().mockResolvedValue(undefined); navigate.mockReset(); goBack.mockReset();
  apiGet.mockReset().mockResolvedValue(null); uploadProps = null;
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('BusinessProfileFormScreen logo upload refresh', () => {
  it('opens the operating schedule for the edited business rather than the active business', async () => {
    const screen = await render(<ThemeProvider initialMode="light"><BusinessProfileFormScreen navigation={{ navigate }} route={{ params: { profile: first } }} /></ThemeProvider>);
    await fireEvent.press(screen.getByRole('button', { name: 'Edit operating schedule' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('OperatingSchedule', { businessProfileId: first.id, from: undefined });
    expect(selected?.id).toBe(active.id);
  });
  it.each(['success', 'failure'])('refreshes businesses immediately after upload, with refresh %s', async (outcome) => {
    if (outcome === 'failure') refresh.mockRejectedValue(new Error('Could not refresh business photos.'));
    const screen = await render(<ThemeProvider initialMode="light"><BusinessProfileFormScreen navigation={{ navigate }} route={{ params: { profile: active } }} /></ThemeProvider>);
    expect(uploadProps?.endpoint).toBe('/business-profiles/2/logo');
    expect(uploadProps?.label).toBe('Business logo');
    const url = 'https://images.example/new-business-logo.png';
    await act(async () => { uploadProps!.onUploaded({ ...active, logoUrl: url }); });
    expect(refresh).toHaveBeenCalledExactlyOnceWith();
    expect(uploadProps?.url).toBe(url);
    expect(navigate).not.toHaveBeenCalled();
    if (outcome === 'failure') expect(await screen.findByText('Could not refresh business photos.')).toBeTruthy();
    else expect(screen.queryByText('Could not refresh business photos.')).toBeNull();
  });
});

describe('BusinessProfilesScreen', () => {
  it('returns through its own back control without changing the active business', async () => {
    const screen = await render(tree());
    expect(screen.getByRole('header', { name: 'Businesses' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Go back' }));
    expect(goBack).toHaveBeenCalledExactlyOnceWith();
    expect(selectProfile).not.toHaveBeenCalled();
  });

  it('uses each business photo URL for the current and other business', async () => {
    const current = { ...active, logoUrl: 'https://images.example/current-bakery.png' };
    profiles = [{ ...first, logoUrl: 'https://images.example/first-store.png' }, current]; selected = current;
    const screen = await render(tree());
    expect(screen.getByLabelText(`${current.name} business photo`).props.source).toEqual({ uri: current.logoUrl });
    expect(screen.getByLabelText(`${first.name} business photo`).props.source).toEqual({ uri: 'https://images.example/first-store.png' });
    expect(screen.getAllByText('Ionicons:storefront-outline', { includeHiddenElements: true })).toHaveLength(3);
    await fireEvent(screen.getByLabelText(`${current.name} business photo`), 'load');
    await fireEvent(screen.getByLabelText(`${first.name} business photo`), 'load');
    expect(screen.queryAllByText('Ionicons:storefront-outline', { includeHiddenElements: true })).toHaveLength(1);
  });

  it('keeps the default business icon when no photo URL is available', async () => {
    const current = { ...active, logoUrl: null };
    profiles = [{ ...first, logoUrl: '  ' }, current]; selected = current;
    const screen = await render(tree());
    expect(screen.queryByLabelText(`${current.name} business photo`)).toBeNull();
    expect(screen.queryByLabelText(`${first.name} business photo`)).toBeNull();
    expect(screen.getAllByText('Ionicons:storefront-outline', { includeHiddenElements: true })).toHaveLength(3);
  });

  it('falls back after photo failure, keeps the other photo, and retries a changed URL or business identity', async () => {
    const current = { ...active, logoUrl: 'https://images.example/current.png' };
    profiles = [{ ...first, logoUrl: 'https://images.example/other.png' }, current]; selected = current;
    const screen = await render(tree());
    await fireEvent(screen.getByLabelText(`${current.name} business photo`), 'error', { nativeEvent: { error: 'Image unavailable' } });
    expect(screen.queryByLabelText(`${current.name} business photo`)).toBeNull();
    expect(screen.getByLabelText(`${first.name} business photo`).props.source).toEqual({ uri: 'https://images.example/other.png' });
    expect(screen.getAllByText('Ionicons:storefront-outline', { includeHiddenElements: true }).length).toBeGreaterThanOrEqual(1);
    const updated = { ...current, logoUrl: 'https://images.example/current-updated.png' };
    profiles = [profiles[0]!, updated]; selected = updated;
    await screen.rerender(tree());
    expect(screen.getByLabelText(`${updated.name} business photo`).props.source).toEqual({ uri: updated.logoUrl });
    await fireEvent(screen.getByLabelText(`${updated.name} business photo`), 'error', { nativeEvent: { error: 'Image unavailable' } });
    const replacement = { ...updated, id: 4, name: 'Replacement cafe' };
    profiles = [profiles[0]!, replacement]; selected = replacement;
    await screen.rerender(tree());
    expect(screen.getByLabelText(`${replacement.name} business photo`).props.source).toEqual({ uri: replacement.logoUrl });
    expect(screen.queryByLabelText(`${updated.name} business photo`)).toBeNull();
  });

  it.each(['success', 'failure'])('keeps archived businesses hidden when an older refresh finishes with %s', async (outcome) => {
    let finish!: (rows: BusinessProfile[]) => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<BusinessProfile[]>((resolve, reject) => { finish = resolve; fail = reject; });
    listArchived.mockResolvedValueOnce([archivedProfile]).mockReturnValueOnce(pending);
    const screen = await render(tree());
    await fireEvent.press(screen.getByRole('button', { name: 'Show archived businesses' }));
    expect(await screen.findByText(archivedProfile.name)).toBeTruthy();
    await act(async () => { refocus!(); });
    expect(listArchived).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Hide archived businesses' }));
    await act(async () => {
      if (outcome === 'success') finish([archivedProfile]);
      else fail(new Error('Old archived refresh failed.'));
      await pending.catch(() => {});
    });
    expect(screen.queryByText(archivedProfile.name)).toBeNull();
    expect(screen.queryByText('Old archived refresh failed.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show archived businesses' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show archived businesses' }));
    expect(await screen.findByText(archivedProfile.name)).toBeTruthy();
  });

  it.each(['loading', 'error'])('does not offer first-business setup for an unknown profile list (%s)', async (state) => {
    profiles = []; selected = null;
    profilesLoading = state === 'loading';
    profilesError = state === 'error' ? 'Businesses could not load.' : null;
    const screen = await render(tree());
    expect(screen.queryByText("Let's set up your first business")).toBeNull();
    expect(screen.queryByText('0 businesses')).toBeNull();
    if (state === 'loading') expect(screen.getByLabelText('Loading businesses')).toBeTruthy();
    else {
      expect(screen.getByText('Businesses could not load.')).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Retry businesses' }));
      expect(refresh).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it('puts the selected business first without changing the context array and switches only the chosen business', async () => {
    const screen = await render(tree());
    const names = screen.getAllByRole('header').map((heading) => heading.props.children);
    expect(names.indexOf(active.name)).toBeLessThan(names.indexOf(first.name));
    expect(profiles.map((profile) => profile.id)).toEqual([1, 2]);
    expect(screen.queryByRole('button', { name: `Switch to ${active.name}` })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: `Switch to ${first.name}` }));
    expect(selectProfile).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('preserves actual starting details in each business sheet', async () => {
    const screen = await render(tree());
    expect(screen.queryByText('Starting funds')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: `Starting details: ${active.name}` }));
    expect(screen.getByText('Starting funds')).toBeTruthy();
    expect(screen.getByText('PHP 24,500.00')).toBeTruthy();
    expect(screen.getByText('Starting monthly estimate')).toBeTruthy();
    expect(screen.getByText('PHP 8,100.00')).toBeTruthy();
    expect(screen.getByText('Operating days / month')).toBeTruthy();
    expect(screen.getByText('26')).toBeTruthy();
    expect(screen.getByText('Expense records complete through')).toBeTruthy();
    expect(screen.getByText('August 2026')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Close business details' }));
    await fireEvent.press(screen.getByRole('button', { name: `Details for ${first.name}` }));
    expect(screen.getByText('Not confirmed')).toBeTruthy();
    expect(screen.getByText('PHP 17,000.00')).toBeTruthy();
    expect(screen.getByText('PHP 6,400.00')).toBeTruthy();
    expect(screen.getByText('22')).toBeTruthy();
  });

  it.each(['close', 'backdrop', 'native back'])('dismisses business details through %s without changing businesses', async (dismissal) => {
    const screen = await render(tree());
    await fireEvent.press(screen.getByRole('button', { name: `Details for ${first.name}` }));
    if (dismissal === 'close') await fireEvent.press(screen.getByRole('button', { name: 'Close business details' }));
    else {
      let target = screen.getByRole('header', { name: 'Starting details' });
      while (!target.props.onRequestClose && target.parent) target = target.parent;
      if (dismissal === 'backdrop') {
        type Fiber = { return?: Fiber; child?: Fiber; sibling?: Fiber; memoizedProps?: Record<string, unknown> };
        let fiber = (target as unknown as { unstable_fiber: Fiber }).unstable_fiber;
        while (fiber.return && !fiber.memoizedProps?.transparent) fiber = fiber.return;
        const nodes = [fiber];
        let dismissBackdrop: (() => void) | undefined;
        while (nodes.length) {
          const node = nodes.pop()!;
          if (node.memoizedProps?.accessible === false && typeof node.memoizedProps.onPress === 'function') { dismissBackdrop = node.memoizedProps.onPress as () => void; break; }
          if (node.sibling) nodes.push(node.sibling);
          if (node.child) nodes.push(node.child);
        }
        expect(dismissBackdrop).toBeTypeOf('function');
        await act(async () => { dismissBackdrop!(); });
      } else {
        expect(target.props.onRequestClose).toBeTypeOf('function');
        await fireEvent(target, 'requestClose');
      }
    }
    expect(screen.queryByText('Starting funds')).toBeNull();
    expect(selectProfile).not.toHaveBeenCalled();
    expect(archiveProfile).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `Details for ${first.name}` })).toBeTruthy();
  });

  it('reports a switch error without pretending another business became active', async () => {
    selectProfile.mockImplementation(() => { throw new Error('Cannot switch this business.'); });
    const screen = await render(tree());
    await fireEvent.press(screen.getByRole('button', { name: `Switch to ${first.name}` }));
    expect(await screen.findByText('Cannot switch this business.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Switch to ${active.name}` })).toBeNull();
  });

  it('opens edit with the chosen profile and add with an empty form', async () => {
    const screen = await render(tree());
    await fireEvent.press(screen.getByRole('button', { name: `Details for ${first.name}` }));
    await fireEvent.press(screen.getByRole('button', { name: `Edit ${first.name}` }));
    expect(navigate).toHaveBeenLastCalledWith('BusinessProfileForm', { profile: first });
    await fireEvent.press(screen.getByRole('button', { name: /Add another business/ }));
    expect(navigate).toHaveBeenLastCalledWith('BusinessProfileForm', {});
  });

  it('confirms archiving and keeps restore reachable after the final profile is archived', async () => {
    profiles = [first]; selected = first;
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    archiveProfile.mockImplementation(async () => { profiles = []; selected = null; });
    const screen = await render(tree());
    await fireEvent.press(screen.getByRole('button', { name: `Starting details: ${first.name}` }));
    await fireEvent.press(screen.getByRole('button', { name: `Archive ${first.name}` }));
    expect(archiveProfile).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(`Archive "${first.name}"?`, expect.stringContaining('Nothing is deleted'), expect.any(Array));
    await act(async () => { await alert.mock.calls[0]![2]!.find((button) => button.text === 'Archive')!.onPress!(); });
    expect(archiveProfile).toHaveBeenCalledExactlyOnceWith(1);
    await screen.rerender(tree());
    expect(screen.getByText("Let's set up your first business")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show archived businesses' }));
    await fireEvent.press(await screen.findByRole('button', { name: `Restore ${archivedProfile.name}` }));
    expect(restoreProfile).toHaveBeenCalledExactlyOnceWith(3);
    await waitFor(() => expect(listArchived).toHaveBeenCalledTimes(2));
    await fireEvent.press(screen.getByRole('button', { name: 'Create a business profile' }));
    expect(navigate).toHaveBeenLastCalledWith('BusinessProfileForm', {});
  });

  it.each(['list', 'restore', 'archive'])('reports a failed %s action and keeps businesses available', async (action) => {
    const screen = await render(tree());
    if (action === 'archive') {
      archiveProfile.mockRejectedValue(new Error('Archive unavailable.'));
      const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
      await fireEvent.press(screen.getByRole('button', { name: `Details for ${first.name}` }));
      await fireEvent.press(screen.getByRole('button', { name: `Archive ${first.name}` }));
      await act(async () => { await alert.mock.calls[0]![2]!.find((button) => button.text === 'Archive')!.onPress!(); });
      expect(await screen.findByText('Archive unavailable.')).toBeTruthy();
    } else {
      if (action === 'list') listArchived.mockRejectedValue(new Error('Archived businesses unavailable.'));
      else restoreProfile.mockRejectedValue(new Error('Restore unavailable.'));
      await fireEvent.press(screen.getByRole('button', { name: 'Show archived businesses' }));
      if (action === 'restore') await fireEvent.press(await screen.findByRole('button', { name: `Restore ${archivedProfile.name}` }));
      expect(await screen.findByText(action === 'list' ? 'Archived businesses unavailable.' : 'Restore unavailable.')).toBeTruthy();
      if (action === 'restore') expect(screen.getByText(archivedProfile.name)).toBeTruthy();
    }
    expect(screen.getByRole('header', { name: active.name })).toBeTruthy();
    expect(screen.getByRole('header', { name: first.name })).toBeTruthy();
  });
});
