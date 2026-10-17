import { describe, expect, it } from 'vitest';
import { isFullscreenSubpage } from '../src/lib/subpageNavigation';

describe('mobile subpage navigation chrome', () => {
  it.each(['Profile', 'BusinessProfiles', 'Notifications', 'Settings', 'Faqs', 'Tutorials', 'Contact', 'Privacy', 'Terms'])(
    'gives %s the full viewport after opening it from More',
    (screen) => expect(isFullscreenSubpage('More', screen)).toBe(true),
  );

  it.each(['EditProfile', 'ChangePassword', 'DeleteAccount', 'BusinessProfileForm', 'OperatingSchedule', 'RecoveryNotificationPreferences'])(
    'keeps the focused %s workflow free of tab and quick-action chrome',
    (screen) => expect(isFullscreenSubpage('More', screen)).toBe(true),
  );

  it('also hides chrome when opening alerts from Home', () => {
    expect(isFullscreenSubpage('Dashboard', 'Notifications')).toBe(true);
  });

  it.each([
    ['More', 'MoreHome'], ['More', undefined], ['Dashboard', 'DashboardHome'],
    ['Dashboard', 'RecoveryNotificationPreferences'], ['Records', 'RecordsList'],
    ['Records', 'AddExpense'], ['Insights', 'Analysis'], [undefined, undefined],
  ])('retains existing chrome for %s / %s', (tab, screen) => {
    expect(isFullscreenSubpage(tab, screen)).toBe(false);
  });
});
