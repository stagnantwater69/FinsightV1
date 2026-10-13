import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROFILE_SCREEN = readFileSync(
  join(__dirname, '..', 'src', 'screens', 'BusinessScreens.tsx'),
  'utf8',
);

describe('account session policy copy', () => {
  it('states that a password change keeps this phone signed in and revokes other devices', () => {
    expect(PROFILE_SCREEN).toContain(
      'Changing your password keeps you signed in on this phone. Other devices must sign in again after their current access expires.',
    );
    expect(PROFILE_SCREEN).toContain(
      "Password changed. You're still signed in here. Other devices will need to sign in again after their current access expires.",
    );
    expect(PROFILE_SCREEN).not.toContain(
      'Changing your password signs you out on every device, including this one.',
    );
  });

  it('opens the account-wide variant of the shared sign-out sheet', () => {
    expect(PROFILE_SCREEN).toMatch(
      /title="Log out on all devices"[\s\S]*?onPress=\{\(\) => setSignOutEverywhereOpen\(true\)\}/,
    );
    expect(PROFILE_SCREEN).toMatch(/<SignOutSheet[\s\S]*?scope="all"/);
  });
});
