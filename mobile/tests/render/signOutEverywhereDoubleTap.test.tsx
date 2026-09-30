import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';

const logoutEverywhere = vi.fn();

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    logout: vi.fn(),
    logoutEverywhere,
    profile: null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { SignOutSheet } = await import('../../src/components/SignOutSheet');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

describe('global SignOutSheet double tap', () => {
  it('calls global logout once when confirm is pressed twice in the same frame', async () => {
    let finish: () => void = () => {};
    logoutEverywhere.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    const queries = await render(
      <ThemeProvider initialMode="light">
        <SignOutSheet visible scope="all" onClose={vi.fn()} />
      </ThemeProvider>,
    );
    const confirm = queries.getByRole('button', { name: 'Sign out everywhere' });

    const first = fireEvent.press(confirm);
    const second = fireEvent.press(confirm);

    expect(logoutEverywhere).toHaveBeenCalledTimes(1);

    finish();
    await Promise.all([first, second]);
  });
});
