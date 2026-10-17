import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ACCOUNT_SCREENS = readFileSync(
  join(__dirname, '..', 'src', 'screens', 'AccountScreens.tsx'),
  'utf8',
);

describe('account session policy copy', () => {
  it('states that a password change keeps this phone signed in and revokes other devices', () => {
    expect(ACCOUNT_SCREENS).toContain(
      'You will stay signed in on this phone.',
    );
    expect(ACCOUNT_SCREENS).toContain('Other devices will need to sign in again after their current access expires.');
    expect(ACCOUNT_SCREENS).toContain(
      "Password changed. You're still signed in here. Other devices will need to sign in again after their current access expires.",
    );
    expect(ACCOUNT_SCREENS).not.toContain(
      'Changing your password signs you out on every device, including this one.',
    );
  });

  it('keeps sign-out on More while the account screens contain only account actions', () => {
    const more = readFileSync(join(__dirname, '..', 'src', 'screens', 'MoreScreen.tsx'), 'utf8');
    expect(ACCOUNT_SCREENS).not.toContain('SignOutSheet');
    expect(ACCOUNT_SCREENS).not.toContain('logoutEverywhere');
    expect(more).toContain('<SignOutSheet');
    expect(more).toContain('label="Sign out"');
    expect(more).not.toContain('label="Sign out on all devices"');
    expect(more).not.toContain('scope="all"');
  });
});
