import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityInfo } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as fixtures from './support/fixtures';

/**
 * "Mark all read" has to confirm itself to someone who cannot see it.
 *
 * WHY THIS FILE EXISTS. The 2026-08-02 design audit listed Alerts among the
 * screens with no success state. It half held up: the screen does confirm,
 * visually and well — the eyebrow changes to "All caught up" and the button
 * removes itself. But the confirmation IS the removal of the control the
 * reader was standing on, so there is nothing left to announce from and
 * nothing said. An owner using TalkBack pressed a button and got silence.
 *
 * A live region cannot fix an element that stops existing, so the screen
 * announces the outcome directly. This drives the press and checks the
 * announcement is made with the number of alerts it actually cleared.
 *
 * WHAT THIS IS NOT. `announceForAccessibility` reaching the platform is not
 * the same as TalkBack or VoiceOver speaking it at a useful moment, or at all
 * if the queue is busy. That needs a device.
 */

const apiGet = vi.fn();
const apiPatch = vi.fn();

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => effect(), [effect]);
  },
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [fixtures.businessProfile],
    selected: fixtures.businessProfile,
    categories: [],
    loading: false,
    error: null,
    selectProfile: vi.fn(),
    refresh: vi.fn(),
    refreshCategories: vi.fn(),
  }),
  BusinessProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const unreadAlert = (id: number) => ({
  id,
  message: `Possible duplicate expense ${id}`,
  type: 'DUPLICATE',
  readStatus: false,
  businessProfileId: fixtures.businessProfile.id,
  dateCreated: '2026-09-15T01:00:00.000Z',
});

async function renderScreen() {
  const { NotificationsScreen } = await import('../../src/screens/NotificationsScreen');
  const { ThemeProvider } = await import('../../src/context/ThemeContext');
  return render(
    <ThemeProvider initialMode="light">
      <NotificationsScreen />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPatch.mockResolvedValue(undefined);
});

describe('Alerts — marking everything read', () => {
  it('announces how many were cleared, and drops the control', async () => {
    apiGet.mockResolvedValue([unreadAlert(1), unreadAlert(2)]);
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');

    const queries = await renderScreen();
    const markAll = await queries.findByRole('button', { name: 'Mark all read' });

    await fireEvent.press(markAll);

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('2 alerts marked as read.');
    });
    expect(queries.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(queries.getByText('All caught up')).toBeTruthy();

    announce.mockRestore();
  });

  it('says nothing succeeded when the server refused, and restores the alerts', async () => {
    apiGet.mockResolvedValue([unreadAlert(1)]);
    apiPatch.mockRejectedValue(new Error('offline'));
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');

    const queries = await renderScreen();
    await fireEvent.press(await queries.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() => {
      // The button comes back because the optimistic update was rolled back —
      // a confirmation here would have been a lie.
      expect(queries.getByRole('button', { name: 'Mark all read' })).toBeTruthy();
    });
    expect(announce).not.toHaveBeenCalled();

    announce.mockRestore();
  });
});
