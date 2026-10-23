import { testScreen } from './support/screen';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react-native';
import * as fixtures from './support/fixtures';

/*
 * Returning to Alerts shows the list it left at once, and refreshes behind it.
 * Kept in its own file because it starts a read-cache session, which the other
 * notification tests run without.
 */

const apiGet = vi.fn();

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: vi.fn(),
  },
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
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

const alert = {
  id: 7,
  expenseRecordId: null,
  message: 'Possible duplicate expense 7',
  type: 'DUPLICATE',
  readStatus: false,
  businessProfileId: fixtures.businessProfile.id,
  dateCreated: '2026-09-15T01:00:00.000Z',
};

const { NotificationsScreen: TypedNotificationsScreen } = await import('../../src/screens/NotificationsScreen');
const NotificationsScreen = testScreen(TypedNotificationsScreen);
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { beginServerStateSession, clearServerStateCache } = await import('../../src/lib/serverStateCache');

const tree = () => (
  <ThemeProvider initialMode="light">
    <NotificationsScreen />
  </ThemeProvider>
);

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  clearServerStateCache();
});

describe('returning to Alerts', () => {
  it('shows the list it left at once, while the refresh is still on its way', async () => {
    beginServerStateSession(17);
    apiGet.mockResolvedValue([alert]);
    const first = await render(tree());
    expect(await first.findByText('Possible duplicate expense 7')).toBeTruthy();
    await first.unmount();

    // Past the 60-second freshness window, so the return visit refreshes; the
    // refresh never answers, so the alert on screen came from the saved copy.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    apiGet.mockReturnValue(new Promise(() => {}));
    const second = await render(tree());

    expect(second.getByText('Possible duplicate expense 7')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
